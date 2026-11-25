/**
 * The observation layer: what each source would report about the ground
 * truth, on its own schedule and with its own errors. Every record here is
 * a valid OISS v0.1 record with provenance.synthetic set.
 *
 * Sources in the demo store (all synthetic):
 * - Demo Grocery space planning (the retailer's own system): the StoreLayout and planogram, once before opening.
 * - Mock vendor A, a shelf-scanning robot: every facing it can reach, twice a day.
 * - Store shelf cameras (in-house): aisle 3 and the dairy wall every 5 minutes, reporting changes.
 * - Mock vendor C, a people-counting system: ZoneMetric for every sales-floor zone every 15 minutes.
 * - Mock vendor C, a multi-camera tracker: anonymous ShopperPaths whose ids rotate every 15 minutes.
 *
 * Shelf images back every low-stock and out-of-stock read from the robot and the shelf cameras, as
 * Evidence records cropped to the shelf. The demo has no real frames yet, so each Evidence record
 * points to an image that does not exist, and the demo app draws a labeled placeholder instead.
 */
import type { Ground, TrackPoint } from "./model.ts";
import { inPolygon, round } from "./geometry.ts";
import { byTime, idMaker, type OissRecord, type Provenance, record } from "./records.ts";
import { Rng } from "./rng.ts";
import { hours, storeClock } from "./time.ts";

export interface ObservedDay {
  storeLayout: OissRecord;
  shelfObservations: OissRecord[];
  zoneMetrics: OissRecord[];
  shopperPaths: OissRecord[];
  evidence: OissRecord[];
}

/** How long shelf images are kept, and who may view them. */
const EVIDENCE_RETENTION_DAYS = 30;
const EVIDENCE_ROLES = ["store_manager", "department_manager"];

const MODEL = { name: "store-sim", version: "0.1.0" };

const PROV = {
  planning: { system: "Demo Grocery space planning", synthetic: true },
  robot: { system: "Mock shelf-scanning robot", vendor: "Mock vendor A", model: { name: "shelf-detector", version: "0.1" }, synthetic: true },
  shelfCams: { system: "Store shelf cameras (in-house)", model: { name: "shelf-vision", version: "0.3" }, synthetic: true },
  counting: { system: "Mock people-counting system", vendor: "Mock vendor C", model: { name: "people-counter", version: "0.2" }, synthetic: true },
  tracker: { system: "Mock multi-camera tracker", vendor: "Mock vendor C", model: { name: "mtmc-tracker", version: "0.2" }, synthetic: true },
} satisfies Record<string, Provenance>;

export const ROBOT_RUNS = [hours(8), hours(14)];
const ROBOT_SECONDS_PER_POSITION = 12;
const SHELF_CAM_INTERVAL = 300;
const METRIC_WINDOW = 900;
const PATH_ROTATION = 900;
const OCCUPANCY_TICK = 10;

const usd = (amount: number) => ({ amount, currency: "USD" });

type Status = "in_stock" | "low_stock" | "out_of_stock" | "unknown";

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

