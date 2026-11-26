import type { Injection, RequestedTask } from "@oiss/sim";
import type { IndexedDay } from "./day.ts";
import type { DayFiles } from "./load.ts";
import type { OissRecord, TaskData } from "./oiss.ts";
import { ASSISTANT_CREATOR, decideTask, type Proposal } from "./assistant/tools.ts";

/**
 * The last steps of a proposed task, after the store manager approves it, the way NVIDIA's Multi-Agent
 * Intelligent Warehouse blueprint runs an agent's action: the agent proposed it, the store's rules check
 * it again against the records as they stand now, and only then does the store's task system raise it.
 * The day is played again from now with the task in it, so associates work it and a later shelf read
 * confirms the fix, like any other task. Every record sent before now stays the same.
 */

export type Approval = { state: "approved"; taskId: string; at: number } | { state: "rejected"; reason: string; openTask?: string; at: number };

/** Plays the day again: the page passes its web worker (simulateInBrowser), tests the simulator itself. */
export type Simulate = (seed: number, date: string, injections: Injection[], requested: RequestedTask[]) => Promise<DayFiles>;

export async function approveTask(day: IndexedDay, t: number, p: Proposal, simulate: Simulate): Promise<{ files?: DayFiles; result: Approval }> {
  const at = Math.floor(t);
  const d = decideTask(day, at, p.kind, p.facing);
  if (d.decision === "rejected") return { result: { state: "rejected", reason: d.reason, openTask: d.openTask, at } };
  const ask: RequestedTask = { kind: p.kind, facing: p.facing, t: at, basedOn: [d.proposal.basedOn], createdBy: ASSISTANT_CREATOR };
  const injections: Injection[] = (day.files.injected ?? []).map((f) => ({ kind: f.kind, facing: f.facing, t: f.start }));
  const files = await simulate(day.files.seed, day.files.date, injections, [...(day.files.requested ?? []), ask]);
  const raised = (files.records.tasks as OissRecord<TaskData>[]).find((r) => r.data.createdBy === ASSISTANT_CREATOR && r.data.kind === p.kind && r.data.location.facing === p.facing && r.data.state === "open" && Math.round((Date.parse(r.time) - day.midnightMs) / 1000) === at);
  const next = { ...files, origin: day.files.origin };
  if (!raised) return { files: next, result: { state: "rejected", reason: "The store's task system had already raised a task for this.", at } };
  return { files: next, result: { state: "approved", taskId: raised.id, at } };
}
