import { adaptLpAlerts, demo001Config, type MockLpAlert } from "@oiss/adapters/mock-lp-alerts";
import type { DayFiles } from "./load.ts";
import { readable } from "./versions.ts";
import type { AnyRecord, EvidenceData, Facing, Fixture, IncidentData, OissRecord, Point, ShelfObservationData, ShelfStatus, ShopperPathData, StoreLayoutData, TaskData, Zone, ZoneMetricData } from "./oiss.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FacingView {
  facing: Facing;
  fixture: Fixture;
  zone: string;
  level: number;
  rect: Rect;
  /** Observation times in seconds since store midnight, ascending, with the matching records. */
  times: number[];
  obs: OissRecord<ShelfObservationData>[];
  /** The same for the observations that report on-shelf availability, leaving out shelf label price checks. */
  statusTimes: number[];
  statusObs: OissRecord<ShelfObservationData>[];
}

export interface PathView {
  record: OissRecord<ShopperPathData>;
  start: number;
  end: number;
  t: number[];
  x: number[];
  y: number[];
}

export interface ZoneSeries {
  /** Interval end times, ascending. */
  end: number[];
  recs: OissRecord<ZoneMetricData>[];
}

/** One stop of the shelf-scanning robot: the bay column it photographed, and where it stood. */
export interface RobotStop extends Point {
  t: number;
  fixture: string;
}

export interface RobotRun {
  start: number;
  end: number;
  /** Indexes into robot.stops. */
  first: number;
  last: number;
}

/** One store task and every status change to it, oldest first. */
export interface TaskView {
  subject: string;
  versions: OissRecord<TaskData>[];
  /** When each version was recorded, in seconds since store midnight. */
  times: number[];
}

export interface IncidentSeries {
  /** Incident times, ascending. */
  t: number[];
  recs: OissRecord<IncidentData>[];
}

/**
 * Two sources reporting different things about the same facing: what the robot read on a pass, against
 * what a shelf camera or the shelf labels still said about that facing at that moment.
 */
export interface Disagreement {
  /** When the robot read the facing, in seconds since store midnight. */
  t: number;
  /** Index into facings. */
  facing: number;
  kind: "availability" | "misplaced_item" | "price";
  robot: OissRecord<ShelfObservationData>;
  other: OissRecord<ShelfObservationData>;
}

export interface IndexedDay {
  /** The day's records from the feeds that are on. */
  files: DayFiles;
  /** Source systems whose records are left out. */
  off: Set<string>;
  layout: StoreLayoutData;
  /** Epoch milliseconds of midnight at the store, in its own UTC offset. */
  midnightMs: number;
  offset: string;
  open: number;
  close: number;
  facings: FacingView[];
  zones: Map<string, Zone>;
  zoneArea: Map<string, number>;
  zoneSeries: Map<string, ZoneSeries>;
  maxDensity: number;
  paths: PathView[];
  items: Map<string, DayFiles["itemMaster"]["items"][number]>;
  /** Every source system and record type in the day, with full-day counts whether or not the feed is on. */
  /** Each source system and record type, with how many records it sent and in which OISS versions. */
  sources: { system: string; vendor?: string; type: string; records: number; versions: string[] }[];
  /** Where the robot and another source disagree about a facing, ascending by time. */
  disagreements: Disagreement[];
  /** Index into facings by facing id. */
  facingById: Map<string, number>;
  /** Every record of the day, in time order, with its time in seconds since store midnight. */
  stream: AnyRecord[];
  streamTimes: number[];
  byId: Map<string, AnyRecord>;
  evidence: Map<string, OissRecord<EvidenceData>>;
  /** Every Incident, ascending by time, and the same by checkout lane or station. */
  incidents: IncidentSeries;
  incidentsByFixture: Map<string, IncidentSeries>;
  /** What the loss prevention vendor sent for each Incident, found by running the adapter again. */
  vendorAlertFor: Map<string, MockLpAlert>;
  /** Store tasks, ascending by when they were raised, and the same by subject and by facing. */
  tasks: TaskView[];
  taskBySubject: Map<string, TaskView>;
  tasksByFacing: Map<string, TaskView[]>;
  /** Where the shelf-scanning robot stood for each bay column it photographed, from its ShelfObservations. */
  robot: { source: string; stops: RobotStop[]; times: number[]; runs: RobotRun[] };
  /** Out-of-stock facings, as last reported, every TIMELINE_STEP seconds from open to close. */
  timeline: { t: number; outOfStock: number; lowStock: number }[];
}

