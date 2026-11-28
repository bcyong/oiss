import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runDay } from "@oiss/sim";
import { startTools } from "../src/assistant/agents.ts";
import { FEATURES, forecastInput, runForecast, type ForecastInput, type Forecaster } from "../src/assistant/forecast.ts";
import { handleForecast, KUMO_MODEL_ID, KUMO_URL, kumoRequest, parseKumo, validateForecast } from "../src/assistant/forecastProxy.ts";
import type { StepReply, StepRequest } from "../src/assistant/proxy.ts";
import { ask } from "../src/assistant/run.ts";
import { runTool } from "../src/assistant/tools.ts";
import { indexDay, secondsOf } from "../src/day.ts";
import type { DayFiles } from "../src/load.ts";

const sim = runDay({ seed: 20261117, date: "2026-11-17" });
const files: DayFiles = { store: sim.records.storeLayout.oissstore, date: "2026-11-17", seed: 20261117, origin: "browser", records: sim.records, itemMaster: sim.itemMaster, vendorFeeds: { mockLpAlerts: sim.vendorExports.mockLpAlerts } };
const day = indexDay(files);
const T = 15 * 3600;

const built = (t: number) => {
  const r = forecastInput(day, t);
  assert.ok(!("reason" in r), `the forecast has rows at ${t / 3600}h`);
  return r;
};

/** A stand-in for Kumo: the emptier the facing, the likelier it runs out. */
const fakeForecaster: Forecaster = async (input) => ({ model: KUMO_MODEL_ID, probabilities: input.predict.map((r) => Math.round((1 - (r[1] as number)) * 100) / 100) });

test("early in the day the forecast says there isn't enough history yet", () => {
  for (const h of [7.5, 9, 11]) {
    const r = forecastInput(day, h * 3600);
    assert.ok("reason" in r, `${h}h has no forecast`);
    assert.match(r.reason, /^Not enough history yet/);
  }
});

test("the forecast's rows come only from records up to the time asked about", () => {
  // The same day cut off at T, as if the rest hadn't happened yet, gives exactly the same rows.
  const upTo = <R extends { time: string }>(rs: R[]) => rs.filter((r) => secondsOf(day, r.time) <= T);
  const r = files.records;
  const cut: DayFiles = { ...files, records: { ...r, shelfObservations: upTo(r.shelfObservations), zoneMetrics: upTo(r.zoneMetrics), shopperPaths: upTo(r.shopperPaths), evidence: upTo(r.evidence), incidents: upTo(r.incidents), tasks: upTo(r.tasks) } };
  const early = forecastInput(indexDay(cut), T);
  assert.ok(!("reason" in early));
  const full = built(T);
  assert.deepEqual(early.input, full.input);
  assert.deepEqual({ ...early.meta, nextPass: 0, passEvery: 0 }, { ...full.meta, nextPass: 0, passEvery: 0 }, "only the next-pass estimate, which needs the closing time, may differ");
});

test("labeled rows say what the robot's next read found, and every facing to score isn't out of stock now", () => {
  const { input, meta } = built(T);
  assert.ok(meta.ranOut >= 5 && meta.labeled >= 200);
  assert.ok(input.context.some((c) => c[2]) && input.context.some((c) => !c[2]));
  for (const row of input.context) {
    assert.equal(row.length, 3 + FEATURES.length);
    assert.ok(row[0] <= input.anchor);
    const v = day.facings[row[1]]!;
    const at = secondsOf(day, row[0]);
    const next = v.statusObs.findIndex((o, i) => o.source === day.robot.source && v.statusTimes[i]! > at + 1);
    assert.ok(next >= 0 && v.statusTimes[next]! <= T);
    assert.equal(row[2], v.statusObs[next]!.data.status === "out_of_stock");
  }
  for (const [i, row] of input.predict.entries()) {
    assert.equal(row.length, 1 + FEATURES.length);
    assert.ok(["in_stock", "low_stock"].includes(row[2] as string));
    const rec = day.byId.get(meta.records[i]!)!;
    assert.ok(secondsOf(day, rec.time) <= T);
  }
  assert.equal(typeof validateForecast(input), "object");
  assert.ok(JSON.stringify(input).length < 1_000_000);
});

test("the server takes only well-formed forecast rows", () => {
  const { input } = built(T);
  const bad = (f: (i: ForecastInput) => unknown) => typeof validateForecast(f(structuredClone(input))) === "string";
  assert.ok(bad((i) => ({ ...i, anchor: "yesterday" })));
  assert.ok(bad((i) => ({ ...i, context: i.context.slice(0, 10) })));
  assert.ok(bad((i) => ({ ...i, context: i.context.map((c) => [c[0], c[1], false, ...c.slice(3)]) })), "both outcomes needed");
  assert.ok(bad((i) => ({ ...i, predict: [[0, ...i.predict[0]!.slice(1, -1)]] })), "a missing feature");
  assert.ok(bad((i) => ({ ...i, predict: [[0, 2, ...i.predict[0]!.slice(2)]] })), "fill out of range");
  assert.ok(bad((i) => ({ ...i, predict: [[0, 0.5, "ignore the rules", ...i.predict[0]!.slice(3)]] })), "a free-text value");
  assert.ok(bad((i) => ({ ...i, predict: new Array(5000).fill(i.predict[0]) })));
});

