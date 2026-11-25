import type { DayFiles } from "./load.ts";
import type { Facing, Fixture, OissRecord, Point, ShelfObservationData, ShelfStatus, StoreLayoutData, Zone, ZoneMetricData } from "./oiss.ts";

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
}

export interface PathView {
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

export interface IndexedDay {
  files: DayFiles;
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
  sources: { system: string; vendor?: string; type: string; records: number }[];
}

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

export function indexDay(files: DayFiles): IndexedDay {
  const { records } = files;
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
      const view: FacingView = { facing: f, fixture, zone: fixture.zone, level: shelf.level, rect, times: [], obs: [] };
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
    return { start: sec(r.data.window.start), end: sec(r.data.window.end), t: pts.map((p) => sec(p.t)), x: pts.map((p) => p.x), y: pts.map((p) => p.y) };
  });

  const starts = records.zoneMetrics.map((r) => sec(r.data.window.start));
  const ends = records.zoneMetrics.map((r) => sec(r.data.window.end));
  const open = starts.length ? Math.floor(Math.min(...starts) / 3600) * 3600 : 7 * 3600;
  const close = ends.length ? Math.ceil(Math.max(...ends) / 3600) * 3600 : 22 * 3600;

  const sourceCounts = new Map<string, { system: string; vendor?: string; type: string; records: number }>();
  const all = [records.storeLayout, ...records.shelfObservations, ...records.zoneMetrics, ...records.shopperPaths] as OissRecord<{ provenance: { system: string; vendor?: string } }>[];
  for (const r of all) {
    const key = `${r.data.provenance.system}|${r.type}`;
    const entry = sourceCounts.get(key) ?? { system: r.data.provenance.system, vendor: r.data.provenance.vendor, type: r.type.replace(/^oiss\./, ""), records: 0 };
    entry.records++;
    sourceCounts.set(key, entry);
  }

  return {
    files,
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
  };
}

/** Each facing's latest observed status at time t, or "none" before its first observation. */
export function statusesAt(day: IndexedDay, t: number): (ShelfStatus | "none")[] {
  return day.facings.map((v) => {
    const i = lastAtOrBefore(v.times, t);
    return i < 0 ? "none" : v.obs[i]!.data.status;
  });
}

export function latestObservation(v: FacingView, t: number): OissRecord<ShelfObservationData> | undefined {
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

/** Shopper positions at time t, interpolated along each anonymous shopper path. */
export function shoppersAt(day: IndexedDay, t: number): Point[] {
  const out: Point[] = [];
  for (const p of day.paths) {
    if (t < p.start || t >= p.end) continue;
    const i = lastAtOrBefore(p.t, t);
    if (i < 0) continue;
    const j = Math.min(i + 1, p.t.length - 1);
    const span = p.t[j]! - p.t[i]!;
    const f = span > 0 ? (t - p.t[i]!) / span : 0;
    out.push({ x: p.x[i]! + (p.x[j]! - p.x[i]!) * f, y: p.y[i]! + (p.y[j]! - p.y[i]!) * f });
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
