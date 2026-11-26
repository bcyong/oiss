import assert from "node:assert/strict";
import { test } from "node:test";
import { runDay } from "@oiss/sim";
import { approveTask, type Simulate } from "../src/approve.ts";
import { ask, PROPOSE_NUDGE } from "../src/assistant/run.ts";
import { ASSISTANT_CREATOR, decideTask, runTool } from "../src/assistant/tools.ts";
import type { StepReply, StepRequest } from "../src/assistant/proxy.ts";
import { indexDay, tasksAt } from "../src/day.ts";
import type { DayFiles } from "../src/load.ts";

// The golden day, and the simulator the way the page's worker runs it.
const simulate: Simulate = async (seed, date, injections, requestedTasks) => {
  const s = runDay({ seed, date, injections, requestedTasks });
  return { store: s.records.storeLayout.oissstore, date, seed, origin: "browser", records: s.records, itemMaster: s.itemMaster, vendorFeeds: { mockLpAlerts: s.vendorExports.mockLpAlerts }, ...(requestedTasks.length ? { requested: requestedTasks } : {}) };
};
const files: DayFiles = await simulate(20261117, "2026-11-17", [], []);
const day = indexDay(files);
const T = 13 * 3600;
// Low stock at 1 PM and not on promotion, so the store's task system raises no task for it itself.
const FACING = "A03-R-S4-F07";

test("the store's rules decide what may be proposed, from the records alone", () => {
  const ok = decideTask(day, T, "replenish", FACING, ["replenish", "go_back"]);
  assert.equal(ok.decision, "proposed");
  if (ok.decision !== "proposed") return;
  assert.equal(ok.proposal.facing, FACING);
  assert.match(ok.proposal.assignedTo, /^team:/);
  assert.ok(day.byId.has(ok.proposal.basedOn), "the proposal names the read that shows the need");

  const wrongKind = decideTask(day, T, "fix_shelf_tag", FACING, ["replenish", "go_back"]);
  assert.match(wrongKind.decision === "rejected" ? wrongKind.reason : "", /only replenish or go-back/i);
  assert.equal(decideTask(day, 2 * 3600, "replenish", FACING).decision, "rejected", "the store is closed at 2 AM");
  assert.equal(decideTask(day, T, "replenish", "Z99-X-S0-F00").decision, "rejected");
  assert.equal(decideTask(day, T, "go_back", FACING).decision, "rejected", "nothing is misplaced there");
});

test("a facing that already has an open task can't get a second one", () => {
  const t = 18 * 3600;
  const open = tasksAt(day, t).find(({ latest }) => latest.data.kind === "replenish" && ["open", "assigned", "in_progress"].includes(latest.data.state));
  assert.ok(open, "the golden day has a replenish task open at 6 PM");
  const d = decideTask(day, t, "replenish", open!.latest.data.location.facing!);
  assert.equal(d.decision, "rejected");
  assert.equal(d.decision === "rejected" && d.openTask, open!.latest.id);
});

test("approving a proposal raises the task now, and it's worked and verified, with every earlier record the same", async () => {
  const d = decideTask(day, T, "replenish", FACING);
  assert.equal(d.decision, "proposed");
  if (d.decision !== "proposed") return;
  const { files: next, result } = await approveTask(day, T, d.proposal, simulate);
  assert.equal(result.state, "approved");
  if (result.state !== "approved" || !next) return;
  const after = indexDay(next);
  const versions = next.records.tasks.filter((r) => r.subject === after.byId.get(result.taskId)!.subject);
  assert.equal(versions[0]!.data.createdBy, ASSISTANT_CREATOR);
  assert.equal(versions.at(-1)!.data.state, "verified");
  const cutoff = Date.parse(versions[0]!.time);
  const before = (rs: { time: string }[]) => JSON.stringify(rs.filter((r) => Date.parse(r.time) < cutoff));
  assert.equal(before(next.records.shelfObservations), before(files.records.shelfObservations));
  assert.equal(before(next.records.tasks), before(files.records.tasks));
  // Approving it again is turned down: the task is open now.
  const again = await approveTask(after, T + 60, d.proposal, simulate);
  assert.equal(again.result.state, "rejected");
  const openId = again.result.state === "rejected" ? again.result.openTask : undefined;
  assert.equal(openId && after.byId.get(openId)?.subject, after.byId.get(result.taskId)!.subject);
});

