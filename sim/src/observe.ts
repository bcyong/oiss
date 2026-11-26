/**
 * The observation layer: what each source would report about the ground
 * truth, on its own schedule and with its own errors. Every record here is
 * a valid OISS v0.1 record with provenance.synthetic set.
 *
 * Sources in the demo store (all synthetic):
 * - Demo Grocery space planning (the retailer's own system): the StoreLayout and planogram, once before opening.
 * - Vendor A, a shelf-scanning robot: every facing it can reach, every two hours from 8 AM to 8 PM.
 *   It reads shelf tag prices and flags misplaced items and price mismatches.
 * - Store shelf cameras (in-house): aisle 3 and the dairy wall every 5 minutes, reporting changes,
 *   misplaced items included. They can't read shelf tags.
 * - Vendor C, a people-counting system: ZoneMetric for every sales-floor zone every 15 minutes.
 * - Vendor C, a multi-camera tracker: anonymous ShopperPaths whose ids rotate every 15 minutes.
 * - Vendor D, electronic shelf labels: a price check each time a label confirms a price
 *   change or fails to (see esl.ts). Labels can't see the shelf, so these checks carry no status.
 *
 * Vendors A, C (counting) and D send their own formats, as Vendor B does for loss
 * prevention. Their adapters in adapters/src turn them into the OISS records here.
 *
 * Shelf images back every low-stock, out-of-stock and flagged read from the robot and the shelf cameras, as
 * Evidence records cropped to the shelf. The demo has no real frames yet, so each Evidence record
 * points to an image that does not exist, and the demo app draws a labeled placeholder instead.
 */
import type { ShelfFault } from "./faults.ts";
import type { Ground, TrackPoint } from "./model.ts";
import { inPolygon, round } from "./geometry.ts";
import { byTime, idMaker, type OissRecord, type Provenance, record } from "./records.ts";
import { Rng } from "./rng.ts";
import type { LayoutData } from "../../adapters/src/common.ts";
import { adaptEslEvents, demo001EslConfig } from "../../adapters/src/mock-esl.ts";
import { eslEvents, type MockEslEvent } from "./esl.ts";
import { adaptTraffic, DEMO_001_TRAFFIC_ZONES, demo001TrafficConfig, type MockTrafficRow } from "../../adapters/src/mock-traffic-csv.ts";
import { adaptShelfScans, DEMO_001_SECTIONS, demo001ShelfScanConfig, type MockShelfCapture, type MockShelfRead, type MockShelfScanMission } from "../../adapters/src/mock-shelf-scan.ts";
import { hours, storeClock } from "./time.ts";

export interface ObservedDay {
  storeLayout: OissRecord;
  shelfObservations: OissRecord[];
  zoneMetrics: OissRecord[];
  shopperPaths: OissRecord[];
  evidence: OissRecord[];
  /** The robot's missions in Vendor A's own format, before the adapter. */
  shelfScanMissions: MockShelfScanMission[];
  /** The people-counting vendor's CSV rows, before the adapter. */
  trafficRows: MockTrafficRow[];
  /** The shelf label system's reports, before the adapter. */
  eslEvents: MockEslEvent[];
}

/** How long shelf images are kept, and who may view them. */
const EVIDENCE_RETENTION_DAYS = 30;
const EVIDENCE_ROLES = ["store_manager", "department_manager"];

const MODEL = { name: "store-sim", version: "0.1.0" };

const PROV = {
  planning: { system: "Demo Grocery space planning", synthetic: true },
  shelfCams: { system: "Store shelf cameras (in-house)", model: { name: "shelf-vision", version: "0.3" }, synthetic: true },
  counting: { system: "Mock people-counting system", vendor: "Vendor C", model: { name: "people-counter", version: "0.2" }, synthetic: true },
  tracker: { system: "Mock multi-camera tracker", vendor: "Vendor C", model: { name: "mtmc-tracker", version: "0.2" }, synthetic: true },
} satisfies Record<string, Provenance>;

