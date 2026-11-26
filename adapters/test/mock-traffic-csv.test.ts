import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptTraffic, demo001TrafficConfig, parseTrafficCsv, toTrafficCsv } from "../src/mock-traffic-csv.ts";

const HEADER = "site_id,zone_code,interval_start,interval_min,entries,avg_occupancy,peak_occupancy,avg_dwell_sec,queue_length,avg_wait_sec,lanes_open,accuracy_pct";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

test("a row becomes a ZoneMetric with only the metrics the vendor filled in", () => {
  const { rows, rejected } = parseTrafficCsv(csv("0001,AISLE03,2026-11-17 14:30,15,42,6.3,11,187,,,,89", "0001,FRONTEND,2026-11-17 14:30,15,58,14.2,21,240,7,96,5,91"));
  assert.deepEqual(rejected, []);
  const out = adaptTraffic(rows, demo001TrafficConfig());
  assert.deepEqual(out.rejected, []);
  const [aisle, front] = out.metrics;
  assert.equal(aisle!.subject, "aisle-03");
  assert.equal(aisle!.time, "2026-11-17T14:45:00-08:00");
  assert.deepEqual(aisle!.data.window, { start: "2026-11-17T14:30:00-08:00", end: "2026-11-17T14:45:00-08:00" });
  assert.deepEqual(aisle!.data.metrics, { traffic: 42, avgOccupancy: 6.3, peakOccupancy: 11, avgDwellSeconds: 187 });
  assert.equal(aisle!.data.confidence, 0.89);
  assert.equal(aisle!.oissprivacy, "aggregate");
  assert.deepEqual(front!.data.metrics, { traffic: 58, avgOccupancy: 14.2, peakOccupancy: 21, avgDwellSeconds: 240, queueLength: 7, avgWaitSeconds: 96, openLanes: 5 });
});

test("wall-clock times get the offset in force, and the hour that repeats in the fall is read as the first one", () => {
  const { rows } = parseTrafficCsv(csv("0001,AISLE01,2026-07-01 09:00,15,1,0.1,1,,,,,90", "0001,AISLE01,2026-11-01 01:30,15,1,0.1,1,,,,,90", "0001,AISLE01,2026-03-08 02:15,15,1,0.1,1,,,,,90"));
  const out = adaptTraffic(rows, demo001TrafficConfig());
  assert.equal((out.metrics[0]!.data.window as { start: string }).start, "2026-07-01T09:00:00-07:00");
  assert.equal((out.metrics[1]!.data.window as { start: string }).start, "2026-11-01T01:30:00-07:00");
  assert.equal((out.metrics[1]!.data.window as { end: string }).end, "2026-11-01T01:45:00-07:00");
  assert.equal(out.rejected.length, 1);
  assert.match(out.rejected[0]!.reason, /not a time the store's clocks show/);
});

test("rows the adapter can't read or map are rejected with a reason, not guessed", () => {
  const parsed = parseTrafficCsv(csv("0002,AISLE01,2026-11-17 09:00,15,1,0.1,1,,,,,90", "0001,GARDEN,2026-11-17 09:00,15,1,0.1,1,,,,,90", "0001,AISLE01,2026-11-17 09:00,15,1.5,0.1,1,,,,,90", "0001,AISLE01,2026-11-17 09:00,15,1"));
  assert.equal(parsed.rejected.length, 1);
  const out = adaptTraffic(parsed.rows, demo001TrafficConfig());
  assert.equal(out.metrics.length, 0);
  assert.deepEqual(out.rejected.map((r) => r.reason), ["unknown site 0002", "unknown zone GARDEN", "bad entries: 1.5"]);
});

test("the CSV writer and reader agree", () => {
  const { rows } = parseTrafficCsv(csv("0001,SCO,2026-11-17 18:00,15,30,4.1,7,201,2,35,6,88"));
  assert.equal(toTrafficCsv(rows), csv("0001,SCO,2026-11-17 18:00,15,30,4.1,7,201,2,35,6,88"));
});