test("an answer gathers the tasks the agent proposed, checked by the store's rules, and raises none of them", async () => {
  const sent: StepRequest[] = [];
  const step = async (req: StepRequest): Promise<StepReply> => {
    sent.push(req);
    if (req.step === "route") return { message: { content: '{"agent":"availability"}' }, model: "nvidia/nemotron-3.5-lightning-30b-a3b", safety: { checked: "question", verdict: "safe", model: "nvidia/nemotron-3.5-content-safety" } };
    if (sent.filter((r) => r.step === "agent").length === 1)
      return {
        message: {
          content: null,
          tool_calls: [
            { id: "p1", type: "function", function: { name: "propose_task", arguments: JSON.stringify({ kind: "replenish", facing: FACING, reason: "Low stock" }) } },
            { id: "p2", type: "function", function: { name: "propose_task", arguments: JSON.stringify({ kind: "replenish", facing: FACING, reason: "Again" }) } },
            { id: "p3", type: "function", function: { name: "propose_task", arguments: JSON.stringify({ kind: "go_back", facing: FACING, reason: "Not misplaced" }) } },
          ],
        },
        model: "nvidia/nemotron-3-ultra-550b-a55b",
      };
    return { message: { content: "I proposed one replenishment task." }, model: "nvidia/nemotron-3-ultra-550b-a55b", safety: { checked: "answer", verdict: "safe" } };
  };
  const tasksBefore = files.records.tasks.length;
  const a = await ask(day, T, "Which low-stock items should we fill before they run out?", step);
  assert.deepEqual(
    a.proposals.map((p) => `${p.kind}:${p.facing}`),
    [`replenish:${FACING}`],
  );
  assert.equal(a.models.router, "nvidia/nemotron-3.5-lightning-30b-a3b");
  assert.equal(a.models.agent, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(a.safety.question?.verdict, "safe");
  assert.equal(a.safety.answer?.verdict, "safe");
  assert.equal(files.records.tasks.length, tasksBefore, "proposing raises nothing");
});

test("an agent that recommends shelf work in words but proposes none gets one turn to propose it, and its answer stays as written", async () => {
  const sent: StepRequest[] = [];
  const step = async (req: StepRequest): Promise<StepReply> => {
    sent.push(req);
    if (req.step === "route") return { message: { content: '{"agent":"availability"}' } };
    if (req.step === "agent" && req.messages.at(-1)?.content === PROPOSE_NUDGE)
      return { message: { content: null, tool_calls: [{ id: "n1", type: "function", function: { name: "propose_task", arguments: JSON.stringify({ kind: "replenish", facing: FACING, reason: "Low stock" }) } }] } };
    return { message: { content: "Fill the Aisle 3 facing first." } };
  };
  const a = await ask(day, T, "Which low-stock items should we fill before they run out?", step);
  assert.equal(a.text, "Fill the Aisle 3 facing first.");
  assert.deepEqual(a.proposals.map((p) => p.facing), [FACING]);
  assert.equal(sent.filter((r) => r.step === "agent").length, 2);

  // An agent that can't propose isn't asked to.
  const tagSent: StepRequest[] = [];
  const tagStep = async (req: StepRequest): Promise<StepReply> => {
    tagSent.push(req);
    return req.step === "route" ? { message: { content: '{"agent":"front_end"}' } } : { message: { content: "One more lane would help." } };
  };
  const b = await ask(day, T, "Do we need another lane open at the front end?", tagStep);
  assert.deepEqual(b.proposals, []);
  assert.equal(tagSent.filter((r) => r.step === "agent").length, 1);
});
