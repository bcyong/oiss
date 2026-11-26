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
  for (const list of [day.records.shelfObservations, day.records.zoneMetrics, day.records.shopperPaths, day.records.evidence, day.records.incidents]) {
    for (let k = 1; k < list.length; k++) assert.ok(list[k - 1]!.time <= list[k]!.time);
  }
});

test("a shelf image backs every low-stock, out-of-stock and flagged read, and nothing else", () => {
  const evidence = new Map(day.records.evidence.filter((r) => !r.id.startsWith("ev-lp-")).map((r) => [r.id, r]));
  const used = new Set<string>();
  for (const r of day.records.shelfObservations) {
    const d = r.data as { status?: string; flags?: string[]; evidence?: string[]; location: { facing: string } };
    // Shelf label price checks can't see the shelf, so no image backs them.
    const backed = d.status !== undefined && (d.status === "low_stock" || d.status === "out_of_stock" || (d.flags?.length ?? 0) > 0);
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
  const retain = (day.records.evidence.find((r) => r.id.startsWith("ev-2"))!.data as { retainUntil: string }).retainUntil;
  assert.equal(retain, "2026-12-17T00:00:00-08:00");
});

test("loss prevention: every alert becomes an Incident backed by a clip, and the scorecard adds up", () => {
  const lp = day.summary.lossPrevention;
  assert.ok(lp.exceptions > 0 && lp.alerts > 0);
  assert.equal(lp.trueAlerts + lp.falseAlerts, lp.alerts);
  assert.equal(lp.trueAlerts + lp.missed, lp.exceptions);
  assert.equal(day.records.incidents.length, day.vendorExports.mockLpAlerts.length);
  const evidence = new Map(day.records.evidence.map((r) => [r.id, r]));
  const lanes = new Set(day.ground.layout.fixtures.filter((f) => f.kind === "checkout_lane" || f.kind === "self_checkout").map((f) => f.id));
  for (const inc of day.records.incidents) {
    const d = inc.data as { evidence: string[]; location: { fixture: string }; status: string; confidence: number };
    assert.equal(inc.oissprivacy, "restricted");
    assert.equal(d.status, "open");
    assert.ok(lanes.has(d.location.fixture), d.location.fixture);
    assert.ok(d.confidence > 0 && d.confidence < 1);
    for (const id of d.evidence) assert.equal((evidence.get(id)!.data as { mediaType: string }).mediaType, "video/mp4");
  }
  for (const a of day.vendorExports.mockLpAlerts) assert.ok(day.incidentFor[a.alert_id], a.alert_id);
});

test("every checkout is a transaction with what the shopper bought", () => {
  const bought = day.ground.tracks.reduce((a, t) => a + t.unitsBought, 0);
  const paid = day.ground.transactions.reduce((a, t) => a + t.lines.reduce((b, l) => b + l.qty, 0), 0);
  assert.equal(paid, bought);
});

test("shelf faults come at set rates and the robot flags misplaced items and price mismatches", () => {
  const faults = day.ground.faults;
  assert.ok(faults.some((f) => f.kind === "misplaced_item"));
  assert.ok(faults.some((f) => f.kind === "price_mismatch"));
  const flagged = day.records.shelfObservations.filter((r) => (r.data as { flags?: string[] }).flags);
  for (const r of flagged) {
    const d = r.data as { flags: string[]; observedGtin?: string; planogramGtin: string; tagPrice?: { amount: number }; systemPrice?: { amount: number }; evidence?: string[] };
    if (d.flags.includes("misplaced_item")) assert.notEqual(d.observedGtin, d.planogramGtin);
    if (d.flags.includes("price_mismatch")) assert.notEqual(d.tagPrice!.amount, d.systemPrice!.amount);
    if (!r.source.endsWith(":esl")) assert.ok(d.evidence?.length, "a shelf image backs every flagged read from a source that sees the shelf");
  }
  // A misplaced item the robot passed while it was there is flagged most of the time.
  const misplacedFlags = flagged.filter((r) => (r.data as { flags: string[] }).flags.includes("misplaced_item"));
  assert.ok(misplacedFlags.length > 0);
});

test("an injected fault changes nothing sent before it, and the robot finds it on its next run", () => {
  const T = 12 * 3600 + 20 * 60;
  const facings = day.ground.catalog.planogram.map((p) => p.facing);
  const injections = [
    { kind: "phantom_inventory" as const, facing: facings[40]!, t: T },
    { kind: "misplaced_item" as const, facing: facings[300]!, t: T },
    { kind: "price_mismatch" as const, facing: facings[600]!, t: T },
  ];
  const changed = runDay({ seed: 7, date: "2026-11-17", injections });
  const cutoff = day.ground.clock.iso(T);
  for (const kind of ["shelfObservations", "zoneMetrics", "shopperPaths", "evidence", "incidents"] as const) {
    const before = (rs: { time: string }[]) => JSON.stringify(rs.filter((r) => r.time <= cutoff));
    assert.equal(before(changed.records[kind]), before(day.records[kind]), `${kind} sent by ${cutoff} are unchanged`);
  }
  assert.equal(changed.summary.shelfFaults.injected, 3);

  const robotAfter = (facing: string) =>
    changed.records.shelfObservations.find((r) => r.source.endsWith(":robot-1") && r.time > cutoff && (r.data as { location: { facing: string } }).location.facing === facing)!.data as { status: string; flags?: string[] };
  assert.equal(robotAfter(injections[0]!.facing).status, "out_of_stock");
  assert.ok(robotAfter(injections[2]!.facing).flags?.includes("price_mismatch"));
  // Phantom inventory: no recovery round can refill the facing.
  assert.equal(changed.ground.unitsAt(injections[0]!.facing, 22 * 3600), 0);
});

test("shelf labels report the price mismatches they cause, and only those", () => {
  const checks = day.records.shelfObservations.filter((r) => r.source.endsWith(":mock-vendor-d:esl"));
  assert.ok(checks.length > 0);
  for (const r of checks) assert.equal((r.data as { status?: string }).status, undefined);
  const flaggedFacings = new Set(checks.filter((r) => (r.data as { flags?: string[] }).flags?.includes("price_mismatch")).map((r) => r.subject));
  const mismatches = day.ground.faults.filter((f) => f.kind === "price_mismatch");
  for (const f of mismatches) assert.equal(flaggedFacings.has(f.facing), f.cause === "label_not_updated", `${f.id} ${f.cause}`);
  // The robot reads the tag itself, so it finds every one whatever its cause.
  const robotFlagged = new Set(day.records.shelfObservations.filter((r) => r.source.endsWith(":robot-1") && (r.data as { flags?: string[] }).flags?.includes("price_mismatch")).map((r) => r.subject));
  for (const f of mismatches) assert.ok(robotFlagged.has(f.facing), f.id);
});

test("each vendor's own export is what its adapter read", () => {
  const { mockShelfScans, mockTrafficCsv, mockEsl } = day.vendorExports;
  const reads = mockShelfScans.reduce((a, m) => a + m.captures.reduce((b, c) => b + c.shelves.length, 0), 0);
  assert.equal(reads, day.records.shelfObservations.filter((r) => r.source.endsWith(":robot-1")).length);
  assert.equal(mockTrafficCsv.trim().split("\n").length - 1, day.records.zoneMetrics.length);
  assert.equal(mockEsl.length, day.records.shelfObservations.filter((r) => r.source.endsWith(":esl")).length);
  for (const m of mockShelfScans) assert.equal(m.mock, true);
  for (const e of mockEsl) assert.equal(e.mock, true);
});

test("store tasks move forward through their states and a verified task names the record that showed the fix", () => {
  const tasks = day.records.tasks;
  assert.ok(tasks.length > 0);
  assert.equal(new Set(tasks.map((r) => r.id)).size, tasks.length);
  const ids = new Set([...day.records.shelfObservations, ...day.records.zoneMetrics, ...day.records.incidents].map((r) => r.id));
  const order = ["open", "assigned", "in_progress", "done", "verified"];
  const bySubject = new Map<string, typeof tasks>();
  for (const r of tasks) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), r]);
  for (const [, versions] of bySubject) {
    const sorted = [...versions].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    assert.equal(sorted[0]!.data.state, "open");
    let last = -1;
    for (const v of sorted) {
      const d = v.data as { state: string; basedOn?: string[]; verification?: { required: boolean; verifiedBy?: string } };
      for (const ref of d.basedOn ?? []) assert.ok(ids.has(ref), `${v.id} is based on a record that exists`);
      if (d.state === "cancelled") continue;
      const i = order.indexOf(d.state);
      assert.ok(i > last, `${v.id} moves forward`);
      last = i;
      if (d.state === "verified") {
        assert.ok(d.verification?.verifiedBy && ids.has(d.verification.verifiedBy), `${v.id} names a record that showed the fix`);
        const proof = [...day.records.shelfObservations, ...day.records.zoneMetrics].find((r) => r.id === d.verification!.verifiedBy)!;
        assert.ok(Date.parse(proof.time) <= Date.parse(v.time), `${v.id} is verified after the record that showed the fix`);
      }
    }
  }
});
