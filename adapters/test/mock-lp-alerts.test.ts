import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptLpAlerts, demo001Config, localIso, type MockLpAlert, toGtin14 } from "../src/mock-lp-alerts.ts";

// 2026-11-17 17:42:10 in Los Angeles (UTC-08:00).
const at = Date.parse("2026-11-18T01:42:10Z");
const alert = (over: Partial<MockLpAlert> = {}): MockLpAlert => ({
  alert_id: "MVB-TEST-1",
  site: "DG0001",
  register: "R03",
  event_ts: at,
  alert_ts: at + 20_000,
  alert_code: "NSCN",
  score: 82,
  items: [{ ean: "2000000003030", qty: 1, unit_price: 4.99 }],
  clip: { camera: "FE-CAM-1", start_ts: at - 15_000, end_ts: at + 5_000, uri: "clips/MVB-TEST-1.mp4" },
  mock: true,
  ...over,
});

test("an alert becomes an open Incident and an Evidence clip in the store's terms", () => {
  const out = adaptLpAlerts([alert()], demo001Config());
  assert.deepEqual(out.rejected, []);
  const [inc] = out.incidents;
  const [ev] = out.evidence;
  assert.equal(inc!.type, "oiss.Incident");
  assert.equal(inc!.time, "2026-11-17T17:42:30-08:00");
  assert.equal(inc!.oissprivacy, "restricted");
  assert.deepEqual(inc!.data.location, { zone: "front-end", fixture: "lane-03" });
  assert.equal(inc!.data.incidentType, "non_scan");
  assert.equal(inc!.data.status, "open");
  assert.equal(inc!.data.confidence, 0.82);
  assert.deepEqual(inc!.data.gtins, ["02000000003030"]);
  assert.deepEqual(inc!.data.evidence, [ev!.id]);
  assert.match(inc!.data.summary as string, /^Possible non-scan at lane 3: 1 item, \$4\.99/);
  assert.equal(out.incidentFor["MVB-TEST-1"], inc!.id);
  assert.deepEqual(ev!.data.location, { zone: "front-end", fixture: "lane-03", camera: "cam-fe-1" });
  assert.deepEqual(ev!.data.window, { start: "2026-11-17T17:41:55-08:00", end: "2026-11-17T17:42:15-08:00" });
  assert.equal(ev!.data.retainUntil, "2027-02-15T00:00:00-08:00");
  assert.equal(ev!.data.redaction, "people_blurred");
});

test("alerts the adapter can't map are rejected with a reason, not guessed", () => {
  const out = adaptLpAlerts(
    [alert({ alert_id: "a", site: "XX9" }), alert({ alert_id: "b", register: "R99" }), alert({ alert_id: "c", items: [{ ean: "2000000003031", qty: 1, unit_price: 1 }] }), alert({ alert_id: "d", score: 140 })],
    demo001Config(),
  );
  assert.equal(out.incidents.length, 0);
  assert.deepEqual(out.rejected.map((r) => r.alert_id), ["a", "b", "c", "d"]);
});

test("item codes become 14-digit GTINs, and local times keep the store's offset across daylight saving time", () => {
  assert.equal(toGtin14("036000291452"), "00036000291452");
  assert.equal(toGtin14("036000291453"), null);
  assert.equal(localIso(Date.parse("2026-07-01T16:00:00Z"), "America/Los_Angeles"), "2026-07-01T09:00:00-07:00");
  assert.equal(localIso(Date.parse("2026-12-01T17:00:00Z"), "America/Los_Angeles"), "2026-12-01T09:00:00-08:00");
});