/** Scan runs every two hours from 8 AM; each takes about 46 minutes. */
export const ROBOT_RUNS = [8, 10, 12, 14, 16, 18, 20].map((h) => hours(h));
const ROBOT_SECONDS_PER_POSITION = 12;
const SHELF_CAM_INTERVAL = 300;
const METRIC_WINDOW = 900;
const PATH_ROTATION = 900;
const OCCUPANCY_TICK = 10;

const usd = (amount: number) => ({ amount, currency: "USD" });

type Status = "in_stock" | "low_stock" | "out_of_stock" | "unknown";

/** What a source saw beyond fill level: an item that doesn't belong, and the shelf tag price. */
interface Findings {
  observedGtin?: string;
  flags: string[];
  tagPrice?: number;
}

/** How likely each source is to spot a misplaced item on one look. */
const SPOT_MISPLACED = { robot: 0.9, shelfCams: 0.85 };

const VENDOR_STATE = { in_stock: "OK", low_stock: "LOW", out_of_stock: "OOS", unknown: "NOREAD" } as const;

function statusOf(fill: number): Status {
  if (fill <= 0.025) return "out_of_stock";
  if (fill < 0.25) return "low_stock";
  return "in_stock";
}

/** What a shelf detector reads: the fill level with noise, rounded to 5%. */
function readFill(units: number, capacity: number, sd: number, rng: Rng): number {
  if (units === 0) return rng.chance(0.96) ? 0 : 0.05;
  const fill = Math.min(1, Math.max(0, units / capacity + rng.normal(0, sd)));
  return Math.round(fill * 20) / 20;
}

/**
 * shelvesOnly: report only the StoreLayout and the shelf reads (robot, shelf cameras and labels), which
 * is all the store's task system needs to raise shelf work. runDay uses it while it works out what the
 * associates did.
 */