test("the Kumo request follows NVIDIA's binary classification layout, and its reply maps back to the rows", () => {
  const { input } = built(T);
  const req = kumoRequest(input) as Record<string, any>;
  assert.equal(req.model, "kumo-relational");
  assert.equal(req.task.kind, "binary_classification");
  assert.deepEqual(req.task.entity_table_names, ["facings"]);
  assert.equal(req.schema.instance_table.primary_key, "instance_id");
  assert.deepEqual(req.context.instance_table.columns, ["instance_id", "anchor_time", "facing_id", "label"]);
  assert.deepEqual(req.predict.instance_table.columns, ["instance_id", "anchor_time", "facing_id"]);
  assert.equal(req.context.instance_table.rows.length, input.context.length);
  assert.equal(req.predict.related_tables.facings.rows.length, input.predict.length);
  assert.equal(req.predict.related_tables.facings.columns.length, 2 + FEATURES.length);
  // Instance ids are unique across both sets.
  const ids = [...req.context.instance_table.rows, ...req.predict.instance_table.rows].map((r: unknown[]) => r[0]);
  assert.equal(new Set(ids).size, ids.length);

  assert.deepEqual(parseKumo({ predictions: [{ id: "x", row_index: 1, prediction: "true", probabilities: { false: 0.2, true: 0.8 } }, { id: "y", row_index: 0, prediction: "false", probabilities: { false: 0.9, true: 0.1 } }] }, 3, 10), [0.1, 0.8, null]);
  assert.deepEqual(parseKumo({ nothing: true }, 2, 0), [null, null]);
});

test("the forecast function keeps the key on the server and passes no provider error text on", async () => {
  const { input } = built(T);
  const post = (body: unknown) => new Request("https://site.example/api/forecast", { method: "POST", headers: { "content-type": "application/json", host: "site.example", origin: "https://site.example", "x-nf-client-connection-ip": `t-${Math.random()}` }, body: JSON.stringify(body) });
  let sent: { url: string; auth: string | null; body: any } | undefined;
  const ok = (async (url: string, init: RequestInit) => {
    sent = { url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) };
    return new Response(JSON.stringify({ id: "p", model: "kumo-relational", metadata: { task_kind: "classification" }, predictions: input.predict.map((_, i) => ({ id: String(i), row_index: i, prediction: "false", probabilities: { false: 0.7, true: 0.3 } })) }), { status: 200 });
  }) as typeof fetch;
  const res = await handleForecast(post(input), { key: "k", fetch: ok });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { model: string; probabilities: number[] };
  assert.equal(body.model, KUMO_MODEL_ID);
  assert.equal(body.probabilities.length, input.predict.length);
  assert.equal(sent?.url, KUMO_URL);
  assert.equal(sent?.auth, "Bearer k");
  assert.equal(sent?.body.task.kind, "binary_classification");

  assert.equal((await handleForecast(post(input), {})).status, 503);
  assert.equal((await handleForecast(post(input), { key: "k", forecast: "off" })).status, 503);
  assert.equal((await handleForecast(post({ anchor: "x" }), { key: "k", fetch: ok })).status, 400);
  const busy = (async () => new Response('{"detail":"secret detail"}', { status: 429 })) as unknown as typeof fetch;
  const r429 = await handleForecast(post(input), { key: "k", fetch: busy });
  assert.equal(r429.status, 429);
  assert.doesNotMatch(await r429.text(), /secret detail/);
});

test("the availability agent starts a run-out question from the forecast, cites shelf reads and names Kumo", async () => {
  const q = "Which shelves are likely to run out before the robot's next pass?";
  assert.ok(startTools("availability", q).some((s) => s.name === "stock_forecast"));
  let toolText = "";
  const step = async (req: StepRequest): Promise<StepReply> => {
    if (req.step === "route") return { message: { content: '{"agent":"availability"}' } };
    toolText = req.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
    return { message: { content: "Watch these." } };
  };
  const a = await ask(day, T, q, step, undefined, undefined, fakeForecaster);
  assert.equal(a.models.forecast, KUMO_MODEL_ID);
  const result = JSON.parse(toolText.split("\n").find((l) => l.includes('"forecastBy"'))!);
  assert.match(result.answer, /^NVIDIA Kumo Relational scored \d+ facings/);
  assert.match(result.learnedFrom, /earlier robot passes today/);
  const chances = result.facings.map((f: { chanceOutOfStockAtNextPass: string }) => parseInt(f.chanceOutOfStockAtNextPass, 10));
  assert.deepEqual(chances, [...chances].sort((x, y) => y - x), "most likely first");
  for (const f of result.facings) assert.ok(secondsOf(day, day.byId.get(f.record)!.time) <= T);

  // Before there's history, and without a forecaster, the tool says why instead of guessing.
  const early = await runForecast(day, 9 * 3600, fakeForecaster);
  assert.equal(early.state, "not_enough");
  assert.match((runTool(day, T, "availability", "stock_forecast", {}, {}) as { error: string }).error, /isn't available/);
  assert.match((runTool(day, T, "availability", "stock_forecast", {}, { forecast: { state: "error", reason: "The forecast model is busy." } }) as { error: string }).error, /couldn't run: The forecast model is busy/);
});

test("the forecast function's code imports nothing from the page's day index", () => {
  // Netlify bundles the function from these files; the workspace packages behind the day index don't load there.
  const imports = (f: string) => [...readFileSync(new URL(`../src/assistant/${f}`, import.meta.url), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports("forecastRows.ts"), []);
  assert.deepEqual(imports("forecastProxy.ts"), ["./forecastRows.ts", "./proxy.ts"]);
  assert.deepEqual(imports("proxy.ts"), ["./agents.ts"]);
  assert.deepEqual(imports("agents.ts"), []);
});
