import { incidentsUpTo, lastAtOrBefore, latestObservation, LABEL_SOURCE_SUFFIX, ROBOT_SOURCE_SUFFIX, taskAt, tasksAt, zoneMetricAt, clock, secondsOf, type FacingView, type IndexedDay, type TaskView } from "../day.ts";
import { assigneeName, checkoutName, INCIDENT_LABEL, INCIDENT_STATUS, money, observer, STATUS_LABEL, TASK_KIND, TASK_STATE, zoneName } from "../describe.ts";
import { OPEN_LANE_WAIT_SECONDS } from "@oiss/sim";
import type { AnyRecord, IncidentData, OissRecord, ShelfObservationData, TaskData } from "../oiss.ts";
import { AGENTS, type AgentId, type ToolName } from "./agents.ts";

/**
 * The assistant's tools. Each one reads the day's OISS records as they stood at time t, the demo's
 * playback time, and returns a small JSON object in retail terms with the id of every record it drew on,
 * so the answer can cite them. None of them changes anything.
 *
 * Anything a manager acts on, such as a count, a status or a priority, is worked out here in code, and
 * the model only puts it into words. So where a status depends on comparing two records' times (a fix
 * marked done after a shelf read flagged it), the tool compares them and says so, and the model is
 * never left to infer it.
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
  return {
    id: r.id,
    kind: TASK_KIND[r.data.kind],
    state: TASK_STATE[r.data.state],
    title: r.data.title,
    assignedTo: assigneeName(r.data.assignedTo) || undefined,
    raised: clock(view.times[0]!),
    changed: clock(changedAt(view, t)),
    confirmedBy: r.data.verification?.verifiedBy,
  };
}

/** "assigned to Grocery team", or the state on its own. */
const stateWithTeam = (state: TaskData["state"], team?: string) => (state === "assigned" && team ? `assigned to ${team}` : TASK_STATE[state].toLowerCase());

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A task in a row about something else: just enough to cite it and say where it stands. */
const taskRef = (t?: ReturnType<typeof taskLine>) => t && { id: t.id, state: t.state, assignedTo: t.assignedTo, changed: t.changed };

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
  if (r.data.state === "cancelled") return { bucket: "cancelled", status: `Replenishment task cancelled at ${clock(at)}. ${NO_REASON}`, task };
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
  for (const { latest } of tasksAt(day, t)) {
    const st = latest.data.state;
    const bucket = OPEN_STATES.has(st) ? open : st === "verified" ? confirmed : st === "cancelled" ? cancelled : latest.data.verification?.required ? doneNotConfirmed : done;
    const k = TASK_KIND[latest.data.kind];
    bucket[k] = (bucket[k] ?? 0) + 1;
  }
  const incidents = incidentsUpTo(day.incidents, t);
  const reviews = { notReviewed: 0, reviewed: 0, reviewCancelled: 0 };
  for (const r of incidents) reviews[reviewOf(day, r, t).bucket]++;
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
    checkoutIncidents: incidents.length,
    checkoutIncidentReviews: reviews,
    staffedLanes: lane(front, staffedLaneCount(day)),
    selfCheckout: lane(sco, selfCheckoutCount(day)),
    note: "Shelf counts are from each facing's latest shelf read at this time. A task marked done is confirmed only when a later record shows the fix; some kinds, such as exception reviews, need no confirmation. Cancelled tasks' records don't say why.",
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
  const facings = rows.map(({ v, obs, at, from, gap }) => {
    const status = STATUS_LABEL[obs.data.status!];
    const rep = replenishment(day, v, t, gap, at, status);
    counts[rep.bucket]++;
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
    };
  });
  const what = want === "both" ? "out of stock or low" : STATUS_LABEL[want as "out_of_stock"].toLowerCase();
  const answer = [
    `${plural(rows.length, "facing is", "facings are")} ${what}${dept ? ` in ${dept.replaceAll("_", " ")}` : ""}.`,
    counts.noTask && `${counts.noTask} with no replenishment task since it was last in stock.`,
    counts.taskOpen && `${counts.taskOpen} with a replenishment task open.`,
    counts.doneNotConfirmed && `${counts.doneNotConfirmed} with replenishment marked done but not confirmed by a shelf read.`,
    counts.cancelled && `${counts.cancelled} whose replenishment task was cancelled; the records don't say why, so ask the team that had it before raising another.`,
  ].filter(Boolean).join(" ");
  return {
    answer,
    asked: { status: want, department: dept || undefined },
    total: rows.length,
    replenishment: counts,
    facings: facings.slice(0, n),
    note: "since: when the facing's current status began. notInStockSince: when it was last in stock. replenishment counts cover every facing listed in total, not only the rows shown.",
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
    note: "Done means an associate marked the task done. Verified means a later record confirmed the fix; confirmedBy names it. A cancelled task's record doesn't say why it was cancelled.",
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
  else if (r && at !== undefined) status = `Wrong on the shelf. Fix task cancelled at ${clock(at)}. ${NO_REASON}`;
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
    note: "wrongOnShelf: the latest read shows a price other than the register price and no fix has been marked done since. fixedWaitingForRead: an associate marked the fix done after the read that flagged it, and no read has confirmed it yet. fixesConfirmedToday: fixes a later robot read confirmed. The records don't say why a tag was wrong.",
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
      const status = OPEN_STATES.has(st) ? `${TASK_STATE[st]}: no lane opened yet.` : st === "verified" ? `Done, confirmed at ${at} by a front-end reading with another lane open.` : st === "done" ? `Marked done at ${at}; not yet confirmed by a front-end reading.` : `Cancelled at ${at}. ${NO_REASON}`;
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
function reviewOf(day: IndexedDay, inc: OissRecord<IncidentData>, t: number): { bucket: ReviewBucket; status: string; task?: ReturnType<typeof taskLine> } {
  const view = day.tasks.find((v) => v.versions[0]!.data.kind === "review_exception" && v.versions[0]!.data.basedOn?.includes(inc.id));
  const r = view && taskAt(view, t);
  if (!view || !r) return { bucket: "notReviewed", status: "Not reviewed yet. No review task yet." };
  const task = taskLine(day, view, t);
  const at = clock(changedAt(view, t));
  if (OPEN_STATES.has(r.data.state)) return { bucket: "notReviewed", status: `Not reviewed yet. Review task ${stateWithTeam(r.data.state, task?.assignedTo)}.`, task };
  if (r.data.state === "cancelled") return { bucket: "reviewCancelled", status: `Review task cancelled at ${at}. ${NO_REASON}`, task };
  return { bucket: "reviewed", status: `Reviewed: the review task was marked done at ${at}. The records don't say what the reviewer found.`, task };
}

function checkoutIncidents(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const sev = str(args.severity);
  const n = int(args.limit, 10);
  const list = incidentsUpTo(day.incidents, t)
    .filter((r) => !sev || r.data.severity === sev)
    .map((r) => ({ r, review: reviewOf(day, r, t) }))
    .reverse();
  const reviews: Record<ReviewBucket, number> = { notReviewed: 0, reviewed: 0, reviewCancelled: 0 };
  const byType: Record<string, number> = {};
  for (const { r, review } of list) {
    reviews[review.bucket]++;
    const type = INCIDENT_LABEL[r.data.incidentType] ?? r.data.incidentType;
    byType[type] = (byType[type] ?? 0) + 1;
  }
  // Those still waiting for a person come first.
  list.sort((a, b) => (a.review.bucket === "notReviewed" ? 0 : 1) - (b.review.bucket === "notReviewed" ? 0 : 1));
  return {
    answer: `${plural(list.length, "checkout exception", "checkout exceptions")} so far: ${reviews.notReviewed} not reviewed yet, ${reviews.reviewed} reviewed${reviews.reviewCancelled ? `, ${reviews.reviewCancelled} with the review cancelled` : ""}.`,
    total: list.length,
    reviews,
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
    note: "review is where the store's own review stands, from its review task. vendorStatus is the vendor's status on its incident record, which the store's review doesn't update. Every incident is a possible exception for a person to review, not a finding about anyone.",
  };
}

function getRecord(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const id = str(args.id);
  const r = day.byId.get(id) as AnyRecord | undefined;
  if (!r || secondsOf(day, r.time) > t) return { error: `No record ${id} has arrived by ${clock(t)}.` };
  if (r.type === "oiss.StoreLayout") return { id: r.id, type: r.type, note: "The store layout and planogram. Use the other tools for its facings." };
  if (r.oissprivacy === "restricted" && r.type !== "oiss.Incident") return { id: r.id, type: r.type, time: r.time, source: r.source, privacy: r.oissprivacy, note: "Restricted: only named roles may open this record's media." };
  if (r.type === "oiss.ShopperPath") return { id: r.id, type: r.type, time: r.time, privacy: r.oissprivacy, note: "An anonymous shopper path; its points are left out." };
  const { provenance, ...data } = r.data as unknown as { provenance: unknown } & Record<string, unknown>;
  return { id: r.id, type: r.type, time: r.time, source: r.source, subject: r.subject, privacy: r.oissprivacy, provenance, data };
}

const RUN: Record<ToolName, (day: IndexedDay, t: number, args: ToolArgs) => ToolResult> = {
  store_summary: (day, t) => storeSummary(day, t),
  shelf_gaps: shelfGaps,
  find_item: findItem,
  store_tasks: storeTasks,
  shelf_tag_issues: (day, t, args) => shelfTagIssues(day, t, args),
  front_end_status: frontEndStatus,
  zone_traffic: zoneTraffic,
  checkout_incidents: checkoutIncidents,
  get_record: getRecord,
};

/** Runs one tool for an agent. A tool the agent wasn't given, or bad arguments, come back as an error the model can read. */
export function runTool(day: IndexedDay, t: number, agent: AgentId, name: string, args: ToolArgs): ToolResult {
  if (!(AGENTS[agent].tools as string[]).includes(name)) return { error: `The ${AGENTS[agent].name} has no tool named ${name}.` };
  try {
    return RUN[name as ToolName](day, t, args ?? {});
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