export const TIMELINE_STEP = 300;

const bbox = (pts: Point[]): Rect => {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
};

const area = (pts: Point[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};

/** The last index i with xs[i] <= v, or -1. */
export function lastAtOrBefore(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid]! <= v) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function indexDay(given: DayFiles, off: Set<string> = new Set()): IndexedDay {
  // Records of every version the demo reads, in the current version's shape (see versions.ts).
  const allFiles: DayFiles = { ...given, records: readable(given.records) };
  const full = allFiles.records;
  const on = <R extends AnyRecord>(rs: R[] | undefined): R[] => (rs ?? []).filter((r) => !off.has(r.data.provenance.system));
  const records: DayFiles["records"] = off.size
    ? { ...full, shelfObservations: on(full.shelfObservations), zoneMetrics: on(full.zoneMetrics), shopperPaths: on(full.shopperPaths), evidence: on(full.evidence), incidents: on(full.incidents), tasks: tasksOn(full, off) }
    : full;
  const files: DayFiles = off.size ? { ...allFiles, records } : allFiles;
  const layout = records.storeLayout.data;
  const offset = records.storeLayout.time.slice(19) || "Z";
  const midnightMs = Date.parse(`${files.date}T00:00:00${offset}`);
  const sec = (iso: string) => (Date.parse(iso) - midnightMs) / 1000;

  // Facing positions. A planogram gives each facing a shelf and a sequence; the demo draws every
  // fixture from above, with facings laid along its long side and its shelves as bands across it.
  const fixtures = new Map(layout.fixtures.map((f) => [f.id, f]));
  const shelves = new Map(layout.shelves.map((s) => [s.id, s]));
  const levelsOf = new Map<string, number>();
  for (const s of layout.shelves) levelsOf.set(s.fixture, Math.max(levelsOf.get(s.fixture) ?? 0, s.level + 1));
  const byShelf = new Map<string, Facing[]>();
  for (const f of layout.facings) {
    const list = byShelf.get(f.shelf) ?? [];
    list.push(f);
    byShelf.set(f.shelf, list);
  }
  const facings: FacingView[] = [];
  const facingIndex = new Map<string, FacingView>();
  for (const [shelfId, list] of byShelf) {
    const shelf = shelves.get(shelfId)!;
    const fixture = fixtures.get(shelf.fixture)!;
    const box = bbox(fixture.footprint);
    const levels = levelsOf.get(fixture.id) ?? 1;
    const along = box.w >= box.h ? "x" : "y";
    const length = along === "x" ? box.w : box.h;
    const total = list.reduce((s, f) => s + f.width, 0);
    const scale = total > length ? length / total : 1;
    let pos = 0;
    for (const f of [...list].sort((a, b) => a.sequence - b.sequence)) {
      const len = f.width * scale;
      const band = (along === "x" ? box.h : box.w) / levels;
      const rect: Rect =
        along === "x"
          ? { x: box.x + pos, y: box.y + shelf.level * band, w: len, h: band }
          : { x: box.x + shelf.level * band, y: box.y + pos, w: band, h: len };
      pos += len;
      const view: FacingView = { facing: f, fixture, zone: fixture.zone, level: shelf.level, rect, times: [], obs: [], statusTimes: [], statusObs: [] };
      facings.push(view);
      facingIndex.set(f.id, view);
    }
  }
  for (const r of records.shelfObservations) {
    const v = facingIndex.get(r.data.location.facing);
    if (!v) continue;
    v.times.push(sec(r.data.window.end));
    v.obs.push(r);
  }
  for (const v of facings) {
    const order = v.times.map((_, i) => i).sort((a, b) => v.times[a]! - v.times[b]!);
    v.times = order.map((i) => v.times[i]!);
    v.obs = order.map((i) => v.obs[i]!);
    v.obs.forEach((r, i) => {
      if (r.data.status === undefined) return;
      v.statusTimes.push(v.times[i]!);
      v.statusObs.push(r);
    });
  }

  const zones = new Map(layout.zones.map((z) => [z.id, z]));
  const zoneArea = new Map(layout.zones.map((z) => [z.id, area(z.polygon)]));
  const zoneSeries = new Map<string, ZoneSeries>();
  let maxDensity = 0;
  for (const r of records.zoneMetrics) {
    const s = zoneSeries.get(r.subject) ?? { end: [], recs: [] };
    s.end.push(sec(r.data.window.end));
    s.recs.push(r);
    zoneSeries.set(r.subject, s);
    const a = zoneArea.get(r.subject) ?? 0;
    if (a > 0) maxDensity = Math.max(maxDensity, (r.data.metrics.avgOccupancy ?? 0) / a);
  }

  const paths: PathView[] = records.shopperPaths.map((r) => {
    const pts = r.data.points;
    return { record: r, start: sec(r.data.window.start), end: sec(r.data.window.end), t: pts.map((p) => sec(p.t)), x: pts.map((p) => p.x), y: pts.map((p) => p.y) };
  });

  // Opening hours come from the people-counting windows, whether or not that feed is on.
  const starts = full.zoneMetrics.map((r) => sec(r.data.window.start));
  const ends = full.zoneMetrics.map((r) => sec(r.data.window.end));
  const open = starts.length ? Math.floor(Math.min(...starts) / 3600) * 3600 : 7 * 3600;
  const close = ends.length ? Math.ceil(Math.max(...ends) / 3600) * 3600 : 22 * 3600;

  const evidenceList = records.evidence ?? [];
  const incidentList = records.incidents ?? [];
  const incidents: IncidentSeries = { t: [], recs: [] };
  const incidentsByFixture = new Map<string, IncidentSeries>();
  for (const r of [...incidentList].sort((a, b) => sec(a.time) - sec(b.time))) {
    incidents.t.push(sec(r.time));
    incidents.recs.push(r);
    const fx = r.data.location.fixture;
    if (!fx) continue;
    const series = incidentsByFixture.get(fx) ?? { t: [], recs: [] };
    series.t.push(sec(r.time));
    series.recs.push(r);
    incidentsByFixture.set(fx, series);
  }

  // The vendor's alerts don't carry an OISS id, and an Incident doesn't carry the vendor's alert id.
  // The adapter is deterministic, so running it again on the same feed links the two.
  const vendorAlertFor = new Map<string, MockLpAlert>();
  const alerts = files.vendorFeeds?.mockLpAlerts ?? [];
  if (alerts.length && files.store === "demo-001") {
    const { incidentFor } = adaptLpAlerts(alerts, demo001Config());
    for (const a of alerts) {
      const id = incidentFor[a.alert_id];
      if (id) vendorAlertFor.set(id, a);
    }
  }
  const sourceCounts = new Map<string, IndexedDay["sources"][number]>();
  const taskList = records.tasks ?? [];
  const all: AnyRecord[] = [records.storeLayout, ...records.shelfObservations, ...records.zoneMetrics, ...records.shopperPaths, ...evidenceList, ...incidentList, ...taskList];
  const everything: AnyRecord[] = off.size ? [full.storeLayout, ...full.shelfObservations, ...full.zoneMetrics, ...full.shopperPaths, ...(full.evidence ?? []), ...(full.incidents ?? []), ...(full.tasks ?? [])] : all;
  for (const r of everything) {
    const key = `${r.data.provenance.system}|${r.type}`;
    const entry = sourceCounts.get(key) ?? { system: r.data.provenance.system, vendor: r.data.provenance.vendor, type: r.type.replace(/^oiss\./, ""), records: 0, versions: [] };
    entry.records++;
    if (!entry.versions.includes(r.oissversion)) entry.versions.push(r.oissversion);
    sourceCounts.set(key, entry);
  }

  const stream = [...all].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const streamTimes = stream.map((r) => sec(r.time));
  const facingById = new Map(facings.map((v, i) => [v.facing.id, i]));

  const timeline: IndexedDay["timeline"] = [];
  for (let t = open; t <= close; t += TIMELINE_STEP) {
    let outOfStock = 0;
    let lowStock = 0;
    for (const v of facings) {
      const i = lastAtOrBefore(v.statusTimes, t);
      if (i < 0) continue;
      const st = v.statusObs[i]!.data.status;
      if (st === "out_of_stock") outOfStock++;
      else if (st === "low_stock") lowStock++;
    }
    timeline.push({ t, outOfStock, lowStock });
  }

  const taskBySubject = new Map<string, TaskView>();
  for (const r of [...taskList].sort((a, b) => sec(a.time) - sec(b.time))) {
    const view = taskBySubject.get(r.subject) ?? { subject: r.subject, versions: [], times: [] };
    view.versions.push(r);
    view.times.push(sec(r.time));
    taskBySubject.set(r.subject, view);
  }
  const tasks = [...taskBySubject.values()];
  const tasksByFacing = new Map<string, TaskView[]>();
  for (const v of tasks) {
    const facing = v.versions[0]!.data.location.facing;
    if (!facing) continue;
    tasksByFacing.set(facing, [...(tasksByFacing.get(facing) ?? []), v]);
  }

  const robot = robotRoute(records.shelfObservations, facingIndex, zones, sec);
  const disagreements = findDisagreements(facings);

  return {
    files,
    off,
    layout,
    midnightMs,
    offset,
    open,
    close,
    facings,
    zones,
    zoneArea,
    zoneSeries,
    maxDensity,
    paths,
    items: new Map(files.itemMaster.items.map((i) => [i.gtin, i])),
    sources: [...sourceCounts.values()],
    disagreements,
    facingById,
    stream,
    streamTimes,
    byId: new Map(all.map((r) => [r.id, r])),
    evidence: new Map(evidenceList.map((r) => [r.id, r])),
    incidents,
    incidentsByFixture,
    vendorAlertFor,
    tasks,
    taskBySubject,
    tasksByFacing,
    robot,
    timeline,
  };
}

