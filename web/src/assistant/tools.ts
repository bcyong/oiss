import { disagreementsUpTo, groupDisagreements, incidentsUpTo, lastAtOrBefore, latestObservation, LABEL_SOURCE_SUFFIX, ROBOT_SOURCE_SUFFIX, taskAt, tasksAt, zoneMetricAt, clock, secondsOf, type Disagreement, type FacingView, type IndexedDay, type TaskView } from "../day.ts";
import { assigneeName, checkoutName, INCIDENT_LABEL, INCIDENT_STATUS, money, observer, STATUS_LABEL, TASK_KIND, TASK_OUTCOME, TASK_STATE, zoneName } from "../describe.ts";
import { OPEN_LANE_WAIT_SECONDS, routeTask } from "@oiss/sim";
import type { AnyRecord, IncidentData, OissRecord, ShelfObservationData, TaskData } from "../oiss.ts";
import { effectivePrivacy } from "../versions.ts";
import { AGENTS, type AgentId, type ToolName } from "./agents.ts";

/**
 * The assistant's tools. Each one reads the day's OISS records as they stood at time t, the demo's
 * playback time, and returns a small JSON object in retail terms with the id of every record it drew on,
 * so the answer can cite them. None of them changes anything: propose_task only checks a task and
 * hands it to the page, which shows it to the store manager to approve.
 *
 * Anything a manager acts on, such as a count, a status or a priority, is worked out here in code, and
 * the model only puts it into words. So where a status depends on comparing two records' times (a fix
 * marked done after a shelf read flagged it), the tool compares them and says so, and the model is
 * never left to infer it.
 *
 * Owners come from the records too. A row about a task names the team it is assigned to, and a row
 * with no task yet names the team the store's task system routes that kind of work to (routedTo), so
 * the model can say who would act or find out without making up a role.
 */

export type ToolArgs = Record<string, unknown>;
export type ToolResult = Record<string, unknown>;

const int = (v: unknown, def: number, max = 25) => {
  const n = typeof v === "number" ? Math.floor(v) : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
};
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const OPEN_STATES = new Set(["open", "assigned", "in_progress"]);
const DONE_STATES = new Set(["done", "verified"]);
const NO_REASON = "The record doesn't say why.";

/** The team the store's task system routes a kind of work to, by name. */
const routedTo = (kind: TaskData["kind"], department?: string) => assigneeName(routeTask(kind as Parameters<typeof routeTask>[0], department));

/** How a task ended, from its resolution: "No backroom stock. The facing needs a store order." */
function outcomeText(d: TaskData): string | undefined {
  const r = d.resolution;
  return r && `${TASK_OUTCOME[r.outcome]}.${r.note ? ` ${r.note}` : ""}`;
}

/** Why a cancelled task was cancelled, from its resolution, or that the record doesn't say. */
const cancelReason = (d: TaskData) => outcomeText(d) ?? NO_REASON;

function itemOf(day: IndexedDay, v: FacingView) {
  const it = day.items.get(v.facing.gtin);
  return { item: it?.name ?? v.facing.gtin, gtin: v.facing.gtin, department: it?.department, promo: it?.promo || undefined, priceAtRegister: it ? money(it.price) : undefined };
}

function where(day: IndexedDay, v: FacingView) {
  return { facing: v.facing.id, fixture: v.fixture.id, zone: zoneName(day, v.zone) };
}

/** A store task as it stands at time t. A verified task names the later record that confirmed the fix. */
function taskLine(day: IndexedDay, view: TaskView, t: number) {
  const r = taskAt(view, t);
  if (!r) return undefined;
  const res = r.data.resolution;
  const assignedTo = assigneeName(r.data.assignedTo) || undefined;
  return {
    id: r.id,
    kind: TASK_KIND[r.data.kind],
    state: TASK_STATE[r.data.state],
    title: r.data.title,
    assignedTo,
    routedTo: assignedTo ? undefined : routedTo(r.data.kind, departmentAt(day, r.data.location.facing)),
    raised: clock(view.times[0]!),
    changed: clock(changedAt(view, t)),
    confirmedBy: r.data.verification?.verifiedBy,
    outcome: res && TASK_OUTCOME[res.outcome],
    outcomeNote: res?.note,
    resolvedBy: res?.resolvedBy && assigneeName(res.resolvedBy),
  };
}

/** The department of the item on a facing. */
function departmentAt(day: IndexedDay, facing?: string): string | undefined {
  const v = facing === undefined ? undefined : day.facings.find((f) => f.facing.id === facing);
  return v && day.items.get(v.facing.gtin)?.department;
}

/** "assigned to Grocery team", or the state on its own. */
const stateWithTeam = (state: TaskData["state"], team?: string) => (state === "assigned" && team ? `assigned to ${team}` : TASK_STATE[state].toLowerCase());

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A task in a row about something else: just enough to cite it and say where it stands. */
const taskRef = (t?: ReturnType<typeof taskLine>) => t && { id: t.id, state: t.state, assignedTo: t.assignedTo, routedTo: t.routedTo, changed: t.changed, outcome: t.outcome };

const changedAt = (view: TaskView, t: number) => view.times[lastAtOrBefore(view.times, t)]!;

/** The latest task of a kind on a facing raised at or after `from` and by t. */
function latestTask(day: IndexedDay, facing: string, kind: TaskData["kind"], from: number, t: number): TaskView | undefined {
  return (day.tasksByFacing.get(facing) ?? []).filter((view) => view.versions[0]!.data.kind === kind && view.times[0]! >= from && view.times[0]! <= t).at(-1);
}

/** When the facing was last seen in stock: the start of the unbroken run of reads that don't say in stock. */
function notInStockSince(v: FacingView, t: number): number | undefined {
  let i = lastAtOrBefore(v.statusTimes, t);
  if (i < 0) return undefined;
  while (i > 0 && v.statusObs[i - 1]!.data.status !== "in_stock") i--;
  return v.statusTimes[i];
}

type ReplenishBucket = "noTask" | "taskOpen" | "doneNotConfirmed" | "cancelled";

/** Where replenishment stands for a facing that isn't in stock, from the tasks raised since it last was. */
function replenishment(day: IndexedDay, v: FacingView, t: number, gapStart: number, lastRead: number, status: string): { bucket: ReplenishBucket; status: string; task?: ReturnType<typeof taskLine> } {
  const view = latestTask(day, v.facing.id, "replenish", gapStart, t);
  const r = view && taskAt(view, t);
  if (!view || !r) return { bucket: "noTask", status: "No replenishment task since the facing was last in stock." };
  const task = taskLine(day, view, t);
  const at = changedAt(view, t);
  if (OPEN_STATES.has(r.data.state)) return { bucket: "taskOpen", status: `Replenishment task ${stateWithTeam(r.data.state, task?.assignedTo)}.`, task };
  if (r.data.state === "cancelled") return { bucket: "cancelled", status: `Replenishment task cancelled at ${clock(at)}. ${cancelReason(r.data)}`, task };
  if (lastRead > at) return { bucket: "doneNotConfirmed", status: `Replenishment task marked done at ${clock(at)}, but a later shelf read still shows it ${status.toLowerCase()}.`, task };
  return { bucket: "doneNotConfirmed", status: `Replenishment task marked done at ${clock(at)}; no shelf read since to confirm it.`, task };
}

