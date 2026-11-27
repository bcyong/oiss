/**
 * Asks the assistant the sample questions at three times on the golden day, through the same server
 * code the site runs, and checks each answer against the tool results it was written from.
 *
 *   NVIDIA_API_KEY=... npm run eval:assistant -w web
 *   EVAL_URL=https://<deploy preview>/api/assistant npm run eval:assistant -w web
 *
 * The second form asks a deployed site's assistant instead, with the key that site already has.
 * A question the safety check turns down counts as a failure, since every sample question is an
 * ordinary store question. The model words each answer a little differently from run to run, so an answer that
 * fails a check is asked once more, and the question counts as passed if the second answer passes; the log and
 * the job summary still show every first-try miss. About 30 model calls, and a safety check on each question and answer. Prints a table, adds it to the GitHub job summary when there is one, and exits
 * non-zero when an answer fails a check. Without a key it says so and exits zero, so a fork's pull
 * request isn't marked failed.
 */
import { appendFileSync } from "node:fs";
import { DISTRICT_PEERS, runDay } from "@oiss/sim";
import { simulatePeerStore } from "../src/peers.ts";
import { SAMPLE_QUESTIONS } from "../src/assistant/agents.ts";
import { handleAssistant, type StepReply, type StepRequest } from "../src/assistant/proxy.ts";
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
  /** What the first answer failed on, when it took a second try. */
  firstTry?: string;
}

const rows: Row[] = [];
let n = 0;
for (const t of TIMES) {
  for (const question of SAMPLE_QUESTIONS) {
    n++;
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
    const attempt = async (): Promise<Row> => {
      try {
        // A model call that runs past the server's time limit says nothing about the answer, so it gets one more try.
        const a = await ask(day, t, question, step, undefined, loadPeers).catch((err: unknown) => {
          if (err instanceof AssistantError && err.code === "timeout") {
            console.log(`        timed out once; asking again`);
            return ask(day, t, question, step, undefined, loadPeers);
          }
          throw err;
        });
        const verdict = (c?: { verdict: string; model?: string }) => (c ? `${c.verdict}${c.model ? ` (${c.model})` : ""}` : "off");
        return { time: clock(t), question, agent: a.agent, findings: checkAnswer(a, toolText, question), text: a.text, safety: `question ${verdict(a.safety.question)}, answer ${verdict(a.safety.answer)}`, proposals: a.proposals.length, turnedDown: a.turnedDown.length };
      } catch (err) {
        return { time: clock(t), question, findings: [], error: err instanceof Error ? err.message : String(err) };
      }
    };
    let row = await attempt();
    // An answer that fails a check gets one more try, since the model words it differently each time. A safety
    // refusal or a server error isn't retried here: those say something about the setup, not the wording.
    if (!row.error && row.findings.length) {
      const miss = row.findings.map((f) => `${f.check}: ${f.detail}`).join("; ");
      console.log(`retry ${row.time}  ${question}`);
      console.log(`        first answer failed: ${miss}`);
      if (row.text) for (const line of row.text.split("\n")) console.log(`        | ${line}`);
      row = { ...(await attempt()), firstTry: miss };
    }
    rows.push(row);
    const r = rows.at(-1)!;
    console.log(`${r.error ? "ERROR" : r.findings.length ? "FAIL " : "pass "} ${r.time}  ${question}${r.firstTry && !r.findings.length ? " (on the second try)" : ""}`);
    if (r.safety) console.log(`        safety: ${r.safety}; ${r.proposals} task(s) proposed, ${r.turnedDown ?? 0} turned down by the store's rules`);
    for (const f of r.findings) console.log(`        ${f.check}: ${f.detail}`);
    if (r.error) console.log(`        ${r.error}`);
    // A failed answer's own words, so the log shows what the check caught.
    if (r.findings.length && r.text) for (const line of r.text.split("\n")) console.log(`        | ${line}`);
  }
}

const failed = rows.filter((r) => r.error || r.findings.length);
const retried = rows.filter((r) => r.firstTry);
const cell = (s: string) => s.replaceAll("|", "\\|").replaceAll("\n", "<br>");
const summary = [
  `## Assistant answer check: ${rows.length - failed.length} of ${rows.length} passed${retried.length ? `, ${retried.length} after a second try` : ""}`,
  "",
  "| Time | Question | Agent | Safety | Proposed | Result |",
  "| --- | --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.time} | ${cell(r.question)} | ${r.agent ?? ""} | ${r.safety ?? ""} | ${r.proposals ?? ""} | ${r.error ? `Error: ${cell(r.error)}` : r.findings.length ? cell(r.findings.map((f) => `${f.check}: ${f.detail}`).join("\n")) : r.firstTry ? `Pass on the second try (first: ${cell(r.firstTry)})` : "Pass"} |`),
  "",
  ...failed.filter((r) => r.text).flatMap((r) => [`<details><summary>${r.time}: ${cell(r.question)}</summary>`, "", r.text!, "", "</details>", ""]),
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
console.log(`\n${rows.length - failed.length} of ${rows.length} answers passed${retried.length ? `, ${retried.length} of them on a second try` : ""}.`);
process.exit(failed.length ? 1 : 0);