/**
 * The tasks a store would have had with some feeds off: none from the task system if it is off, and none
 * raised only on records from feeds that are off, since those records never arrived. A task keeps its
 * later status changes either way.
 */
function tasksOn(full: DayFiles["records"], off: Set<string>): OissRecord<TaskData>[] {
  const list = full.tasks ?? [];
  if (!list.length) return list;
  const systemOf = new Map<string, string>();
  for (const r of [...full.shelfObservations, ...full.zoneMetrics, ...(full.incidents ?? [])]) systemOf.set(r.id, r.data.provenance.system);
  const raisedOnOff = new Set<string>();
  for (const r of list) {
    const refs = r.data.basedOn ?? [];
    if (refs.length && refs.every((id) => off.has(systemOf.get(id) ?? ""))) raisedOnOff.add(r.subject);
  }
  return list.filter((r) => !off.has(r.data.provenance.system) && !raisedOnOff.has(r.subject));
}

export const ROBOT_SOURCE_SUFFIX = ":robot-1";
export const LABEL_SOURCE_SUFFIX = ":esl";

/**
 * At each robot read, compare it with what the shelf camera and the shelf labels last said about the same
 * facing. A camera reports only changes and the labels report only when they confirm or fail, so their last
 * report is what they still say. Only feeds that are on take part.
 */