/** When the facing's current status began: the first of the unbroken run of observations ending at t that report it. */
function since(v: FacingView, t: number): number | undefined {
  let i = lastAtOrBefore(v.statusTimes, t);
  if (i < 0) return undefined;
  const st = v.statusObs[i]!.data.status;
  while (i > 0 && v.statusObs[i - 1]!.data.status === st) i--;
  return v.statusTimes[i];
}

function trafficByZone(day: IndexedDay, t: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const zone of day.zones.keys()) out.set(zone, zoneMetricAt(day, zone, t)?.data.metrics.traffic ?? 0);
  return out;
}

function storeSummary(day: IndexedDay, t: number): ToolResult {
  let outOfStock = 0;
  let lowStock = 0;
  let notReadable = 0;
  let notYetObserved = 0;
  for (const v of day.facings) {
    const st = latestObservation(v, t)?.data.status;
    if (st === "out_of_stock") outOfStock++;
    else if (st === "low_stock") lowStock++;
    else if (st === "unknown") notReadable++;
    else if (!st) notYetObserved++;
  }
  const open: Record<string, number> = {};
  const doneNotConfirmed: Record<string, number> = {};
  const confirmed: Record<string, number> = {};
  const done: Record<string, number> = {};
  const cancelled: Record<string, number> = {};
  const cancelledWhy: Record<string, number> = {};
  for (const { latest } of tasksAt(day, t)) {
    const st = latest.data.state;
    const bucket = OPEN_STATES.has(st) ? open : st === "verified" ? confirmed : st === "cancelled" ? cancelled : latest.data.verification?.required ? doneNotConfirmed : done;
    const k = TASK_KIND[latest.data.kind];
    bucket[k] = (bucket[k] ?? 0) + 1;
    if (st === "cancelled") {
      const why = latest.data.resolution ? TASK_OUTCOME[latest.data.resolution.outcome] : "Reason not given";
      cancelledWhy[why] = (cancelledWhy[why] ?? 0) + 1;
    }
  }
  const incidents = incidentsUpTo(day.incidents, t);
  const reviews = { notReviewed: 0, reviewed: 0, reviewCancelled: 0 };
  const reviewFindings: Record<string, number> = {};
  for (const r of incidents) {
    const review = reviewOf(day, r, t);
    reviews[review.bucket]++;
    if (review.finding) reviewFindings[review.finding] = (reviewFindings[review.finding] ?? 0) + 1;
  }
  const front = zoneMetricAt(day, "front-end", t);
  const sco = zoneMetricAt(day, "self-checkout", t);
  const lane = (r: typeof front, of: number) => r && { id: r.id, interval: intervalOf(day, r), inLine: r.data.metrics.queueLength, avgWaitSeconds: r.data.metrics.avgWaitSeconds, openLanes: r.data.metrics.openLanes, of };
  return {
    facings: day.facings.length,
    outOfStock,
    lowStock,
    notReadable,
    notYetObserved,
    openTasksByKind: open,
    doneNotYetConfirmedByKind: doneNotConfirmed,
    confirmedByKind: confirmed,
    doneNoConfirmationNeededByKind: done,
    cancelledByKind: cancelled,
    cancelledByReason: cancelledWhy,
    checkoutIncidents: incidents.length,
    checkoutIncidentReviews: reviews,
    checkoutIncidentFindings: reviewFindings,
    staffedLanes: lane(front, staffedLaneCount(day)),
    selfCheckout: lane(sco, selfCheckoutCount(day)),
    note: "Shelf counts are from each facing's latest shelf read at this time. A task marked done is confirmed only when a later record shows the fix; some kinds, such as exception reviews, need no confirmation. cancelledByReason gives the reason each cancelled task's record names. checkoutIncidentFindings are the reviewers' findings.",
  };
}

const intervalOf = (day: IndexedDay, r: { data: { window: { start: string; end: string } } }) => `${clock(secondsOf(day, r.data.window.start))} to ${clock(secondsOf(day, r.data.window.end))}`;
const staffedLaneCount = (day: IndexedDay) => day.layout.fixtures.filter((f) => f.kind === "checkout_lane").length;
const selfCheckoutCount = (day: IndexedDay) => day.layout.fixtures.filter((f) => /^sco-/.test(f.id)).length;

