/**
 * Write one simulated store day as OISS records.
 *
 *   node src/cli.ts [--seed N] [--date YYYY-MM-DD] [--out DIR] [--check MANIFEST] [--write-manifest MANIFEST]
 *
 * Output, under DIR/<store>/<date>/:
 *   store-layout.json         the StoreLayout record (planogram included)
 *   shelf-observations.jsonl  ShelfObservation records, one per line, in time order: shelf scans
 *                             (through the mock-shelf-scan adapter), shelf cameras, and shelf label
 *                             price checks (through the mock-esl adapter)
 *   zone-metrics.jsonl        ZoneMetric records, through the mock-traffic-csv adapter
 *   shopper-paths.jsonl       ShopperPath records
 *   evidence.jsonl            Evidence records: shelf images behind low-stock and out-of-stock reads,
 *                             and checkout clips behind loss prevention alerts
 *   incidents.jsonl           Incident records: loss prevention alerts, through the mock-lp-alerts adapter
 *   vendor/                   each mock vendor's own export, before its adapter (not OISS):
 *     mock-vendor-a-shelf-scans.ndjson  the shelf-scanning robot's missions, one per line
 *     mock-vendor-b-lp-alerts.ndjson    the loss prevention alerts
 *     mock-vendor-c-traffic.csv         the people-counting CSV
 *     mock-vendor-d-esl.ndjson          the shelf label system's price reports
 *   item-master.json          the synthetic item master (not an OISS record)
 *   summary.json              ground-truth totals for the day (not an OISS record)
 * plus DIR/index.json listing the days written.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runDay } from "./run.ts";

/** The golden day: the fixed seed and date that CI checks and the demo replays. */
export const GOLDEN = { seed: 20261117, date: "2026-11-17" };

const { values } = parseArgs({
  options: {
    seed: { type: "string", default: String(GOLDEN.seed) },
    date: { type: "string", default: GOLDEN.date },
    out: { type: "string", default: "out" },
    check: { type: "string" },
    "write-manifest": { type: "string" },
  },
});

const seed = Number(values.seed);
if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer: ${values.seed}`);
const day = runDay({ seed, date: values.date! });
const store = day.ground.layout.store.id;
const dir = join(values.out!, store, values.date!);
mkdirSync(dir, { recursive: true });

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const files: Record<string, { text: string; records?: number }> = {
  "store-layout.json": { text: JSON.stringify(day.records.storeLayout, null, 2) + "\n", records: 1 },
  "shelf-observations.jsonl": { text: jsonl(day.records.shelfObservations), records: day.records.shelfObservations.length },
  "zone-metrics.jsonl": { text: jsonl(day.records.zoneMetrics), records: day.records.zoneMetrics.length },
  "shopper-paths.jsonl": { text: jsonl(day.records.shopperPaths), records: day.records.shopperPaths.length },
  "evidence.jsonl": { text: jsonl(day.records.evidence), records: day.records.evidence.length },
  "incidents.jsonl": { text: jsonl(day.records.incidents), records: day.records.incidents.length },
  "vendor/mock-vendor-a-shelf-scans.ndjson": { text: jsonl(day.vendorExports.mockShelfScans) },
  "vendor/mock-vendor-b-lp-alerts.ndjson": { text: jsonl(day.vendorExports.mockLpAlerts) },
  "vendor/mock-vendor-c-traffic.csv": { text: day.vendorExports.mockTrafficCsv },
  "vendor/mock-vendor-d-esl.ndjson": { text: jsonl(day.vendorExports.mockEsl) },
  "item-master.json": { text: JSON.stringify(day.itemMaster, null, 2) + "\n" },
  "summary.json": { text: JSON.stringify(day.summary, null, 2) + "\n" },
};

const manifest = {
  store,
  date: values.date,
  seed,
  generator: day.summary.generator,
  files: Object.fromEntries(
    Object.entries(files).map(([name, f]) => [
      name,
      { ...(f.records !== undefined ? { records: f.records } : {}), bytes: Buffer.byteLength(f.text), sha256: createHash("sha256").update(f.text).digest("hex") },
    ]),
  ),
  stats: day.summary.stats,
  lossPrevention: day.summary.lossPrevention,
};

mkdirSync(join(dir, "vendor"), { recursive: true });
for (const [name, f] of Object.entries(files)) writeFileSync(join(dir, name), f.text);
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(values.out!, "index.json"), JSON.stringify({ days: [{ store, date: values.date, seed, path: `${store}/${values.date}/` }] }, null, 2) + "\n");

const total = Object.values(manifest.files).reduce((a, f) => a + ("records" in f ? (f.records as number) : 0), 0);
console.log(`${store} ${values.date} seed ${seed}: ${total} OISS records in ${dir}`);
for (const [name, f] of Object.entries(manifest.files)) console.log(`  ${name.padEnd(40)} ${"records" in f ? String(f.records).padStart(6) : "      "}  ${(f.bytes / 1024).toFixed(0).padStart(6)} KB`);

if (values["write-manifest"]) {
  writeFileSync(values["write-manifest"], JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${values["write-manifest"]}`);
}
if (values.check) {
  const expected = JSON.parse(readFileSync(values.check, "utf8")) as typeof manifest;
  const diffs = Object.keys({ ...expected.files, ...manifest.files }).filter((name) => expected.files[name]?.sha256 !== manifest.files[name]?.sha256);
  if (diffs.length) {
    console.error(`The golden day changed: ${diffs.join(", ")} differ from ${values.check}.`);
    console.error("If the change is intended, run `npm run golden:update -w sim` and commit the new manifest.");
    process.exit(1);
  }
  console.log(`matches ${values.check}`);
}