function findDisagreements(facings: FacingView[]): Disagreement[] {
  const out: Disagreement[] = [];
  const oos = (r: OissRecord<ShelfObservationData>) => r.data.status === "out_of_stock";
  const misplaced = (r: OissRecord<ShelfObservationData>) => r.data.flags?.includes("misplaced_item") ?? false;
  facings.forEach((v, facing) => {
    let camera: OissRecord<ShelfObservationData> | undefined;
    let label: OissRecord<ShelfObservationData> | undefined;
    v.obs.forEach((r, i) => {
      if (r.data.location.camera) camera = r;
      else if (r.source.endsWith(LABEL_SOURCE_SUFFIX)) label = r;
      else if (r.source.endsWith(ROBOT_SOURCE_SUFFIX)) {
        const t = v.times[i]!;
        if (camera && camera.data.status && r.data.status && oos(camera) !== oos(r)) out.push({ t, facing, kind: "availability", robot: r, other: camera });
        if (camera && misplaced(camera) !== misplaced(r)) out.push({ t, facing, kind: "misplaced_item", robot: r, other: camera });
        const a = r.data.tagPrice;
        const b = label?.data.tagPrice;
        if (label && a && b && a.amount !== b.amount) out.push({ t, facing, kind: "price", robot: r, other: label });
      }
    });
  });
  return out.sort((a, b) => a.t - b.t || a.facing - b.facing);
}
/** A gap longer than this between two robot stops starts a new scan run. */
const RUN_GAP = 600;
/** How far from the fixture's face the robot drives, in meters. */
const ROBOT_OFFSET = 0.7;

