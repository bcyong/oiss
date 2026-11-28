/**
 * Asks the assistant the sample questions at three times on the golden day, through the same server
 * code the site runs, and checks each answer against the tool results it was written from.
 *
 *   NVIDIA_API_KEY=... npm run eval:assistant -w web
 *   EVAL_URL=https://<deploy preview>/api/assistant npm run eval:assistant -w web
 *
 * The second form asks a deployed site's assistant instead, with the key that site already has.
 * A question the safety check turns down counts as a failure, since every sample question is an
 * ordinary store question. About 30 model calls, and a safety check on each question and answer. Prints a table, adds it to the GitHub job summary when there is one, and exits
 * non-zero when an answer fails a check. Without a key it says so and exits zero, so a fork's pull
 * request isn't marked failed.
 */
import { appendFileSync } from "node:fs";
import { DISTRICT_PEERS, runDay } from "@oiss/sim";
import { simulatePeerStore } from "../src/peers.ts";
import { SAMPLE_QUESTIONS } from "../src/assistant/agents.ts";
import { handleAssistant, type StepReply, type StepRequest } from "../src/assistant/proxy.ts";
import { handleForecast } from "../src/assistant/forecastProxy.ts";
import { httpForecast, type Forecaster } from "../src/assistant/forecast.ts";
import { ask, AssistantError, httpStep, type Step } from "../src/assistant/run.ts";
import { clock, indexDay } from "../src/day.ts";
import type { DayFiles } from "../src/load.ts";
import { checkAnswer, type Finding } from "./checks.ts";

const key = process.env.NVIDIA_API_KEY;
const url = process.env.EVAL_URL;
if (!key && !url) {
  console.log("::notice::NVIDIA_API_KEY isn't set, so the assistant eval didn't run.");
  process.exit(0);
}

const sim = runDay({ seed: 20261117, date: "2026-11-17" });
const files: DayFiles = { store: sim.records.storeLayout.oissstore, date: "2026-11-17", seed: 20261117, origin: "browser", records: sim.records as unknown as DayFiles["records"], itemMaster: sim.itemMaster, vendorFeeds: { mockLpAlerts: sim.vendorExports.mockLpAlerts } };
const day = indexDay(files);
const TIMES = [9, 13, 18].map((h) => h * 3600);
// The district's other stores, for questions that compare stores, simulated once as the page does in its workers.
const peers = DISTRICT_PEERS.map((p) => simulatePeerStore(p.id, "2026-11-17"));
const loadPeers = async () => peers;

interface Row {
  time: string;
  question: string;
  agent?: string;
  findings: Finding[];
  error?: string;
  text?: string;
  /** The safety check's verdicts, so a run shows whether the safety model answered at all. */
  safety?: string;
  proposals?: number;
  turnedDown?: number;
}

// The stock forecast goes to NVIDIA Kumo Relational the same way: in process, or through a deployed site.
let forecastNote = "";
const callForecast: Forecaster = url
  ? httpForecast(url.replace(/\/api\/assistant\/?$/, "/api/forecast"))
  : async (input) => {
      const res = await handleForecast(new Request("https://eval.invalid/api/forecast", { method: "POST", headers: { "content-type": "application/json", "x-nf-client-connection-ip": `eval-forecast-${n}` }, body: JSON.stringify(input) }), { key, forecast: process.env.NVIDIA_FORECAST });
      const body = (await res.json()) as { model: string; probabilities: (number | null)[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      return body;
    };
// What the forecast did, so a run shows whether Kumo answered at all.
const forecaster: Forecaster = async (input) => {
  try {
    const reply = await callForecast(input);
    forecastNote = `${reply.model} scored ${reply.probabilities.filter((p) => p !== null).length} of ${input.predict.length} facings from ${input.context.length} labeled rows`;
    return reply;
  } catch (err) {
    forecastNote = `failed: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  }
};

const rows: Row[] = [];
let n = 0;
for (const t of TIMES) {
  for (const question of SAMPLE_QUESTIONS) {
    n++;
    forecastNote = "";
    // The tool results the model last saw, which every fact in the answer has to come from.
    let toolText = "";
    const step: Step = async (req: StepRequest) => {
      if (req.step === "agent") toolText = req.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
      if (url) return httpStep(url)(req);
      // Each question looks like its own visitor, so the server's per-visitor limit doesn't trip.
      const res = await handleAssistant(new Request("https://eval.invalid/api/assistant", { method: "POST", headers: { "content-type": "application/json", "x-nf-client-connection-ip": `eval-${n}` }, body: JSON.stringify(req) }), { key, model: process.env.NVIDIA_MODEL, routerModel: process.env.NVIDIA_ROUTER_MODEL, safetyModel: process.env.NVIDIA_SAFETY_MODEL });
      const body = (await res.json()) as StepReply & { code?: string; error?: string };
      if (!res.ok) throw new AssistantError(body.code ?? "upstream", body.error ?? `HTTP ${res.status}`);
      return body;
    };
    try {
      // A model call that runs past the server's time limit says nothing about the answer, so it gets one more try.
      const a = await ask(day, t, question, step, undefined, loadPeers, forecaster).catch((err: unknown) => {
        if (err instanceof AssistantError && err.code === "timeout") {
          console.log(`        timed out once; asking again`);
          return ask(day, t, question, step, undefined, loadPeers, forecaster);
        }
        throw err;
      });
      const verdict = (c?: { verdict: string; model?: string }) => (c ? `${c.verdict}${c.model ? ` (${c.model})` : ""}` : "off");
      rows.push({ time: clock(t), question, agent: a.agent, findings: checkAnswer(a, toolText, question), text: a.text, safety: `question ${verdict(a.safety.question)}, answer ${verdict(a.safety.answer)}`, proposals: a.proposals.length, turnedDown: a.turnedDown.length });
    } catch (err) {
      rows.push({ time: clock(t), question, findings: [], error: err instanceof Error ? err.message : String(err) });
    }
    const r = rows.at(-1)!;
    console.log(`${r.error ? "ERROR" : r.findings.length ? "FAIL " : "pass "} ${r.time}  ${question}`);
    if (r.safety) console.log(`        safety: ${r.safety}; ${r.proposals} task(s) proposed, ${r.turnedDown ?? 0} turned down by the store's rules`);
    if (forecastNote) console.log(`        forecast: ${forecastNote}`);
    for (const f of r.findings) console.log(`        ${f.check}: ${f.detail}`);
    if (r.error) console.log(`        ${r.error}`);
    // A failed answer's own words, so the log shows what the check caught.
    if (r.findings.length && r.text) for (const line of r.text.split("\n")) console.log(`        | ${line}`);
  }
}

const failed = rows.filter((r) => r.error || r.findings.length);
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", "<br>");
const summary = [
  `## Assistant answer check: ${rows.length - failed.length} of ${rows.length} passed`,
  "",
  "| Time | Question | Agent | Safety | Proposed | Result |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.time} | ${cell(r.question)} | ${r.agent ?? ""} | ${r.safety ?? ""} | ${r.proposals ?? ""} | ${r.error ? `Error: ${cell(r.error)}` : r.findings.length ? cell(r.findings.map((f) => `${f.check}: ${f.detail}`).join("\n")) : "Pass"} |`),
  "",
  ...failed.filter((r) => r.text).flatMap((r) => [`<details><summary>${r.time}: ${cell(r.question)}</summary>`, "", r.text!, "", "</details>", ""]),
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
console.log(`\n${rows.length - failed.length} of ${rows.length} answers passed.`);
process.exit(failed.length ? 1 : 0);
