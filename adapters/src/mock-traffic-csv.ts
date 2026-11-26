/**
 * Adapter: Vendor C's people-counting CSV -> OISS ZoneMetric records.
 *
 * Vendor C is invented for the demo and labeled as mock. Its export is the kind of CSV a
 * traffic-counting vendor drops on an SFTP server every 15 minutes: the vendor's own store and
 * zone codes, interval start times in store wall-clock time with no UTC offset, blank cells for
 * metrics a zone doesn't have, and an accuracy percentage. The adapter:
 *
 * - maps the vendor's store and zone codes to the retailer's StoreLayout zones;
 * - turns each wall-clock interval into a window with the store's UTC offset, so the hour that
 *   repeats when daylight saving time ends is read as the first one, and a time that the clocks
 *   skip is rejected;
 * - writes only the metrics the vendor filled in, under OISS names;
 * - turns the accuracy percentage into a 0 to 1 confidence;
 * - rejects rows it can't read or map, with a reason, instead of guessing.
 */
import { type Envelope, envelope, idCounter, localIso, localToIso } from "./common.ts";

export const TRAFFIC_COLUMNS = ["site_id", "zone_code", "interval_start", "interval_min", "entries", "avg_occupancy", "peak_occupancy", "avg_dwell_sec", "queue_length", "avg_wait_sec", "lanes_open", "accuracy_pct"] as const;

/** One row of the CSV, as the vendor writes it. Blank cells are empty strings. */
export type MockTrafficRow = Record<(typeof TRAFFIC_COLUMNS)[number], string>;

export interface TrafficAdapterConfig {
  store: string;
  timezone: string;
  site: string;
  /** Vendor zone code -> StoreLayout zone id. */
  zones: Record<string, string>;
}

export const ADAPTER = { name: "mock-traffic-csv", version: "0.1.0" };

/** The vendor's zone codes for store demo-001. */
export const DEMO_001_TRAFFIC_ZONES: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`AISLE${String(i + 1).padStart(2, "0")}`, `aisle-${String(i + 1).padStart(2, "0")}`])),
  ENDCAPS: "endcaps",
  PRODUCE: "produce",
  BAKERY: "bakery",
  DELI: "deli",
  DAIRY: "dairy",
  MEAT: "meat-seafood",
  ENTRY: "entrance",
  EXIT: "exit",
  FRONTEND: "front-end",
  SCO: "self-checkout",
};

export function demo001TrafficConfig(): TrafficAdapterConfig {
  return { store: "demo-001", timezone: "America/Los_Angeles", site: "0001", zones: DEMO_001_TRAFFIC_ZONES };
}

/** CSV column -> OISS ZoneMetric metric, in the order OISS writes them. */
const METRICS: [keyof MockTrafficRow, string, "int" | "decimal"][] = [
  ["entries", "traffic", "int"],
  ["avg_occupancy", "avgOccupancy", "decimal"],
  ["peak_occupancy", "peakOccupancy", "int"],
  ["avg_dwell_sec", "avgDwellSeconds", "int"],
  ["queue_length", "queueLength", "int"],
  ["avg_wait_sec", "avgWaitSeconds", "int"],
  ["lanes_open", "openLanes", "int"],
];

/** Split the vendor's CSV into rows by its header. Cells are plain: the vendor never quotes. */
export function parseTrafficCsv(text: string): { rows: MockTrafficRow[]; rejected: { line: number; reason: string }[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = (lines.shift() ?? "").split(",").map((h) => h.trim());
  const rows: MockTrafficRow[] = [];
  const rejected: { line: number; reason: string }[] = [];
  const missing = TRAFFIC_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) return { rows, rejected: [{ line: 1, reason: `the header is missing ${missing.join(", ")}` }] };
  lines.forEach((l, i) => {
    const cells = l.split(",").map((c) => c.trim());
    if (cells.length !== header.length) return rejected.push({ line: i + 2, reason: `${cells.length} cells, expected ${header.length}` });
    rows.push(Object.fromEntries(TRAFFIC_COLUMNS.map((c) => [c, cells[header.indexOf(c)]!])) as MockTrafficRow);
  });
  return { rows, rejected };
}

export function toTrafficCsv(rows: MockTrafficRow[]): string {
  return [TRAFFIC_COLUMNS.join(","), ...rows.map((r) => TRAFFIC_COLUMNS.map((c) => r[c]).join(","))].join("\n") + "\n";
}

export interface TrafficResult {
  metrics: Envelope<"oiss.ZoneMetric">[];
  rejected: { row: number; reason: string }[];
}

export function adaptTraffic(rows: MockTrafficRow[], config: TrafficAdapterConfig): TrafficResult {
  const source = `urn:oiss:${config.store}:mock-vendor-c:people-counting`;
  const provenance = { system: "Mock people-counting system", vendor: "Vendor C", model: { name: "people-counter", version: "0.2" }, adapter: ADAPTER, synthetic: true };
  const result: TrafficResult = { metrics: [], rejected: [] };
  const nextId = idCounter(config.timezone);
  rows.forEach((r, i) => {
    const reject = (reason: string) => result.rejected.push({ row: i + 1, reason });
    if (r.site_id !== config.site) return reject(`unknown site ${r.site_id}`);
    const zone = config.zones[r.zone_code];
    if (!zone) return reject(`unknown zone ${r.zone_code}`);
    const start = localToIso(r.interval_start, config.timezone);
    if (!start) return reject(`interval start ${r.interval_start} is not a time the store's clocks show`);
    const minutes = Number(r.interval_min);
    if (!Number.isInteger(minutes) || minutes <= 0) return reject(`bad interval length ${r.interval_min}`);
    const accuracy = Number(r.accuracy_pct);
    if (r.accuracy_pct === "" || !(accuracy >= 0 && accuracy <= 100)) return reject(`accuracy out of range: ${r.accuracy_pct}`);
    const metrics: Record<string, number> = {};
    for (const [column, name, kind] of METRICS) {
      if (r[column] === "") continue;
      const n = Number(r[column]);
      if (!Number.isFinite(n) || n < 0 || (kind === "int" && !Number.isInteger(n))) return reject(`bad ${column}: ${r[column]}`);
      metrics[name] = n;
    }
    if (metrics.traffic === undefined) return reject("no entries count");
    const endMs = Date.parse(start) + minutes * 60_000;
    const end = localIso(endMs, config.timezone);
    const id = nextId("zm", endMs);
    result.metrics.push(
      envelope({
        type: "oiss.ZoneMetric",
        id,
        source,
        time: end,
        subject: zone,
        schema: "zone-metric.schema.json",
        store: config.store,
        privacy: "aggregate",
        data: { provenance, window: { start, end }, location: { zone }, metrics, confidence: accuracy / 100 },
      }),
    );
  });
  return result;
}