/**
 * The robot's route, from nothing but its ShelfObservations: each run photographs one bay column at a
 * time, so every distinct record time is a stop in front of the facings it read.
 */
function robotRoute(obs: OissRecord<ShelfObservationData>[], facingIndex: Map<string, FacingView>, zones: Map<string, Zone>, sec: (iso: string) => number): IndexedDay["robot"] {
  const mine = obs.filter((r) => r.source.endsWith(ROBOT_SOURCE_SUFFIX));
  const source = mine[0]?.source ?? "";
  const byTime = new Map<string, FacingView[]>();
  for (const r of mine) {
    const v = facingIndex.get(r.data.location.facing);
    if (!v) continue;
    const list = byTime.get(r.time) ?? [];
    list.push(v);
    byTime.set(r.time, list);
  }
  const stops: RobotStop[] = [];
  for (const [time, views] of byTime) {
    const fixture = views[0]!.fixture;
    const box = bbox(fixture.footprint);
    const alongX = box.w >= box.h;
    const along = views.reduce((s, v) => s + (alongX ? v.rect.x + v.rect.w / 2 : v.rect.y + v.rect.h / 2), 0) / views.length;
    const zone = zones.get(fixture.zone);
    const zc = zone ? centroidOf(zone.polygon) : { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    // Stand on the side of the fixture that faces its zone's open floor.
    const side = alongX ? (zc.y >= box.y + box.h / 2 ? box.y + box.h + ROBOT_OFFSET : box.y - ROBOT_OFFSET) : zc.x >= box.x + box.w / 2 ? box.x + box.w + ROBOT_OFFSET : box.x - ROBOT_OFFSET;
    stops.push({ t: sec(time), fixture: fixture.id, x: alongX ? along : side, y: alongX ? side : along });
  }
  stops.sort((a, b) => a.t - b.t);
  const runs: RobotRun[] = [];
  stops.forEach((s, i) => {
    const run = runs[runs.length - 1];
    if (run && s.t - stops[i - 1]!.t <= RUN_GAP) {
      run.end = s.t;
      run.last = i;
    } else runs.push({ start: s.t, end: s.t, first: i, last: i });
  });
  return { source, stops, times: stops.map((s) => s.t), runs };
}

function centroidOf(ps: Point[]): Point {
  return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length };
}

/** A stop this close to the next one, at the same fixture, is a straight drive between them. */
const DRIVE_GAP = 60;

export interface RobotAt extends Point {
  run: RobotRun;
  /** Index of the last stop reached. */
  stop: number;
  /** The route driven so far in this run, as separate pieces where it moved between fixtures. */
  trail: Point[][];
  /** The whole run's route, for a faint preview. */
  route: Point[][];
}

function pieces(stops: RobotStop[], from: number, to: number, end?: Point): Point[][] {
  const out: Point[][] = [];
  let piece: Point[] = [];
  for (let i = from; i <= to; i++) {
    const s = stops[i]!;
    const prev = stops[i - 1];
    if (piece.length && prev && (prev.fixture !== s.fixture || s.t - prev.t > DRIVE_GAP)) {
      out.push(piece);
      piece = [];
    }
    piece.push(s);
  }
  if (end) piece.push(end);
  if (piece.length) out.push(piece);
  return out;
}