export function observeDay(g: Ground, opts: { shelvesOnly?: boolean } = {}): ObservedDay {
  const rng = new Rng(g.config.seed).fork("observe");
  const { layout, catalog, clock } = g;
  const store = layout.store.id;
  const date = g.config.date;
  const slotById = new Map(layout.slots.map((s) => [s.id, s]));
  const fixtureById = new Map(layout.fixtures.map((f) => [f.id, f]));
  const itemPrice = (gtin: string) => catalog.byGtin.get(gtin)!.price;

  // ---- StoreLayout ----
  const storeLayout = record("StoreLayout", {
    id: `layout-${store}-${layout.planogramVersion}`,
    source: `urn:oiss:${store}:space-planning`,
    time: clock.iso(hours(6)),
    subject: store,
    store,
    privacy: "operational",
    data: {
      provenance: PROV.planning,
      store: {
        id: store,
        storeNumber: layout.store.storeNumber,
        banner: layout.store.banner,
        name: layout.store.name,
        timezone: layout.store.timezone,
        floor: { width: layout.store.width, depth: layout.store.depth, units: "m" },
      },
      planogramVersion: layout.planogramVersion,
      zones: layout.zones.map((z) => ({ id: z.id, name: z.name, kind: z.kind, polygon: z.polygon.map((p) => ({ x: round(p.x), y: round(p.y) })) })),
      fixtures: layout.fixtures.map((f) => ({ id: f.id, zone: f.zone, kind: f.kind, footprint: f.footprint.map((p) => ({ x: round(p.x), y: round(p.y) })) })),
      shelves: layout.shelves.map((s) => ({ id: s.id, fixture: s.fixture, level: s.level, height: s.height })),
      facings: catalog.planogram.map((p) => {
        const slot = slotById.get(p.facing)!;
        return { id: p.facing, shelf: slot.shelf, sequence: slot.sequence, width: slot.width, gtin: p.gtin, facings: p.facings, capacity: p.capacity, shelfPrice: usd(itemPrice(p.gtin)) };
      }),
      cameras: layout.cameras.map((c) => ({ id: c.id, position: c.position, yaw: c.yaw, pitch: c.pitch, hfov: c.hfov, vfov: c.vfov, range: c.range, covers: c.covers })),
    },
  });

  // ---- ShelfObservation: the robot ----
  const shelfObservations: OissRecord[] = [];
  const evidence: OissRecord[] = [];
  const soId = idMaker("so", date);
  const evId = idMaker("ev", date);
  const retainUntil = retentionDate(date, clock.timezone, EVIDENCE_RETENTION_DAYS);
  const robotRng = rng.fork("robot");
  const location = (facing: string, camera?: string) => {
    const slot = slotById.get(facing)!;
    const fixture = fixtureById.get(slot.fixture)!;
    return { zone: fixture.zone, fixture: fixture.id, shelf: slot.shelf, facing, ...(camera ? { camera } : {}) };
  };
  const shelfRecord = (facing: string, t: number, windowSeconds: number, read: { status: Status; fill?: number; confidence: number }, source: string, provenance: Provenance, camera?: string, withPrice = false, found: Findings = { flags: [] }) => {
    const pos = catalog.byFacing.get(facing)!;
    const seen = read.status !== "unknown" && read.status !== "out_of_stock";
    const price = itemPrice(pos.gtin);
    const window = { start: clock.iso(t - windowSeconds), end: clock.iso(t) };
    const observedGtin = found.observedGtin ?? (seen ? pos.gtin : undefined);
    // A shelf image backs every low-stock, out-of-stock and flagged read.
    const refs: string[] = [];
    if (read.status === "low_stock" || read.status === "out_of_stock" || found.flags.length > 0) {
      const id = evId();
      refs.push(id);
      evidence.push(
        record("Evidence", {
          id,
          source: source.replace(/:[^:]+$/, ":evidence"),
          time: clock.iso(t),
          subject: id,
          store,
          privacy: "restricted",
          data: {
            provenance,
            window,
            location: location(facing, camera),
            mediaType: "image/jpeg",
            uri: `evidence/${date}/${id}.jpg`,
            redaction: "cropped_to_shelf",
            retainUntil,
            accessRoles: EVIDENCE_ROLES,
          },
        }),
      );
    }
    return record("ShelfObservation", {
      id: soId(),
      source,
      time: clock.iso(t),
      subject: facing,
      store,
      privacy: "operational",
      data: {
        provenance,
        window,
        location: location(facing, camera),
        status: read.status,
        ...(found.flags.length ? { flags: found.flags } : {}),
        ...(observedGtin ? { observedGtin } : {}),
        planogramGtin: pos.gtin,
        ...(read.fill !== undefined ? { fillLevel: read.fill } : {}),
        ...(withPrice && read.status !== "unknown" ? { tagPrice: usd(found.tagPrice ?? price), systemPrice: usd(price) } : {}),
        confidence: read.confidence,
        ...(refs.length ? { evidence: refs } : {}),
      },
    });
  };

  // The robot drives fixture by fixture and photographs one bay column (every shelf level at one position) at a time.
  const robotPositions: { fixture: string; sequence: number; facings: string[] }[] = [];
  for (const f of layout.fixtures) {
    if (!f.levels || !f.slots || f.kind === "service_counter") continue;
    for (let seq = 1; seq <= f.slots; seq++) {
      const facings = layout.slots.filter((s) => s.fixture === f.id && s.sequence === seq).map((s) => s.id);
      robotPositions.push({ fixture: f.id, sequence: seq, facings });
    }
  }
  // Fault draws use their own streams, so a fault changes nothing else the sources report. Each look at
  // a facing gets its own draws, so what happens on one facing (a fault, a fill an associate did for a
  // store task) changes nothing reported about another.
  const robotFaultRng = rng.fork("robot-faults");
  const robotFindings = (faults: ShelfFault[], look: Rng): Findings => {
    const found: Findings = { flags: [] };
    for (const f of faults) {
      if (f.kind === "misplaced_item" && look.chance(SPOT_MISPLACED.robot)) {
        found.observedGtin = f.gtin;
        found.flags.push("misplaced_item");
      } else if (f.kind === "price_mismatch") {
        found.tagPrice = f.tagPrice;
        found.flags.push("price_mismatch");
      }
    }
    return found;
  };
  // The robot reports in Vendor A's own format; the mock-shelf-scan adapter turns that into OISS records.
  const sectionOf = new Map(Object.entries(DEMO_001_SECTIONS).map(([code, fixture]) => [fixture, code]));
  const ean = (gtin: string) => gtin.slice(1);
  const vendorTime = (t: number) => new Date(clock.epochMs(t)).toISOString();
  const missions: MockShelfScanMission[] = [];
  for (const start of ROBOT_RUNS) {
    const missionId = `MVA-${date.replaceAll("-", "")}-${String(start / 3600).padStart(2, "0")}00`;
    const captures: MockShelfCapture[] = [];
    robotPositions.forEach((pos, i) => {
      const t = start + i * ROBOT_SECONDS_PER_POSITION;
      const captureId = `C${String(i + 1).padStart(4, "0")}`;
      const levels = fixtureById.get(pos.fixture)!.levels!;
      const shelves: MockShelfRead[] = [];
      for (const facing of pos.facings) {
        const slot = slotById.get(facing)!;
        const plan = catalog.byFacing.get(facing)!;
        const shelf = levels - slot.level;
        const cooler = ["cooler", "freezer"].includes(fixtureById.get(pos.fixture)!.kind);
        const look = robotRng.fork(`${start}:${facing}`);
        if (look.chance(cooler ? 0.03 : 0.012)) {
          shelves.push({ shelf, state: "NOREAD", expected: ean(plan.gtin), conf: round(look.uniform(0.2, 0.4)), exceptions: [] });
          continue;
        }
        const fill = readFill(g.unitsAt(facing, t), plan.capacity, cooler ? 0.08 : 0.05, look);
        const conf = round(look.uniform(cooler ? 0.78 : 0.86, cooler ? 0.92 : 0.97));
        const found = robotFindings(g.faultsAt(facing, t), robotFaultRng.fork(`${start}:${facing}`));
        const status = statusOf(fill);
        const seen = status !== "out_of_stock";
        const detected = found.observedGtin ?? (seen ? plan.gtin : undefined);
        const price = itemPrice(plan.gtin);
        shelves.push({
          shelf,
          state: VENDOR_STATE[status],
          fill_pct: Math.round(fill * 100),
          expected: ean(plan.gtin),
          ...(detected ? { detected: ean(detected) } : {}),
          conf,
          tag_price: found.tagPrice ?? price,
          price_file: price,
          exceptions: found.flags.map((f) => (f === "misplaced_item" ? "PLUG" : "PRICE")),
          // A shelf image backs every low-stock, out-of-stock and exception read.
          ...(status !== "in_stock" || found.flags.length ? { image: `${captureId}-S${shelf}.jpg` } : {}),
        });
      }
      captures.push({ capture_id: captureId, ts: vendorTime(t), section: sectionOf.get(pos.fixture)!, position: pos.sequence, shelves });
    });
    missions.push({ mission_id: missionId, site: "DG0001", robot: "MVA-R1", started_at: vendorTime(start), ended_at: captures[captures.length - 1]!.ts, captures, mock: true });
  }
  const scans = adaptShelfScans(missions, demo001ShelfScanConfig(storeLayout.data as unknown as LayoutData));
  if (scans.rejected.length) throw new Error(`the shelf-scan adapter rejected ${scans.rejected.length} reads: ${scans.rejected[0]!.reason}`);
  shelfObservations.push(...(scans.observations as unknown as OissRecord[]));
  evidence.push(...(scans.evidence as unknown as OissRecord[]));

  // ---- ShelfObservation: in-house shelf cameras, change-based ----
  const camRng = rng.fork("shelf-cams");
  const watched: { facing: string; camera: string }[] = [];
  for (const cam of layout.cameras.filter((c) => c.shelfFixtures)) {
    for (const slot of layout.slots) {
      if (!cam.shelfFixtures!.includes(slot.fixture)) continue;
      // Each facing goes to the nearest camera watching its fixture.
      const rivals = layout.cameras.filter((c) => c.shelfFixtures?.includes(slot.fixture));
      const nearest = rivals.reduce((a, b) => (Math.abs(a.position.y - slot.center.y) <= Math.abs(b.position.y - slot.center.y) ? a : b));
      if (nearest.id === cam.id) watched.push({ facing: slot.id, camera: cam.id });
    }
  }
  const camFaultRng = rng.fork("shelf-cam-faults");
  const reported = new Map<string, string>();
  const pending = new Map<string, string>();
  for (let t = g.open; t <= g.close; t += SHELF_CAM_INTERVAL) {
    for (const { facing, camera } of watched) {
      const look = camRng.fork(`${t}:${facing}`);
      const fill = readFill(g.unitsAt(facing, t), catalog.byFacing.get(facing)!.capacity, 0.04, look);
      const status = statusOf(fill);
      const found: Findings = { flags: [] };
      const faultLook = camFaultRng.fork(`${t}:${facing}`);
      for (const f of g.faultsAt(facing, t)) {
        if (f.kind === "misplaced_item" && faultLook.chance(SPOT_MISPLACED.shelfCams)) {
          found.observedGtin = f.gtin;
          found.flags.push("misplaced_item");
        }
      }
      // What the camera reports on: the status, and any item that doesn't belong.
      const key = `${status}|${found.observedGtin ?? ""}`;
      const last = reported.get(facing);
      const first = last === undefined;
      // Report on the first look, then only when a change holds for two looks in a row.
      if (first || (key !== last && pending.get(facing) === key)) {
        reported.set(facing, key);
        pending.delete(facing);
        shelfObservations.push(shelfRecord(facing, t, 10, { status, fill, confidence: round(look.uniform(0.9, 0.98)) }, `urn:oiss:${store}:store-vision:${camera}`, PROV.shelfCams, camera, false, found));
      } else if (key !== last) {
        pending.set(facing, key);
      } else {
        pending.delete(facing);
      }
    }
  }
  // ---- ShelfObservation: electronic shelf label price checks, through the mock-esl adapter ----
  const labelEvents = eslEvents(g);
  const labels = adaptEslEvents(labelEvents, demo001EslConfig(storeLayout.data as unknown as LayoutData));
  if (labels.rejected.length) throw new Error(`the shelf label adapter rejected ${labels.rejected.length} reports: ${labels.rejected[0]!.reason}`);
  shelfObservations.push(...(labels.observations as unknown as OissRecord[]));

  // Number records in time order, so that a change late in the day never renumbers a record sent earlier.
  renumberShelfRecords(shelfObservations, evidence, date);
  if (opts.shelvesOnly) return { storeLayout, shelfObservations, zoneMetrics: [], shopperPaths: [], evidence, shelfScanMissions: missions, trafficRows: [], eslEvents: labelEvents };

  // ---- ZoneMetric ----
  const zones = layout.zones.filter((z) => z.public);
  const start = g.open;
  const stop = Math.ceil(g.end / METRIC_WINDOW) * METRIC_WINDOW;
  const ticks = Math.ceil((stop - start) / OCCUPANCY_TICK);
  const counts = zones.map(() => new Uint16Array(ticks));
  const windows = Math.ceil((stop - start) / METRIC_WINDOW);
  const entries = zones.map(() => new Uint32Array(windows));
  const present = zones.map(() => Array.from({ length: windows }, () => new Set<number>()));

  for (const track of g.tracks) {
    const inside = zones.map(() => false);
    let seg = 0;
    const first = Math.ceil((track.arrival - start) / OCCUPANCY_TICK);
    const last = Math.floor((track.exit - start) / OCCUPANCY_TICK);
    for (let k = Math.max(0, first); k <= last && k < ticks; k++) {
      const t = start + k * OCCUPANCY_TICK;
      while (seg < track.points.length - 2 && track.points[seg + 1]!.t < t) seg++;
      const p = positionAt(track.points, seg, t);
      const w = Math.floor((k * OCCUPANCY_TICK) / METRIC_WINDOW);
      zones.forEach((z, zi) => {
        const now = inPolygon(p, z.polygon);
        if (now) {
          counts[zi]![k]!++;
          present[zi]![w]!.add(track.shopper);
          if (!inside[zi]) entries[zi]![w]!++;
        }
        inside[zi] = now;
      });
    }
  }

  const zmRng = rng.fork("counting");
  const trafficCodeOf = new Map(Object.entries(DEMO_001_TRAFFIC_ZONES).map(([code, zone]) => [zone, code]));
  const trafficRows: MockTrafficRow[] = [];
  const noisy = (n: number, sd: number) => Math.max(0, n * (1 + zmRng.normal(0, sd)));
  const snapshotAt = (t: number) => {
    let s = g.frontEnd[0];
    for (const f of g.frontEnd) {
      if (f.t > t) break;
      s = f;
    }
    return s ?? { t, staffedWaiting: 0, selfWaiting: 0, openLanes: 0 };
  };
  for (let w = 0; w < windows; w++) {
    const w0 = start + w * METRIC_WINDOW;
    const w1 = w0 + METRIC_WINDOW;
    const tickFrom = (w * METRIC_WINDOW) / OCCUPANCY_TICK;
    const tickTo = Math.min(ticks, tickFrom + METRIC_WINDOW / OCCUPANCY_TICK);
    zones.forEach((z, zi) => {
      let sum = 0, peak = 0;
      for (let k = tickFrom; k < tickTo; k++) {
        const c = counts[zi]![k]!;
        sum += c;
        peak = Math.max(peak, c);
      }
      const shoppers = present[zi]![w]!.size;
      const metrics: Record<string, number> = {
        traffic: Math.round(noisy(entries[zi]![w]!, 0.04)),
        avgOccupancy: round(noisy(sum / Math.max(1, tickTo - tickFrom), 0.04), 1),
        peakOccupancy: Math.round(noisy(peak, 0.03)),
      };
      if (shoppers > 0) metrics.avgDwellSeconds = Math.round(noisy((sum * OCCUPANCY_TICK) / shoppers, 0.06));
      if (z.kind === "front_end" || z.kind === "self_checkout") {
        const staffed = z.kind === "front_end";
        const snap = snapshotAt(w1);
        const starts = g.serviceStarts.filter((s) => s.t >= w0 && s.t < w1 && s.kind === (staffed ? "staffed" : "self"));
        const queue = staffed ? snap.staffedWaiting : snap.selfWaiting;
        metrics.queueLength = Math.max(0, queue + (zmRng.chance(0.1) ? zmRng.pick([-1, 1]) : 0));
        if (starts.length) metrics.avgWaitSeconds = Math.round(noisy(starts.reduce((a, s) => a + s.waitSeconds, 0) / starts.length, 0.05));
        metrics.openLanes = staffed ? snap.openLanes : layout.selfCheckoutStations;
      }
      const cell = (k: string) => (metrics[k] === undefined ? "" : String(metrics[k]));
      trafficRows.push({
        site_id: layout.store.storeNumber,
        zone_code: trafficCodeOf.get(z.id)!,
        interval_start: clock.iso(w0).slice(0, 16).replace("T", " "),
        interval_min: String(METRIC_WINDOW / 60),
        entries: cell("traffic"),
        avg_occupancy: cell("avgOccupancy"),
        peak_occupancy: cell("peakOccupancy"),
        avg_dwell_sec: cell("avgDwellSeconds"),
        queue_length: cell("queueLength"),
        avg_wait_sec: cell("avgWaitSeconds"),
        lanes_open: cell("openLanes"),
        accuracy_pct: String(Math.round(round(zmRng.uniform(0.84, 0.93)) * 100)),
      });
    });
  }
  // Vendor C sends a CSV; the mock-traffic-csv adapter turns it into ZoneMetric records.
  const traffic = adaptTraffic(trafficRows, demo001TrafficConfig());
  if (traffic.rejected.length) throw new Error(`the traffic adapter rejected ${traffic.rejected.length} rows: ${traffic.rejected[0]!.reason}`);
  const zoneMetrics = traffic.metrics as unknown as OissRecord[];
  zoneMetrics.sort(byTime);

  // ---- ShopperPath ----
  const spId = idMaker("sp", date);
  const pathRng = rng.fork("tracker");
  const shopperPaths: OissRecord[] = [];
  const usedIds = new Set<string>();
  const newPathId = (r: Rng) => {
    let id: string;
    do id = `path-${r.hex(8)}`;
    while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  for (const track of g.tracks) {
    // Each shopper's noise has its own stream, so a change to one visit leaves every other path as it was.
    const trackRng = pathRng.fork(`shopper-${track.shopper}`);
    for (let s0 = track.arrival; s0 < track.exit; s0 += PATH_ROTATION) {
      const s1 = Math.min(track.exit, s0 + PATH_ROTATION);
      const pts = segment(track.points, s0, s1);
      const out: { t: string; x: number; y: number }[] = [];
      for (const p of pts) {
        const q = { t: clock.iso(p.t), x: round(p.x + trackRng.normal(0, 0.15)), y: round(p.y + trackRng.normal(0, 0.15)) };
        const prev = out[out.length - 1];
        if (prev && prev.t === q.t) continue;
        out.push(q);
      }
      if (out.length < 2) continue;
      const pathId = newPathId(trackRng);
      shopperPaths.push(
        record("ShopperPath", {
          id: spId(),
          source: `urn:oiss:${store}:mock-vendor-c:tracker`,
          time: out[out.length - 1]!.t,
          subject: pathId,
          store,
          privacy: "anonymous_path",
          data: {
            provenance: PROV.tracker,
            window: { start: out[0]!.t, end: out[out.length - 1]!.t },
            objectClass: "Human",
            idValidUntil: clock.iso(Math.min(s0 + PATH_ROTATION, 86_399)),
            points: out,
            confidence: round(trackRng.uniform(0.75, 0.9)),
          },
        }),
      );
    }
  }
  renumberByTime(shopperPaths, idMaker("sp", date));

  return { storeLayout, shelfObservations, zoneMetrics, shopperPaths, evidence, shelfScanMissions: missions, trafficRows, eslEvents: labelEvents };
}

/** Sort records by time, keeping the order they were made in for equal times, and give them ids in that order. */
function renumberByTime(records: OissRecord[], nextId: () => string): Map<string, string> {
  const made = new Map(records.map((r, i) => [r, i]));
  records.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : made.get(a)! - made.get(b)!));
  const renamed = new Map<string, string>();
  for (const r of records) {
    const id = nextId();
    renamed.set(r.id, id);
    r.id = id;
  }
  return renamed;
}

