import assert from "node:assert/strict";
import { test } from "node:test";
import { adaptEslEvents, demo001EslConfig, eslLabelFor, type MockEslEvent } from "../src/mock-esl.ts";
import { LAYOUT } from "./fixtures.ts";

const event = (over: Partial<MockEslEvent> = {}): MockEslEvent => ({
  event_id: "MVD-TEST-1",
  store_ref: "0001",
  label_id: eslLabelFor("A03-L-S0-F02"),
  item: "2000000003047",
  event: "PRICE_CONFIRMED",
  displayed_price: "3.49",
  target_price: "3.49",
  attempt: 1,
  // 06:04:10 in Los Angeles.
  at: "2026-11-17T14:04:10Z",
  mock: true,
  ...over,
});
const config = demo001EslConfig(LAYOUT);

test("a confirmed label becomes a price check with no on-shelf availability", () => {
  const out = adaptEslEvents([event()], config);
  assert.deepEqual(out.rejected, []);
  const [obs] = out.observations;
  assert.equal(obs!.type, "oiss.ShelfObservation");
  assert.equal(obs!.subject, "A03-L-S0-F02");
  assert.equal(obs!.source, "urn:oiss:demo-001:mock-vendor-d:esl");
  assert.equal(obs!.time, "2026-11-17T06:04:10-08:00");
  assert.equal(obs!.data.status, undefined);
  assert.equal(obs!.data.flags, undefined);
  assert.deepEqual(obs!.data.tagPrice, { amount: 3.49, currency: "USD" });
  assert.deepEqual(obs!.data.systemPrice, { amount: 3.49, currency: "USD" });
  assert.equal(obs!.data.confidence, 0.99);
});

test("a label that missed its price change is a price mismatch", () => {
  const [obs] = adaptEslEvents([event({ event: "UPDATE_FAILED", displayed_price: "2.99", attempt: 3 })], config).observations;
  assert.deepEqual(obs!.data.flags, ["price_mismatch"]);
  assert.deepEqual(obs!.data.tagPrice, { amount: 2.99, currency: "USD" });
  assert.deepEqual(obs!.data.systemPrice, { amount: 3.49, currency: "USD" });
  assert.equal(obs!.data.confidence, 0.9);
});

test("reports the adapter can't map are rejected with a reason, not guessed", () => {
  const out = adaptEslEvents([event({ store_ref: "0002" }), event({ label_id: "ESL-00000000" }), event({ item: "2000000003030" }), event({ displayed_price: "3,49" })], config);
  assert.equal(out.observations.length, 0);
  assert.equal(out.rejected.length, 4);
  assert.match(out.rejected[1]!.reason, /isn't linked to a facing/);
  assert.match(out.rejected[2]!.reason, /planogram puts 02000000003047 on A03-L-S0-F02/);
  assert.match(out.rejected[3]!.reason, /not a decimal amount/);
});