/** Where the robot is at time t, while a scan run is under way. */
export function robotAt(day: IndexedDay, t: number): RobotAt | null {
  const { stops, times, runs } = day.robot;
  const run = runs.find((r) => t >= r.start && t <= r.end + DRIVE_GAP);
  if (!run) return null;
  const i = Math.min(run.last, Math.max(run.first, lastAtOrBefore(times, t)));
  const s = stops[i]!;
  const next = stops[i + 1];
  let at: Point = s;
  if (next && i < run.last && next.fixture === s.fixture && next.t - s.t <= DRIVE_GAP) {
    const f = Math.min(1, Math.max(0, (t - s.t) / (next.t - s.t)));
    at = { x: s.x + (next.x - s.x) * f, y: s.y + (next.y - s.y) * f };
  }
  return { ...at, run, stop: i, trail: pieces(stops, run.first, i, at), route: pieces(stops, run.first, run.last) };
}

/** The task as it stood at time t, or undefined before it was raised. */
export function taskAt(v: TaskView, t: number): OissRecord<TaskData> | undefined {
  const i = lastAtOrBefore(v.times, t);
  return i < 0 ? undefined : v.versions[i];
}

/** Every task raised by time t, as it stood then, the most recently changed first. */
export function tasksAt(day: IndexedDay, t: number): { view: TaskView; latest: OissRecord<TaskData>; changed: number }[] {
  const out: { view: TaskView; latest: OissRecord<TaskData>; changed: number }[] = [];
  for (const view of day.tasks) {
    const i = lastAtOrBefore(view.times, t);
    if (i >= 0) out.push({ view, latest: view.versions[i]!, changed: view.times[i]! });
  }
  return out.sort((a, b) => b.changed - a.changed);
}

/** Incidents at or before time t. */
export function incidentsUpTo(series: IncidentSeries | undefined, t: number): OissRecord<IncidentData>[] {
  if (!series) return [];
  return series.recs.slice(0, lastAtOrBefore(series.t, t) + 1);
}

/** Each facing's latest observed status at time t, or "none" before its first observation. */
export function statusesAt(day: IndexedDay, t: number): (ShelfStatus | "none")[] {
  return day.facings.map((v) => {
    const i = lastAtOrBefore(v.statusTimes, t);
    return i < 0 ? "none" : v.statusObs[i]!.data.status!;
  });
}

/** The facing's latest observation at time t that reports on-shelf availability. */
export function latestObservation(v: FacingView, t: number): OissRecord<ShelfObservationData> | undefined {
  const i = lastAtOrBefore(v.statusTimes, t);
  return i < 0 ? undefined : v.statusObs[i];
}

/** The facing's latest observation of any kind at time t, price checks included. */
export function latestRecord(v: FacingView, t: number): OissRecord<ShelfObservationData> | undefined {
  const i = lastAtOrBefore(v.times, t);
  return i < 0 ? undefined : v.obs[i];
}

/** The zone's most recent completed interval at time t. */
export function zoneMetricAt(day: IndexedDay, zone: string, t: number): OissRecord<ZoneMetricData> | undefined {
  const s = day.zoneSeries.get(zone);
  if (!s) return undefined;
  const i = lastAtOrBefore(s.end, t);
  return i < 0 ? undefined : s.recs[i];
}

export interface ShopperDot extends Point {
  /** Index into day.paths. */
  path: number;
}

/** Shopper positions at time t, interpolated along each anonymous shopper path. */
export function shoppersAt(day: IndexedDay, t: number): ShopperDot[] {
  const out: ShopperDot[] = [];
  for (let k = 0; k < day.paths.length; k++) {
    const p = day.paths[k]!;
    if (t < p.start || t >= p.end) continue;
    const i = lastAtOrBefore(p.t, t);
    if (i < 0) continue;
    const j = Math.min(i + 1, p.t.length - 1);
    const span = p.t[j]! - p.t[i]!;
    const f = span > 0 ? (t - p.t[i]!) / span : 0;
    out.push({ path: k, x: p.x[i]! + (p.x[j]! - p.x[i]!) * f, y: p.y[i]! + (p.y[j]! - p.y[i]!) * f });
  }
  return out;
}

