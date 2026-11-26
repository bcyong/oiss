import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptShelfScans, demo001ShelfScanConfig, type MockShelfRead, type MockShelfScanMission } from "../src/mock-shelf-scan.ts";
import { LAYOUT } from "./fixtures.ts";

const read = (over: Partial<MockShelfRead> = {}): MockShelfRead => ({ shelf: 2, state: "OK", fill_pct: 85, expected: "2000000003030", detected: "2000000003030", conf: 0.93, tag_price: 4.99, price_file: 4.99, exceptions: [], ...over });
const mission = (shelves: MockShelfRead[], over: Partial<MockShelfScanMission> = {}): MockShelfScanMission => ({
  mission_id: "MVA-TEST-0800",
  site: "DG0001",
  robot: "MVA-R1",
  started_at: "2026-11-17T16:00:00.000Z",
  ended_at: "2026-11-17T16:46:00.000Z",
  // 08:10:12 in Los Angeles.
  captures: [{ capture_id: "C0001", ts: "2026-11-17T16:10:12.000Z", section: "A03L", position: 1, shelves }],
  mock: true,
  ...over,
});
const config = demo001ShelfScanConfig(LAYOUT);

test("a read becomes a ShelfObservation at the facing the planogram has there, shelves counted from the bottom", () => {
  const out = adaptShelfScans([mission([read(), read({ shelf: 1, expected: "2000000003054", detected: "2000000003054", fill_pct: 40 })])], config);
  assert.deepEqual(out.rejected, []);
  const [bottom, top] = out.observations;
  assert.equal(bottom!.subject, "A03-L-S0-F01");
  assert.equal(top!.subject, "A03-L-S1-F01");
  assert.equal(bottom!.source, "urn:oiss:demo-001:mock-vendor-a:robot-1");
  assert.equal(bottom!.time, "2026-11-17T08:10:12-08:00");
  assert.deepEqual(bottom!.data.window, { start: "2026-11-17T08:10:08-08:00", end: "2026-11-17T08:10:12-08:00" });
  assert.deepEqual(bottom!.data.location, { zone: "aisle-03", fixture: "A03-L", shelf: "A03-L-S0", facing: "A03-L-S0-F01" });
  assert.equal(bottom!.data.status, "in_stock");
  assert.equal(bottom!.data.fillLevel, 0.85);
  assert.equal(bottom!.data.observedGtin, "02000000003030");
  assert.deepEqual(bottom!.data.tagPrice, { amount: 4.99, currency: "USD" });
  assert.equal(out.evidence.length, 0);
});

test("exceptions become OISS flags, and the shelf image becomes restricted Evidence", () => {
  const out = adaptShelfScans([mission([read({ state: "LOW", fill_pct: 15, detected: "2000000003047", exceptions: ["PLUG", "PRICE"], tag_price: 3.99, image: "C0001-S2.jpg" })])], config);
  const [obs] = out.observations;
  const [ev] = out.evidence;
  assert.equal(obs!.data.status, "low_stock");
  assert.deepEqual(obs!.data.flags, ["misplaced_item", "price_mismatch"]);
  assert.equal(obs!.data.observedGtin, "02000000003047");
  assert.equal(obs!.data.planogramGtin, "02000000003030");
  assert.deepEqual(obs!.data.evidence, [ev!.id]);
  assert.equal(ev!.oissprivacy, "restricted");
  assert.equal(ev!.data.uri, "mock-vendor-a/MVA-TEST-0800/C0001-S2.jpg");
  assert.equal(ev!.data.redaction, "cropped_to_shelf");
  assert.equal(ev!.data.retainUntil, "2026-12-17T00:00:00-08:00");
});

test("a shelf the robot couldn't read is unknown, with no price", () => {
  const out = adaptShelfScans([mission([{ shelf: 2, state: "NOREAD", expected: "2000000003030", conf: 0.3, exceptions: [] }])], config);
  const [obs] = out.observations;
  assert.equal(obs!.data.status, "unknown");
  assert.equal(obs!.data.tagPrice, undefined);
  assert.equal(obs!.data.fillLevel, undefined);
});

test("reads the adapter can't map are rejected with a reason, not guessed", () => {
  const out = adaptShelfScans(
    [
      mission([read()], { site: "XX9" }),
      mission([read({ shelf: 3 })]),
      mission([read({ expected: "2000000003047" })]),
      mission([read({ detected: "2000000003031" })]),
    ],
    config,
  );
  assert.equal(out.observations.length, 0);
  assert.equal(out.rejected.length, 4);
  assert.match(out.rejected[0]!.reason, /unknown site/);
  assert.match(out.rejected[1]!.reason, /no facing/);
  assert.match(out.rejected[2]!.reason, /planogram puts 02000000003030 there/);
  assert.match(out.rejected[3]!.reason, /not a valid/);
});