export function observeDay(g: Ground): ObservedDay {
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
  const shelfRecord = (facing: string, t: number, windowSeconds: number, read: { status: Status; fill?: number; confidence: number }, source: string, provenance: Provenance, camera?: string, withPrice = false) => {
    const pos = catalog.byFacing.get(facing)!;
    const seen = read.status !== "unknown" && read.status !== "out_of_stock";
    const price = itemPrice(pos.gtin);
    const window = { start: clock.iso(t - windowSeconds), end: clock.iso(t) };
    // A shelf image backs every low-stock and out-of-stock read.
    const refs: string[] = [];
    if (read.status === "low_stock" || read.status === "out_of_stock") {
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
        ...(seen ? { observedGtin: pos.gtin } : {}),
        planogramGtin: pos.gtin,
        ...(read.fill !== undefined ? { fillLevel: read.fill } : {}),
        ...(withPrice && read.status !== "unknown" ? { tagPrice: usd(price), systemPrice: usd(price) } : {}),
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
  for (const start of ROBOT_RUNS) {
    robotPositions.forEach((pos, i) => {
      const t = start + i * ROBOT_SECONDS_PER_POSITION;
      for (const facing of pos.facings) {
        const capacity = catalog.byFacing.get(facing)!.capacity;
        const cooler = ["cooler", "freezer"].includes(fixtureById.get(pos.fixture)!.kind);
        if (robotRng.chance(cooler ? 0.03 : 0.012)) {
          shelfObservations.push(shelfRecord(facing, t, 4, { status: "unknown", confidence: round(robotRng.uniform(0.2, 0.4)) }, `urn:oiss:${store}:mock-vendor-a:robot-1`, PROV.robot, undefined, true));
          continue;
        }
        const fill = readFill(g.unitsAt(facing, t), capacity, cooler ? 0.08 : 0.05, robotRng);
        const confidence = round(robotRng.uniform(cooler ? 0.78 : 0.86, cooler ? 0.92 : 0.97));
        shelfObservations.push(shelfRecord(facing, t, 4, { status: statusOf(fill), fill, confidence }, `urn:oiss:${store}:mock-vendor-a:robot-1`, PROV.robot, undefined, true));
      }
    });
  }

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
  const reported = new Map<string, Status>();
  const pending = new Map<string, Status>();
  for (let t = g.open; t <= g.close; t += SHELF_CAM_INTERVAL) {
    for (const { facing, camera } of watched) {
      const fill = readFill(g.unitsAt(facing, t), catalog.byFacing.get(facing)!.capacity, 0.04, camRng);
      const status = statusOf(fill);
      const last = reported.get(facing);
      const first = last === undefined;
      // Report on the first look, then only when a new status holds for two looks in a row.
      if (first || (status !== last && pending.get(facing) === status)) {
        reported.set(facing, status);
        pending.delete(facing);
        shelfObservations.push(shelfRecord(facing, t, 10, { status, fill, confidence: round(camRng.uniform(0.9, 0.98)) }, `urn:oiss:${store}:store-vision:${camera}`, PROV.shelfCams, camera));
      } else if (status !== last) {
        pending.set(facing, status);
      } else {
        pending.delete(facing);
      }
    }
  }
  shelfObservations.sort(byTime);
  evidence.sort(byTime);

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

  const zmId = idMaker("zm", date);
  const zmRng = rng.fork("counting");
  const zoneMetrics: OissRecord[] = [];
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
      zoneMetrics.push(
        record("ZoneMetric", {
          id: zmId(),
          source: `urn:oiss:${store}:mock-vendor-c:people-counting`,
          time: clock.iso(w1),
          subject: z.id,
          store,
          privacy: "aggregate",
          data: {
            provenance: PROV.counting,
            window: { start: clock.iso(w0), end: clock.iso(w1) },
            location: { zone: z.id },
            metrics,
            confidence: round(zmRng.uniform(0.84, 0.93)),
          },
        }),
      );
    });
  }
  zoneMetrics.sort(byTime);

  // ---- ShopperPath ----
  const spId = idMaker("sp", date);
  const pathRng = rng.fork("tracker");
  const shopperPaths: OissRecord[] = [];
  const usedIds = new Set<string>();
  const newPathId = () => {
    let id: string;
    do id = `path-${pathRng.hex(8)}`;
    while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  for (const track of g.tracks) {
    for (let s0 = track.arrival; s0 < track.exit; s0 += PATH_ROTATION) {
      const s1 = Math.min(track.exit, s0 + PATH_ROTATION);
      const pts = segment(track.points, s0, s1);
      const out: { t: string; x: number; y: number }[] = [];
      for (const p of pts) {
        const q = { t: clock.iso(p.t), x: round(p.x + pathRng.normal(0, 0.15)), y: round(p.y + pathRng.normal(0, 0.15)) };
        const prev = out[out.length - 1];
        if (prev && prev.t === q.t) continue;
        out.push(q);
      }
      if (out.length < 2) continue;
      const pathId = newPathId();
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
            confidence: round(pathRng.uniform(0.75, 0.9)),
          },
        }),
      );
    }
  }
  shopperPaths.sort(byTime);

  return { storeLayout, shelfObservations, zoneMetrics, shopperPaths, evidence };
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
