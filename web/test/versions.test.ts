import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { DayRecords, OissRecord } from "../src/oiss.ts";
import { canRead, CURRENT, effectivePrivacy, readable, READS, toCurrent } from "../src/versions.ts";

const example = (path: string) => JSON.parse(readFileSync(new URL(`../../examples/${path}`, import.meta.url), "utf8")) as OissRecord<never>;
const versions = JSON.parse(readFileSync(new URL("../../schemas/versions.json", import.meta.url), "utf8")) as { current: string; versions: { version: string }[] };

test("the demo reads every version the spec lists, and reads them as the current one", () => {
  assert.deepEqual([...READS], versions.versions.map((v) => v.version));
  assert.equal(CURRENT, versions.current);
});

test("an unknown privacy class or OISS record type counts as restricted", () => {
  const zone = example("valid/zone-metric.json");
  assert.equal(effectivePrivacy(zone), "aggregate");
  assert.equal(effectivePrivacy({ ...zone, oissprivacy: "pseudonymous" }), "restricted");
  assert.equal(effectivePrivacy({ ...zone, type: "oiss.QueueEstimate" }), "restricted");
});

test("records of an older version are read, a newer version or a vendor's own type is left out", () => {
  const old = example("older/shelf-observation-v0.1.json");
  const now = example("valid/shelf-observation.json");
  assert.ok(canRead(old) && canRead(now));
  assert.equal(toCurrent(old), old);
  assert.equal(canRead({ ...now, oissversion: "0.3" }), false);
  assert.equal(canRead(example("valid/vendor-record-type.json")), false);

  const records = {
    storeLayout: example("valid/store-layout.json"),
    shelfObservations: [old, now, { ...now, id: "so-0099", oissversion: "0.3" }],
    zoneMetrics: [],
    shopperPaths: [],
  } as unknown as DayRecords;
  const read = readable(records);
  assert.deepEqual(read.shelfObservations.map((r) => r.oissversion), ["0.1", "0.2"]);
  assert.equal(read.evidence, undefined);
});