function shelfGaps(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const want = str(args.status) || "out_of_stock";
  const dept = str(args.department).toLowerCase().replaceAll(" ", "_").replace("&", "and");
  const n = int(args.limit, 10);
  const traffic = trafficByZone(day, t);
  const rows: { v: FacingView; obs: OissRecord<ShelfObservationData>; at: number; from: number; gap: number; score: number }[] = [];
  for (const v of day.facings) {
    const i = lastAtOrBefore(v.statusTimes, t);
    const obs = i < 0 ? undefined : v.statusObs[i];
    const st = obs?.data.status;
    if (!obs || !st) continue;
    if (!(want === "both" ? st === "out_of_stock" || st === "low_stock" : st === want)) continue;
    const it = day.items.get(v.facing.gtin);
    if (dept && it?.department !== dept && !it?.department.includes(dept) && !zoneName(day, v.zone).toLowerCase().includes(dept.replaceAll("_", " "))) continue;
    const from = since(v, t) ?? t;
    const gap = notInStockSince(v, t) ?? from;
    // Likely lost sales: a promoted item first, out of stock ahead of low stock, then how busy its zone is, then how long it has been short.
    const score = (it?.promo ? 1e6 : 0) + (st === "out_of_stock" ? 5e5 : 0) + (traffic.get(v.zone) ?? 0) * 100 + (t - gap) / 60;
    rows.push({ v, obs, at: v.statusTimes[i]!, from, gap, score });
  }
  rows.sort((a, b) => b.score - a.score);
  const counts: Record<ReplenishBucket, number> = { noTask: 0, taskOpen: 0, doneNotConfirmed: 0, cancelled: 0 };
  const cancelledWhy = new Map<string, number>();
  const facings = rows.map(({ v, obs, at, from, gap }) => {
    const status = STATUS_LABEL[obs.data.status!];
    const rep = replenishment(day, v, t, gap, at, status);
    counts[rep.bucket]++;
    if (rep.bucket === "cancelled") {
      const why = rep.task?.outcome ?? "Reason not given";
      cancelledWhy.set(why, (cancelledWhy.get(why) ?? 0) + 1);
    }
    return {
      ...itemOf(day, v),
      ...where(day, v),
      status,
      since: clock(from),
      notInStockSince: clock(gap),
      lastShelfRead: clock(at),
      reportedBy: observer(obs),
      record: obs.id,
      zoneTrafficLast15Min: traffic.get(v.zone),
      replenishment: rep.status,
      replenishmentTask: taskRef(rep.task),
      routedTo: rep.task ? undefined : routedTo("replenish", day.items.get(v.facing.gtin)?.department),
    };
  });
  const what = want === "both" ? "out of stock or low" : STATUS_LABEL[want as "out_of_stock"].toLowerCase();
  const answer = [
    `${plural(rows.length, "facing is", "facings are")} ${what}${dept ? ` in ${dept.replaceAll("_", " ")}` : ""}.`,
    counts.noTask && `${counts.noTask} with no replenishment task since it was last in stock.`,
    counts.taskOpen && `${counts.taskOpen} with a replenishment task open.`,
    counts.doneNotConfirmed && `${counts.doneNotConfirmed} with replenishment marked done but not confirmed by a shelf read.`,
    counts.cancelled && `${counts.cancelled} whose replenishment task was cancelled${cancelledWhy.size ? ` (${[...cancelledWhy].map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")})` : ""}.`,
  ].filter(Boolean).join(" ");
  return {
    answer,
    asked: { status: want, department: dept || undefined },
    total: rows.length,
    shown: Math.min(n, rows.length),
    notShown: Math.max(0, rows.length - n),
    replenishment: counts,
    facings: facings.slice(0, n),
    note: "since: when the facing's current status began. notInStockSince: when it was last in stock. replenishment counts cover every facing listed in total, not only the rows shown. replenishmentTask.assignedTo is the team that has the task; routedTo, on a row with no task, is the team the store's task system routes replenishment to for that department.",
  };
}

function lastFrom(v: FacingView, t: number, test: (r: OissRecord<ShelfObservationData>) => boolean) {
  for (let i = lastAtOrBefore(v.times, t); i >= 0; i--) if (test(v.obs[i]!)) return { r: v.obs[i]!, at: v.times[i]! };
  return undefined;
}

function report(day: IndexedDay, hit: { r: OissRecord<ShelfObservationData>; at: number } | undefined) {
  if (!hit) return undefined;
  const d = hit.r.data;
  return {
    record: hit.r.id,
    at: clock(hit.at),
    status: d.status && STATUS_LABEL[d.status],
    fillLevel: d.fillLevel,
    onFacing: d.observedGtin && d.observedGtin !== d.planogramGtin ? day.items.get(d.observedGtin)?.name ?? d.observedGtin : undefined,
    tagPrice: d.tagPrice && money(d.tagPrice),
    priceFile: d.systemPrice && money(d.systemPrice),
    flags: d.flags?.length ? d.flags : undefined,
  };
}

function statusNow(day: IndexedDay, v: FacingView, t: number) {
  const i = lastAtOrBefore(v.statusTimes, t);
  if (i < 0) return { status: STATUS_LABEL.none };
  const obs = v.statusObs[i]!;
  return { status: STATUS_LABEL[obs.data.status!], at: clock(v.statusTimes[i]!), reportedBy: observer(obs), record: obs.id };
}

function findItem(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const q = str(args.query).toLowerCase();
  if (!q) return { error: "Give part of an item name, a GTIN or a facing id." };
  const n = int(args.limit, 5, 10);
  const words = q.split(/\s+/).filter(Boolean);
  const matches = day.facings.filter((v) => {
    const name = (day.items.get(v.facing.gtin)?.name ?? "").toLowerCase();
    return v.facing.id.toLowerCase() === q || v.facing.gtin === q || words.every((w) => name.includes(w));
  });
  return {
    query: q,
    total: matches.length,
    facings: matches.slice(0, n).map((v) => ({
      ...itemOf(day, v),
      ...where(day, v),
      shelfStatusNow: statusNow(day, v, t),
      shelfTag: tagStatus(day, v, t)?.row ?? "No price problem in the latest reads.",
      robot: report(day, lastFrom(v, t, (r) => r.source.endsWith(ROBOT_SOURCE_SUFFIX))),
      shelfCamera: report(day, lastFrom(v, t, (r) => !!r.data.location.camera)),
      shelfLabels: report(day, lastFrom(v, t, (r) => r.source.endsWith(LABEL_SOURCE_SUFFIX))),
      tasks: (day.tasksByFacing.get(v.facing.id) ?? []).map((view) => taskLine(day, view, t)).filter(Boolean),
    })),
  };
}

function storeTasks(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const state = str(args.state) || "open";
  const kind = str(args.kind);
  const n = int(args.limit, 10);
  const list = tasksAt(day, t).filter(({ latest }) => (state === "all" || (state === "open") === OPEN_STATES.has(latest.data.state)) && (!kind || latest.data.kind === kind));
  const byState: Record<string, number> = {};
  for (const { latest } of list) byState[TASK_STATE[latest.data.state]] = (byState[TASK_STATE[latest.data.state]] ?? 0) + 1;
  return {
    asked: { state, kind: kind || undefined },
    total: list.length,
    byState,
    tasks: list.slice(0, n).map(({ view, latest }) => ({ ...taskLine(day, view, t)!, location: taskWhere(day, latest), basedOn: latest.data.basedOn })),
    note: "Done means an associate marked the task done. Verified means a later record confirmed the fix; confirmedBy names it. outcome is how the task ended: the reason a cancelled task was cancelled, or a review's finding. assignedTo is the team that has the task; an unassigned task gives routedTo, the team the store routes that kind of task to.",
  };
}

function taskWhere(day: IndexedDay, r: OissRecord<TaskData>): string {
  const l = r.data.location;
  if (l.facing) return `${zoneName(day, l.zone)}, ${l.facing}`;
  if (l.fixture) return checkoutName(l.fixture);
  return zoneName(day, l.zone);
}

type TagBucket = "wrongOnShelf" | "fixedWaitingForRead" | "flaggedAgainAfterFix";

/** Where a facing's shelf tag stands, when its latest robot tag read or its shelf label's latest report flags a price mismatch. */
function tagStatus(day: IndexedDay, v: FacingView, t: number): { bucket: TagBucket; row: ToolResult } | undefined {
  const robot = lastFrom(v, t, (r) => r.source.endsWith(ROBOT_SOURCE_SUFFIX) && !!r.data.tagPrice);
  const label = lastFrom(v, t, (r) => r.source.endsWith(LABEL_SOURCE_SUFFIX));
  const robotWrong = !!robot?.r.data.flags?.includes("price_mismatch");
  const labelWrong = !!label?.r.data.flags?.includes("price_mismatch");
  if (!robotWrong && !labelWrong) return undefined;
  const flaggedAt = Math.max(robotWrong ? robot!.at : -1, labelWrong ? label!.at : -1);
  const view = latestTask(day, v.facing.id, "fix_shelf_tag", -Infinity, t);
  const r = view && taskAt(view, t);
  const at = view && changedAt(view, t);
  let bucket: TagBucket = "wrongOnShelf";
  let status: string;
  if (r && at !== undefined && DONE_STATES.has(r.data.state) && at >= flaggedAt) {
    bucket = "fixedWaitingForRead";
    status = `Fix marked done at ${clock(at)}. Not yet confirmed: the robot hasn't read this tag since.`;
  } else if (r && at !== undefined && DONE_STATES.has(r.data.state)) {
    bucket = "flaggedAgainAfterFix";
    status = `Flagged again at ${clock(flaggedAt)}, after a fix marked done at ${clock(at)}.`;
  } else if (r && OPEN_STATES.has(r.data.state)) status = `Wrong on the shelf. Fix task ${TASK_STATE[r.data.state].toLowerCase()}.`;
  else if (r && at !== undefined) status = `Wrong on the shelf. Fix task cancelled at ${clock(at)}. ${cancelReason(r.data)}`;
  else status = "Wrong on the shelf. No fix task yet.";
  const register = day.items.get(v.facing.gtin)?.price;
  const tag = robotWrong ? robot!.r.data.tagPrice : label?.r.data.tagPrice;
  const robotTag = robot?.r.data.tagPrice?.amount;
  const labelShows = label?.r.data.tagPrice?.amount;
  return {
    bucket,
    row: {
      ...itemOf(day, v),
      ...where(day, v),
      status,
      flaggedBy: robotWrong && labelWrong ? "robot and shelf labels" : robotWrong ? "robot" : "shelf labels",
      flaggedAt: clock(flaggedAt),
      shelfTagVsRegister: tag && register ? (tag.amount < register.amount ? "tag lower than the register price" : "tag higher than the register price") : undefined,
      robotTagRead: robot && { record: robot.r.id, at: clock(robot.at), tagPrice: money(robot.r.data.tagPrice), flagged: robotWrong },
      shelfLabel: label && { record: label.r.id, at: clock(label.at), shows: money(label.r.data.tagPrice), flagged: labelWrong },
      robotAndLabelsDisagree: robotTag !== undefined && labelShows !== undefined && robotTag !== labelShows,
      fixTask: taskRef(view && taskLine(day, view, t)),
      routedTo: view ? undefined : routedTo("fix_shelf_tag"),
    },
  };
}

function shelfTagIssues(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const n = int(args.limit, 10);
  const counts: Record<TagBucket, number> = { wrongOnShelf: 0, fixedWaitingForRead: 0, flaggedAgainAfterFix: 0 };
  const rows: { bucket: TagBucket; row: ToolResult }[] = [];
  for (const v of day.facings) {
    const s = tagStatus(day, v, t);
    if (!s) continue;
    counts[s.bucket]++;
    rows.push(s);
  }
  const order: Record<TagBucket, number> = { wrongOnShelf: 0, flaggedAgainAfterFix: 1, fixedWaitingForRead: 2 };
  rows.sort((a, b) => order[a.bucket] - order[b.bucket]);
  const confirmedToday = tasksAt(day, t).filter(({ latest }) => latest.data.kind === "fix_shelf_tag" && latest.data.state === "verified").length;
  const parts = [`${plural(counts.wrongOnShelf, "shelf tag is", "shelf tags are")} wrong on the shelf now.`];
  if (counts.flaggedAgainAfterFix) parts.push(`${plural(counts.flaggedAgainAfterFix, "tag was", "tags were")} flagged again after a fix.`);
  if (counts.fixedWaitingForRead) parts.push(`${plural(counts.fixedWaitingForRead, "fix is", "fixes are")} marked done and waiting for the robot's next read to confirm.`);
  return {
    answer: parts.join(" "),
    counts: { ...counts, fixesConfirmedToday: confirmedToday },
    tags: rows.slice(0, n).map((r) => r.row),
    note: "wrongOnShelf: the latest read shows a price other than the register price and no fix has been marked done since. fixedWaitingForRead: an associate marked the fix done after the read that flagged it, and no read has confirmed it yet. fixesConfirmedToday: fixes a later robot read confirmed. A tag with no fix task gives routedTo, the team the store routes shelf tag fixes to. The records don't say why a tag was wrong.",
  };
}

function frontEndStatus(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const hours = typeof args.hours === "number" && args.hours > 0 ? Math.min(args.hours, 16) : 2;
  const series = (zone: string) => {
    const s = day.zoneSeries.get(zone);
    if (!s) return [];
    const out: ToolResult[] = [];
    for (let i = lastAtOrBefore(s.end, t); i >= 0 && s.end[i]! > t - hours * 3600; i--) {
      const r = s.recs[i]!;
      out.push({ id: r.id, interval: intervalOf(day, r), inLine: r.data.metrics.queueLength, avgWaitSeconds: r.data.metrics.avgWaitSeconds, openLanes: r.data.metrics.openLanes });
    }
    return out;
  };
  const staffed = staffedLaneCount(day);
  const latest = zoneMetricAt(day, "front-end", t);
  const laneTasks = tasksAt(day, t)
    .filter(({ latest }) => latest.data.kind === "open_lane")
    .slice(0, 5)
    .map(({ view, latest }) => {
      const at = clock(changedAt(view, t));
      const st = latest.data.state;
      const status = OPEN_STATES.has(st) ? `${TASK_STATE[st]}: no lane opened yet.` : st === "verified" ? `Done, confirmed at ${at} by a front-end reading with another lane open.` : st === "done" ? `Marked done at ${at}; not yet confirmed by a front-end reading.` : `Cancelled at ${at}. ${cancelReason(latest.data)}`;
      return { ...taskLine(day, view, t)!, status };
    });
  const m = latest?.data.metrics;
  const openTask = tasksAt(day, t).find(({ latest }) => latest.data.kind === "open_lane" && OPEN_STATES.has(latest.data.state));
  const openLaneNow = openTask && stateWithTeam(openTask.latest.data.state, assigneeName(openTask.latest.data.assignedTo));
  const meets = (m?.avgWaitSeconds ?? 0) >= OPEN_LANE_WAIT_SECONDS && (m?.openLanes ?? staffed) < staffed;
  return {
    answer: latest
      ? `${m?.openLanes} of ${staffed} staffed lanes open, ${m?.queueLength} in line, ${m?.avgWaitSeconds} s average wait (${intervalOf(day, latest)}). ${meets ? `That meets the store's rule for opening another staffed lane. ${openLaneNow ? `An open-lane task is ${openLaneNow.toLowerCase()}.` : "No open-lane task is open yet."}` : m?.openLanes === staffed ? "Every staffed lane is open." : "That is under the store's rule for opening another staffed lane."}`
      : "No front-end reading yet today.",
    hours,
    staffedLanesInStore: staffed,
    selfCheckoutStations: selfCheckoutCount(day),
    now: latest && { record: latest.id, interval: intervalOf(day, latest), inLine: m?.queueLength, avgWaitSeconds: m?.avgWaitSeconds, openLanes: m?.openLanes, of: staffed, meetsOpenLaneRule: meets },
    openLaneRule: `The store's task system raises "Open another staffed lane" when the average wait at the staffed lanes reaches ${OPEN_LANE_WAIT_SECONDS / 60} minutes and at least one staffed lane is closed.`,
    staffedLanes: series("front-end"),
    selfCheckout: series("self-checkout"),
    openLaneTasks: laneTasks,
    routedTo: meets && !openTask ? routedTo("open_lane") : undefined,
  };
}

function zoneTraffic(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const n = int(args.limit, 10);
  const rows = [...day.zones.values()]
    .map((z) => ({ z, r: zoneMetricAt(day, z.id, t) }))
    .filter(({ r }) => r && r.data.metrics.traffic !== undefined)
    .sort((a, b) => (b.r!.data.metrics.traffic ?? 0) - (a.r!.data.metrics.traffic ?? 0));
  return {
    note: "entered: shoppers who entered the zone during the interval. avgOccupancy: shoppers in the zone on average.",
    zones: rows.slice(0, n).map(({ z, r }) => ({ zone: z.name, id: r!.id, interval: intervalOf(day, r!), entered: r!.data.metrics.traffic, avgOccupancy: r!.data.metrics.avgOccupancy, avgDwellSeconds: r!.data.metrics.avgDwellSeconds })),
  };
}

type ReviewBucket = "notReviewed" | "reviewed" | "reviewCancelled";

/** Where the store's review of a checkout exception stands, from its review task. The vendor's incident record keeps the vendor's own status. */
function reviewOf(day: IndexedDay, inc: OissRecord<IncidentData>, t: number): { bucket: ReviewBucket; status: string; finding?: string; task?: ReturnType<typeof taskLine> } {
  const view = day.tasks.find((v) => v.versions[0]!.data.kind === "review_exception" && v.versions[0]!.data.basedOn?.includes(inc.id));
  const r = view && taskAt(view, t);
  if (!view || !r) return { bucket: "notReviewed", status: `Not reviewed yet. No review task yet; the store routes exception reviews to the ${routedTo("review_exception")}.` };
  const task = taskLine(day, view, t);
  const at = clock(changedAt(view, t));
  if (OPEN_STATES.has(r.data.state)) return { bucket: "notReviewed", status: `Not reviewed yet. Review task ${stateWithTeam(r.data.state, task?.assignedTo)}.`, task };
  if (r.data.state === "cancelled") return { bucket: "reviewCancelled", status: `Review task cancelled at ${at}. ${cancelReason(r.data)}`, task };
  const finding = outcomeText(r.data);
  return { bucket: "reviewed", finding: task?.outcome, status: finding ? `Reviewed at ${at}. Finding: ${finding}` : `Reviewed: the review task was marked done at ${at}. The records don't say what the reviewer found.`, task };
}

function checkoutIncidents(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const sev = str(args.severity);
  const n = int(args.limit, 10);
  const list = incidentsUpTo(day.incidents, t)
    .filter((r) => !sev || r.data.severity === sev)
    .map((r) => ({ r, review: reviewOf(day, r, t) }))
    .reverse();
  const reviews: Record<ReviewBucket, number> = { notReviewed: 0, reviewed: 0, reviewCancelled: 0 };
  const findings: Record<string, number> = {};
  const byType: Record<string, number> = {};
  for (const { r, review } of list) {
    reviews[review.bucket]++;
    if (review.finding) findings[review.finding] = (findings[review.finding] ?? 0) + 1;
    const type = INCIDENT_LABEL[r.data.incidentType] ?? r.data.incidentType;
    byType[type] = (byType[type] ?? 0) + 1;
  }
  // Those still waiting for a person come first.
  list.sort((a, b) => (a.review.bucket === "notReviewed" ? 0 : 1) - (b.review.bucket === "notReviewed" ? 0 : 1));
  return {
    answer: `${plural(list.length, "checkout exception", "checkout exceptions")} so far: ${reviews.notReviewed} not reviewed yet, ${reviews.reviewed} reviewed${Object.keys(findings).length ? ` (${Object.entries(findings).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")})` : ""}${reviews.reviewCancelled ? `, ${reviews.reviewCancelled} with the review cancelled` : ""}.`,
    total: list.length,
    reviews,
    reviewFindings: findings,
    byType,
    incidents: list.slice(0, n).map(({ r, review }) => ({
      id: r.id,
      at: clock(secondsOf(day, r.time)),
      type: INCIDENT_LABEL[r.data.incidentType] ?? r.data.incidentType,
      severity: r.data.severity,
      checkout: checkoutName(r.data.location.fixture),
      review: review.status,
      vendorStatus: INCIDENT_STATUS[r.data.status] ?? r.data.status,
      items: r.data.gtins?.map((g) => day.items.get(g)?.name ?? g),
      vendorSummary: r.data.summary,
      confidence: r.data.confidence,
      evidence: r.data.evidence?.map((id) => ({ id, retainUntil: day.evidence.get(id)?.data.retainUntil?.slice(0, 10) })),
      reviewTask: taskRef(review.task),
    })),
    note: "review is where the store's own review stands, and the reviewer's finding, from its review task. vendorStatus is the vendor's status on its incident record, which the store's review doesn't update. Every incident is a possible exception for a person to review; only the reviewer's finding says what happened.",
  };
}

/** Who raises a task the Store Operations Assistant proposed and the store manager approved. */
export const ASSISTANT_CREATOR = "agent:store-operations-assistant";

export type ProposalKind = "replenish" | "go_back" | "fix_shelf_tag";

/** The kinds of task each agent may propose. Loss prevention and the front end propose none. */
export const PROPOSAL_KINDS: Partial<Record<AgentId, ProposalKind[]>> = { availability: ["replenish", "go_back"], price_and_label: ["fix_shelf_tag"] };

export interface Proposal {
  kind: ProposalKind;
  facing: string;
  title: string;
  /** Team id, such as team:dairy, and its name. */
  assignedTo: string;
  team: string;
  /** The record that shows the facing needs the work. */
  basedOn: string;
  reason?: string;
}

export type Decision = { decision: "proposed"; proposal: Proposal } | { decision: "rejected"; reason: string; openTask?: string };

/**
 * Decides, in code and from the records alone, whether a task may go to the store manager: the facing
 * exists, the latest records show the work is needed, and no task for it is open or was just cancelled for
 * want of backroom stock. The model only asks; this decides. The page runs it again at approval, so a
 * task is never raised on records that have changed since it was proposed.
 */
export function decideTask(day: IndexedDay, t: number, kind: string, facing: string, allowed: readonly string[] = ["replenish", "go_back", "fix_shelf_tag"]): Decision {
  if (!allowed.includes(kind)) return { decision: "rejected", reason: `This agent can propose only ${allowed.map((k) => TASK_KIND[k as ProposalKind].toLowerCase()).join(" or ")} tasks.` };
  if (t < day.open || t >= day.close) return { decision: "rejected", reason: "The store is closed, so no shelf task can be raised now." };
  const v = day.facings.find((f) => f.facing.id === facing);
  if (!v) return { decision: "rejected", reason: `There is no facing ${facing || "with that id"}. Use a facing id from a tool result.` };
  const name = day.items.get(v.facing.gtin)?.name ?? facing;
  const open = (day.tasksByFacing.get(facing) ?? []).map((view) => ({ view, r: taskAt(view, t) })).find(({ r }) => r && r.data.kind === kind && OPEN_STATES.has(r.data.state));
  if (open) return { decision: "rejected", reason: `A ${TASK_KIND[kind as ProposalKind].toLowerCase()} task for ${name} is already ${TASK_STATE[open.r!.data.state].toLowerCase()}.`, openTask: open.r!.id };
  const obs = latestObservation(v, t);
  const latest = lastFrom(v, t, () => true);
  let basedOn: string | undefined;
  let title: string;
  if (kind === "replenish") {
    title = `Replenish ${name}`;
    const status = obs?.data.status;
    if (status !== "out_of_stock" && status !== "low_stock") return { decision: "rejected", reason: `The latest shelf read shows ${name} ${STATUS_LABEL[status ?? "none"].toLowerCase()}, so it needs no replenishment.` };
    const cancelled = latestTask(day, facing, "replenish", -Infinity, t);
    const last = cancelled && taskAt(cancelled, t);
    if (last?.data.state === "cancelled" && last.data.resolution?.outcome === "no_backroom_stock") return { decision: "rejected", reason: `The last replenishment task for ${name} was cancelled for no backroom stock. It needs a store order, not another task.` };
    basedOn = obs!.id;
  } else if (kind === "go_back") {
    title = `Clear a go-back from the ${name} facing`;
    if (!latest?.r.data.flags?.includes("misplaced_item")) return { decision: "rejected", reason: `The latest read of the ${name} facing shows no misplaced item.` };
    basedOn = latest.r.id;
  } else {
    title = `Fix the shelf tag for ${name}`;
    const tag = tagStatus(day, v, t);
    if (!tag || tag.bucket === "fixedWaitingForRead") return { decision: "rejected", reason: tag ? `The fix for ${name}'s shelf tag is marked done and waits for the robot's next read.` : `The latest reads show no price problem on ${name}'s shelf tag.` };
    const robot = tag.row.robotTagRead as { record: string; flagged: boolean } | undefined;
    const label = tag.row.shelfLabel as { record: string } | undefined;
    basedOn = (robot?.flagged ? robot.record : label?.record) ?? latest!.r.id;
  }
  const team = routeTask(kind as ProposalKind, day.items.get(v.facing.gtin)?.department);
  return { decision: "proposed", proposal: { kind: kind as ProposalKind, facing, title, assignedTo: team, team: assigneeName(team), basedOn } };
}

function proposeTask(day: IndexedDay, t: number, agent: AgentId, args: ToolArgs): ToolResult {
  const d = decideTask(day, t, str(args.kind), str(args.facing), PROPOSAL_KINDS[agent] ?? []);
  if (d.decision === "rejected") return { ...d, answer: `Not proposed: ${d.reason}` };
  const reason = str(args.reason).slice(0, 200) || undefined;
  return { decision: "proposed", proposal: { ...d.proposal, reason }, answer: `Proposed "${d.proposal.title}" for ${d.proposal.team}. It waits for the store manager to approve it on this page; nothing is raised until then.` };
}

function getRecord(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const id = str(args.id);
  const r = day.byId.get(id) as AnyRecord | undefined;
  if (!r || secondsOf(day, r.time) > t) return { error: `No record ${id} has arrived by ${clock(t)}.` };
  if (r.type === "oiss.StoreLayout") return { id: r.id, type: r.type, note: "The store layout and planogram. Use the other tools for its facings." };
  // A privacy class or record type the demo doesn't know counts as restricted (spec/versioning.md).
  const privacy = effectivePrivacy(r);
  if (privacy === "restricted" && r.type !== "oiss.Incident") return { id: r.id, type: r.type, time: r.time, source: r.source, privacy, note: "Restricted: only named roles may open this record's media." };
  if (r.type === "oiss.ShopperPath") return { id: r.id, type: r.type, time: r.time, privacy, note: "An anonymous shopper path; its points are left out." };
  const { provenance, ...data } = r.data as unknown as { provenance: unknown } & Record<string, unknown>;
  return { id: r.id, type: r.type, time: r.time, source: r.source, subject: r.subject, oissversion: r.oissversion, privacy, provenance, data };
}

// ---- store insights ---------------------------------------------------------------

const DISAGREEMENT_KINDS = ["availability", "misplaced_item", "price"] as const;
const DISAGREEMENT_LABEL: Record<Disagreement["kind"], string> = { availability: "availability", misplaced_item: "misplaced item", price: "shelf tag price" };

/** What each of two sources said about a facing, in a store team's words. */
function saidBy(d: Disagreement, r: OissRecord<ShelfObservationData>): string {
  if (d.kind === "price") return r.data.tagPrice ? `tag reads ${money(r.data.tagPrice)}` : "no tag price";
  if (d.kind === "misplaced_item") return r.data.flags?.includes("misplaced_item") ? "misplaced item on the facing" : "no misplaced item";
  return r.data.status ? STATUS_LABEL[r.data.status].toLowerCase() : "no status";
}

/** Which kind of source the other side of a disagreement is, as a vendor category. */
const sourceKind = (r: OissRecord<ShelfObservationData>) => (r.data.location.camera ? "shelf cameras" : r.source.endsWith(LABEL_SOURCE_SUFFIX) ? "electronic shelf labels" : observer(r));

function vendorDisagreements(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const n = int(args.limit, 10);
  const kind = (DISAGREEMENT_KINDS as readonly string[]).includes(str(args.kind)) ? (str(args.kind) as Disagreement["kind"]) : undefined;
  const groups = groupDisagreements(disagreementsUpTo(day, t)).filter((g) => !kind || g.latest.kind === kind);
  const counts = { standing: 0, settled: 0 };
  const byKind: Record<string, number> = {};
  const byPair: Record<string, number> = {};
  const rows = groups.map((g) => {
    const d = g.latest;
    const v = day.facings[d.facing]!;
    // A disagreement stands until the robot passes the facing again and no longer disagrees about it.
    const lastRobot = lastFrom(v, t, (r) => r.source.endsWith(ROBOT_SOURCE_SUFFIX));
    const standing = !lastRobot || lastRobot.r.id === d.robot.id;
    counts[standing ? "standing" : "settled"]++;
    byKind[DISAGREEMENT_LABEL[d.kind]] = (byKind[DISAGREEMENT_LABEL[d.kind]] ?? 0) + 1;
    const pair = `shelf-scanning robot vs ${sourceKind(d.other)}`;
    byPair[pair] = (byPair[pair] ?? 0) + 1;
    const item = itemOf(day, v);
    const register = day.items.get(v.facing.gtin)?.price.amount;
    const matches = (r: OissRecord<ShelfObservationData>) => r.data.tagPrice?.amount === register;
    return {
      standing,
      row: {
        about: DISAGREEMENT_LABEL[d.kind],
        ...item,
        ...where(day, v),
        robot: { says: saidBy(d, d.robot), at: clock(secondsOf(day, d.robot.time)), id: d.robot.id },
        other: { source: sourceKind(d.other), says: saidBy(d, d.other), at: clock(secondsOf(day, d.other.time)), id: d.other.id },
        matchesRegisterPrice: d.kind === "price" ? (matches(d.robot) ? "the robot's read" : matches(d.other) ? `the ${sourceKind(d.other)}` : "neither") : undefined,
        readToCheck: d.kind === "price" ? (matches(d.robot) ? `the ${sourceKind(d.other)}'s, which doesn't match the register price` : matches(d.other) ? "the robot's, which doesn't match the register price" : "both, since neither matches the register price") : undefined,
        since: clock(g.first),
        robotPasses: g.passes,
        status: standing ? "Still disagreeing: the robot hasn't passed the facing again since." : `Settled: the robot's later pass at ${clock(lastRobot!.at)} no longer disagrees.`,
        settledBy: standing ? undefined : lastRobot!.r.id,
        routedTo: routedTo(d.kind === "price" ? "fix_shelf_tag" : d.kind === "misplaced_item" ? "go_back" : "replenish", item.department),
      },
    };
  });
  rows.sort((a, b) => Number(b.standing) - Number(a.standing));
  const what = kind ? `${DISAGREEMENT_LABEL[kind]} disagreements` : "vendor disagreements";
  return {
    answer: groups.length ? `${plural(counts.standing, "facing still has", "facings still have")} ${kind ? `a ${DISAGREEMENT_LABEL[kind]} disagreement` : "a disagreement between two sources"}; ${counts.settled} more settled on the robot's next pass.` : `No ${what} so far today.`,
    counts: { ...counts, byKind, bySources: byPair },
    disagreements: rows.slice(0, n).map((r) => r.row),
    note: "Each pass of the shelf-scanning robot is checked against the latest report from the shelf cameras and the electronic shelf labels for the same facing; every vendor reports the same facing ids, so the check is a simple comparison. The records don't say which source is right or why two sources disagree, except for a shelf tag price, where matchesRegisterPrice says whose read matches the item master and readToCheck names the read to check. Don't guess beyond that: never say what is likely wrong or what likely needs fixing. Someone should look at a facing that is still disagreeing; routedTo is the team the store routes that kind of shelf work to.",
  };
}

/** One store's operating figures at time t, for comparing stores. */
export interface StoreCard {
  storeNumber: string;
  name: string;
  /** Share of facings read so far whose latest read isn't out of stock, in percent. */
  onShelfAvailabilityPct: number;
  outOfStock: number;
  lowStock: number;
  openReplenishmentTasks: number;
  replenishmentsCancelledNoBackroomStock: number;
  shelfTasksConfirmed: number;
  shelfTagsWrongOnShelf: number;
  /** Shoppers counted through the staffed lanes and self-checkout so far. */
  shoppersThroughCheckout: number;
  avgWaitSecondsSoFar: number;
  longestIntervalWaitSeconds: number;
  latestAvgWaitSeconds?: number;
  staffedLanesOpen?: number;
  staffedLanes: number;
  checkoutExceptions: number;
  checkoutExceptionsNotReviewed: number;
  vendorDisagreementsStanding: number;
  /** Record ids behind the figures, for the store whose records are on the page. */
  records?: Record<string, string>;
}

export function storeCard(day: IndexedDay, t: number): StoreCard {
  let outOfStock = 0;
  let lowStock = 0;
  let read = 0;
  for (const v of day.facings) {
    const st = latestObservation(v, t)?.data.status;
    if (!st || st === "unknown") continue;
    read++;
    if (st === "out_of_stock") outOfStock++;
    else if (st === "low_stock") lowStock++;
  }
  let openReplenishment = 0;
  let cancelledNoStock = 0;
  let confirmed = 0;
  for (const { latest } of tasksAt(day, t)) {
    const d = latest.data;
    if (d.kind === "replenish" && OPEN_STATES.has(d.state)) openReplenishment++;
    if (d.kind === "replenish" && d.state === "cancelled" && d.resolution?.outcome === "no_backroom_stock") cancelledNoStock++;
    if ((d.kind === "replenish" || d.kind === "go_back" || d.kind === "fix_shelf_tag") && d.state === "verified") confirmed++;
  }
  let tagsWrong = 0;
  for (const v of day.facings) if (tagStatus(day, v, t)?.bucket === "wrongOnShelf") tagsWrong++;
  const series = (zone: string) => {
    const s = day.zoneSeries.get(zone);
    return s ? s.recs.slice(0, lastAtOrBefore(s.end, t) + 1) : [];
  };
  const front = series("front-end");
  const sco = series("self-checkout");
  const waits = front.map((r) => r.data.metrics.avgWaitSeconds ?? 0);
  const incidents = incidentsUpTo(day.incidents, t);
  const disagreements = groupDisagreements(disagreementsUpTo(day, t)).filter((g) => lastFrom(day.facings[g.latest.facing]!, t, (r) => r.source.endsWith(ROBOT_SOURCE_SUFFIX))?.r.id === g.latest.robot.id).length;
  const latest = front.at(-1);
  return {
    storeNumber: day.layout.store.storeNumber,
    name: day.layout.store.name,
    onShelfAvailabilityPct: read ? Math.round((1000 * (read - outOfStock)) / read) / 10 : 100,
    outOfStock,
    lowStock,
    openReplenishmentTasks: openReplenishment,
    replenishmentsCancelledNoBackroomStock: cancelledNoStock,
    shelfTasksConfirmed: confirmed,
    shelfTagsWrongOnShelf: tagsWrong,
    shoppersThroughCheckout: [...front, ...sco].reduce((n, r) => n + (r.data.metrics.traffic ?? 0), 0),
    avgWaitSecondsSoFar: waits.length ? Math.round(waits.reduce((a, b) => a + b, 0) / waits.length) : 0,
    longestIntervalWaitSeconds: waits.length ? Math.max(...waits) : 0,
    latestAvgWaitSeconds: latest?.data.metrics.avgWaitSeconds,
    staffedLanesOpen: latest?.data.metrics.openLanes,
    staffedLanes: staffedLaneCount(day),
    checkoutExceptions: incidents.length,
    checkoutExceptionsNotReviewed: incidents.filter((r) => reviewOf(day, r, t).bucket === "notReviewed").length,
    vendorDisagreementsStanding: disagreements,
  };
}

/** Another store of the district: its figures every few minutes through its day, worked out where its records are. */
export interface PeerStore {
  id: string;
  storeNumber: string;
  name: string;
  /** Times of the cards, in seconds since store midnight, ascending. */
  times: number[];
  cards: StoreCard[];
}

/** Whether a higher figure is better, for the figures stores are ranked on. */
const RANKED: [keyof StoreCard, "higher" | "lower", string][] = [
  ["onShelfAvailabilityPct", "higher", "on-shelf availability"],
  ["outOfStock", "lower", "out-of-stock facings"],
  ["lowStock", "lower", "low-stock facings"],
  ["openReplenishmentTasks", "lower", "open replenishment tasks"],
  ["replenishmentsCancelledNoBackroomStock", "lower", "replenishments cancelled for no backroom stock"],
  ["shelfTasksConfirmed", "higher", "shelf tasks confirmed"],
  ["shelfTagsWrongOnShelf", "lower", "shelf tags wrong on the shelf"],
  ["shoppersThroughCheckout", "higher", "shoppers through checkout so far"],
  ["avgWaitSecondsSoFar", "lower", "average checkout wait so far"],
  ["checkoutExceptions", "lower", "checkout exceptions"],
  ["checkoutExceptionsNotReviewed", "lower", "checkout exceptions not yet reviewed"],
  ["vendorDisagreementsStanding", "lower", "facings where two vendors still disagree"],
];

/** The kind of task behind a store figure whose work goes to one team. Shelf figures span departments, so they name none. */
const ROUTED: Partial<Record<keyof StoreCard, TaskData["kind"]>> = {
  shelfTagsWrongOnShelf: "fix_shelf_tag",
  avgWaitSecondsSoFar: "open_lane",
  checkoutExceptions: "review_exception",
  checkoutExceptionsNotReviewed: "review_exception",
};

function compareStores(day: IndexedDay, t: number, peers: PeerStore[] | undefined): ToolResult {
  if (!peers?.length) return { error: "The other stores' figures aren't available right now, so this store can't be compared with them." };
  const own = storeCard(day, t);
  const front = zoneMetricAt(day, "front-end", t);
  const sco = zoneMetricAt(day, "self-checkout", t);
  const records: Record<string, string> = {};
  if (front) records.latestFrontEndMetric = front.id;
  if (sco) records.latestSelfCheckoutMetric = sco.id;
  const gaps = day.facings.map((v) => latestObservation(v, t)).filter((r) => r?.data.status === "out_of_stock");
  if (gaps[0]) records.sampleOutOfStockRead = gaps[0].id;
  const stores: (StoreCard & { thisStore?: true; asOf: string })[] = [{ ...own, thisStore: true, asOf: clock(t), records }];
  for (const p of peers) {
    const i = lastAtOrBefore(p.times, t);
    if (i >= 0) stores.push({ ...p.cards[i]!, asOf: clock(p.times[i]!) });
  }
  const ranks: Record<string, { thisStore: string; best?: string; worst?: string; allTied?: number; districtAverage: number; routedTo?: string }> = {};
  for (const [key, better, label] of RANKED) {
    const value = (c: StoreCard) => c[key] as number;
    const beats = (x: number, y: number) => (better === "higher" ? x > y : x < y);
    const mine = value(stores[0]!);
    const place = 1 + stores.filter((c) => beats(value(c), mine)).length;
    const tied = stores.filter((c) => value(c) === mine).length > 1;
    const values = stores.map(value);
    const top = better === "higher" ? Math.max(...values) : Math.min(...values);
    const bottom = better === "higher" ? Math.min(...values) : Math.max(...values);
    const named = (v: number) => `${stores.filter((c) => value(c) === v).map((c) => c.name).join("; ")} (${v})`;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const team = ROUTED[key] && routedTo(ROUTED[key]);
    ranks[label] = top === bottom ? { thisStore: `tied with every store`, allTied: top, districtAverage: top, routedTo: team } : { thisStore: `${place} of ${stores.length}${tied ? ", tied" : ""}`, best: named(top), worst: named(bottom), districtAverage: Math.round(avg * 10) / 10, routedTo: team };
  }
  return {
    asOf: clock(t),
    stores,
    ranks,
    note: `This store is ${own.name}; the others are the district's stores, built to the same prototype floor plan and planogram, so each figure compares like for like. Every figure comes from each store's own OISS records at the same time of day (each store's asOf). Only this store's records are on this page: cite its ids from records, and name the store for any other store's figure instead of citing an id. onShelfAvailabilityPct is the share of facings read so far whose latest read isn't out of stock. shoppersThroughCheckout counts shoppers through the staffed lanes and self-checkout so far. avgWaitSecondsSoFar averages the staffed lanes' 15-minute average waits since opening. The records don't say why one store differs from another; say so, and name what the figures point to. A figure's routedTo is the team the store routes that kind of work to; name a team only from a routedTo, and for a figure without one name none. Cite this store's figures with the ids in its records, such as latestFrontEndMetric for its checkout wait.`,
  };
}

/** What some tools need beyond the day: the other stores of the district, for compare_stores. */
export interface ToolContext {
  peers?: PeerStore[];
}

const RUN: Record<ToolName, (day: IndexedDay, t: number, args: ToolArgs, ctx: ToolContext) => ToolResult> = {
  store_summary: (day, t) => storeSummary(day, t),
  shelf_gaps: shelfGaps,
  find_item: findItem,
  store_tasks: storeTasks,
  shelf_tag_issues: (day, t, args) => shelfTagIssues(day, t, args),
  front_end_status: frontEndStatus,
  zone_traffic: zoneTraffic,
  checkout_incidents: checkoutIncidents,
  get_record: getRecord,
  vendor_disagreements: vendorDisagreements,
  compare_stores: (day, t, _args, ctx) => compareStores(day, t, ctx.peers),
  propose_task: () => ({}),
};

/** Runs one tool for an agent. A tool the agent wasn't given, or bad arguments, come back as an error the model can read. */
export function runTool(day: IndexedDay, t: number, agent: AgentId, name: string, args: ToolArgs, ctx: ToolContext = {}): ToolResult {
  if (!(AGENTS[agent].tools as string[]).includes(name)) return { error: `The ${AGENTS[agent].name} has no tool named ${name}.` };
  try {
    if (name === "propose_task") return proposeTask(day, t, agent, args ?? {});
    return RUN[name as ToolName](day, t, args ?? {}, ctx);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every record id that appears anywhere in a tool result, so an answer's citations can be checked. */
export function idsIn(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "string") {
    if (/^(so|zm|sp|ev|inc|task|ev-lp)-/.test(v)) out.add(v);
  } else if (Array.isArray(v)) v.forEach((x) => idsIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => idsIn(x, out));
  return out;
}