/** Renumber shelf observations by time, and their evidence in the order the observations cite it. */
function renumberShelfRecords(observations: OissRecord[], evidence: OissRecord[], date: string): void {
  renumberByTime(observations, idMaker("so", date));
  const evId = idMaker("ev", date);
  const renamed = new Map<string, string>();
  for (const r of observations) {
    const data = r.data as { evidence?: string[] };
    if (data.evidence) data.evidence = data.evidence.map((old) => {
      const id = evId();
      renamed.set(old, id);
      return id;
    });
  }
  for (const e of evidence) {
    const id = renamed.get(e.id);
    if (!id) throw new Error(`evidence ${e.id} backs no observation`);
    e.id = id;
    e.subject = id;
    const data = e.data as { uri: string };
    // In-house shelf images are named by record id; a vendor's images keep the vendor's own names.
    if (data.uri.startsWith("evidence/")) data.uri = `evidence/${date}/${id}.jpg`;
  }
  evidence.sort(byTime);
}

/** Midnight at the store a number of days after the store date, with the offset in force on that date. */
function retentionDate(date: string, timezone: string, days: number): string {
  const later = new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  return storeClock(later, timezone).iso(0);
}

function positionAt(points: TrackPoint[], seg: number, t: number): { x: number; y: number } {
  const a = points[seg]!;
  const b = points[Math.min(seg + 1, points.length - 1)]!;
  if (t <= a.t || b.t <= a.t) return a;
  if (t >= b.t) return b;
  const f = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** The part of a track between s0 and s1, with interpolated end points. */
function segment(points: TrackPoint[], s0: number, s1: number): TrackPoint[] {
  const at = (t: number): TrackPoint => {
    let seg = 0;
    while (seg < points.length - 2 && points[seg + 1]!.t < t) seg++;
    return { t, ...positionAt(points, seg, t) };
  };
  return [at(s0), ...points.filter((p) => p.t > s0 && p.t < s1), at(s1)];
}
