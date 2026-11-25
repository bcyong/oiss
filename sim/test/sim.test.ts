import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDigit, syntheticGtin } from "../src/catalog.ts";
import { route, routeLength, buildLayout } from "../src/layout.ts";
import { Rng } from "../src/rng.ts";
import { runDay } from "../src/run.ts";
import { storeClock } from "../src/time.ts";

const day = runDay({ seed: 7, date: "2026-11-17" });

test("the same seed gives the same day, and a different seed a different one", () => {
  const again = runDay({ seed: 7, date: "2026-11-17" });
  assert.equal(JSON.stringify(again.records), JSON.stringify(day.records));
  const other = runDay({ seed: 8, date: "2026-11-17" });
  assert.notEqual(JSON.stringify(other.records.zoneMetrics), JSON.stringify(day.records.zoneMetrics));
});

test("synthetic GTINs use the GS1 restricted-circulation prefix and a valid check digit", () => {
  assert.equal(syntheticGtin(101), "02000000001012");
  for (const item of day.itemMaster.items) {
    assert.match(item.gtin, /^020\d{11}$/);
    assert.equal(Number(item.gtin.at(-1)), checkDigit(item.gtin.slice(0, -1)));
  }
  assert.equal(new Set(day.itemMaster.items.map((i) => i.gtin)).size, day.itemMaster.items.length);
});

test("store time carries the store's UTC offset, including daylight saving time", () => {
  assert.equal(storeClock("2026-11-17", "America/Los_Angeles").iso(9 * 3600), "2026-11-17T09:00:00-08:00");
  assert.equal(storeClock("2026-07-01", "America/Los_Angeles").iso(9 * 3600), "2026-07-01T09:00:00-07:00");
});

test("walkway routes connect any two shopping points", () => {
  const layout = buildLayout();
  const rng = new Rng(1);
  for (let i = 0; i < 200; i++) {
    const a = rng.pick(layout.slots).access;
    const b = rng.pick(layout.slots).access;
    const r = route(layout.walk, a, b);
    assert.deepEqual(r[0], a);
    assert.deepEqual(r.at(-1), b);
    // Every leg runs along x or along y.
    for (let k = 1; k < r.length; k++) assert.ok(r[k]!.x === r[k - 1]!.x || r[k]!.y === r[k - 1]!.y);
    assert.ok(routeLength(r) >= Math.abs(a.x - b.x) + Math.abs(a.y - b.y) - 1e-9);
  }
});

test("every planogram facing is in the StoreLayout record, with its GTIN and capacity", () => {
  const facings = (day.records.storeLayout.data as { facings: { id: string; gtin: string; capacity: number }[] }).facings;
  assert.equal(facings.length, day.ground.catalog.planogram.length);
  for (const f of facings) assert.ok(f.capacity >= 1 && f.gtin.startsWith("02"));
});

test("shelf inventory never goes negative or over capacity", () => {
  for (const pos of day.ground.catalog.planogram) {
    for (const [, units] of day.ground.shelfHistory.get(pos.facing)!) {
      assert.ok(units >= 0 && units <= pos.capacity, `${pos.facing}: ${units} of ${pos.capacity}`);
    }
  }
});

test("every shopper leaves, and their path is in time order", () => {
  for (const track of day.ground.tracks) {
    assert.ok(track.exit > track.arrival);
    for (let k = 1; k < track.points.length; k++) assert.ok(track.points[k]!.t >= track.points[k - 1]!.t, `shopper ${track.shopper}`);
  }
});

test("the day looks like a grocery store", () => {
  const s = day.summary.stats;
  assert.ok(s.shoppers > 1300 && s.shoppers < 1900, `shoppers ${s.shoppers}`);
  const missedShare = s.unitsMissed / (s.unitsSold + s.unitsMissed);
  assert.ok(missedShare > 0.01 && missedShare < 0.12, `missed share ${missedShare}`);
  assert.ok(s.avgWaitStaffedSeconds > 10 && s.avgWaitStaffedSeconds < 600, `wait ${s.avgWaitStaffedSeconds}`);
  const statuses = new Set(day.records.shelfObservations.map((r) => (r.data as { status: string }).status));
  for (const status of ["in_stock", "low_stock", "out_of_stock"]) assert.ok(statuses.has(status), status);
});

test("shopper path ids rotate at least every 15 minutes and never repeat", () => {
  const ids = new Set<string>();
  for (const r of day.records.shopperPaths) {
    assert.ok(!ids.has(r.subject));
    ids.add(r.subject);
    const d = r.data as { window: { start: string; end: string } };
    assert.ok(Date.parse(d.window.end) - Date.parse(d.window.start) <= 15 * 60 * 1000);
  }
});

test("records in each file are in time order", () => {
  for (const list of [day.records.shelfObservations, day.records.zoneMetrics, day.records.shopperPaths, day.records.evidence]) {
    for (let k = 1; k < list.length; k++) assert.ok(list[k - 1]!.time <= list[k]!.time);
  }
});

test("a shelf image backs every low-stock and out-of-stock read, and nothing else", () => {
  const evidence = new Map(day.records.evidence.map((r) => [r.id, r]));
  const used = new Set<string>();
  for (const r of day.records.shelfObservations) {
    const d = r.data as { status: string; evidence?: string[]; location: { facing: string } };
    const backed = d.status === "low_stock" || d.status === "out_of_stock";
    assert.equal(d.evidence?.length ?? 0, backed ? 1 : 0, r.id);
    for (const id of d.evidence ?? []) {
      const ev = evidence.get(id);
      assert.ok(ev, `${r.id} points to missing ${id}`);
      assert.equal(ev.oissprivacy, "restricted");
      assert.equal((ev.data as { location: { facing: string } }).location.facing, d.location.facing);
      assert.equal(ev.time, r.time);
      used.add(id);
    }
  }
  assert.equal(used.size, evidence.size);
  const retain = (day.records.evidence[0]!.data as { retainUntil: string }).retainUntil;
  assert.equal(retain, "2026-12-17T00:00:00-08:00");
});