export function clock(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function clockOf(day: IndexedDay, iso: string): string {
  return clock((Date.parse(iso) - day.midnightMs) / 1000);
}

/** The newest records at or before time t, newest first, optionally of one type. */
export function recentRecords(day: IndexedDay, t: number, limit: number, type?: string): AnyRecord[] {
  const out: AnyRecord[] = [];
  for (let i = lastAtOrBefore(day.streamTimes, t); i >= 0 && out.length < limit; i--) {
    const r = day.stream[i]!;
    if (!type || r.type === type) out.push(r);
  }
  return out;
}

/** Records at or before time t: how many of each type have arrived so far. */
export function arrivedCount(day: IndexedDay, t: number): number {
  return lastAtOrBefore(day.streamTimes, t) + 1;
}

export function secondsOf(day: IndexedDay, iso: string): number {
  return (Date.parse(iso) - day.midnightMs) / 1000;
}

/** Whether each facing's latest observation at time t carries a flag, such as a misplaced item or a wrong shelf tag. */
export function flagsAt(day: IndexedDay, t: number): boolean[] {
  return day.facings.map((v) => {
    const i = lastAtOrBefore(v.times, t);
    return i >= 0 && (v.obs[i]!.data.flags?.length ?? 0) > 0;
  });
}

/** The store's date and seconds since its midnight, right now. */
export function storeNow(timezone: string, now = new Date()): { date: string; t: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, t: Number(get("hour")) * 3600 + Number(get("minute")) * 60 + Number(get("second")) };
}

/** The date after a store date. */
export function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** The seed for a store's live day: the same for everyone watching that store on that date. */
export function liveSeed(store: string, date: string): number {
  let h = 0x811c9dc5;
  for (const c of `${store}|${date}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 1_000_000_000;
}

export type FaultSeen =
  | { kind: "ahead" }
  | { kind: "caught"; record: OissRecord<ShelfObservationData>; at: number }
  | { kind: "cleared"; at: number }
  | { kind: "waiting" };

/**
 * Whether any record has reported an injected fault by time t: the first observation of its facing
 * after the fault began that flags it (a misplaced item or a wrong tag) or finds the shelf empty
 * (phantom inventory). A go-back an associate cleared before any scan saw it was never caught.
 */
export function faultSeen(day: IndexedDay, fault: { kind: string; facing: string; start: number; end: number | null }, t: number): FaultSeen {
  if (t < fault.start) return { kind: "ahead" };
  const index = day.facingById.get(fault.facing);
  const v = index === undefined ? undefined : day.facings[index];
  if (v) {
    for (let i = 0; i < v.times.length; i++) {
      const at = v.times[i]!;
      if (at <= fault.start) continue;
      if (at > t || (fault.end !== null && at > fault.end)) break;
      const d = v.obs[i]!.data;
      const hit = fault.kind === "phantom_inventory" ? d.status === "out_of_stock" : d.flags?.includes(fault.kind);
      if (hit) return { kind: "caught", record: v.obs[i]!, at };
    }
  }
  if (fault.end !== null && fault.end <= t) return { kind: "cleared", at: fault.end };
  return { kind: "waiting" };
}

/** Disagreements found by time t, ascending. */
export function disagreementsUpTo(day: IndexedDay, t: number): Disagreement[] {
  let n = 0;
  while (n < day.disagreements.length && day.disagreements[n]!.t <= t) n++;
  return day.disagreements.slice(0, n);
}

/** Disagreements about the same facing and the same thing, folded into one: the latest, when it began, and on how many robot passes. */
export interface DisagreementGroup {
  latest: Disagreement;
  first: number;
  passes: number;
}

/** One group per facing and kind of disagreement, the most recent first. */
export function groupDisagreements(list: Disagreement[]): DisagreementGroup[] {
  const groups = new Map<string, DisagreementGroup>();
  for (const d of list) {
    const key = `${d.facing}|${d.kind}`;
    const g = groups.get(key);
    if (g) {
      g.latest = d;
      g.passes++;
    } else groups.set(key, { latest: d, first: d.t, passes: 1 });
  }
  return [...groups.values()].sort((a, b) => b.latest.t - a.latest.t || a.latest.facing - b.latest.facing);
}
