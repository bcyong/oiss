import { disagreementsUpTo, groupDisagreements, incidentsUpTo, lastAtOrBefore, latestObservation, LABEL_SOURCE_SUFFIX, ROBOT_SOURCE_SUFFIX, taskAt, tasksAt, zoneMetricAt, clock, secondsOf, type FacingView, type IndexedDay, type TaskView } from "../day.ts";
import { assigneeName, checkoutName, INCIDENT_LABEL, INCIDENT_STATUS, money, observer, STATUS_LABEL, TASK_KIND, TASK_STATE, zoneName } from "../describe.ts";
import type { AnyRecord, OissRecord, ShelfObservationData, TaskData } from "../oiss.ts";
import { AGENTS, type AgentId, type ToolName } from "./agents.ts";

/**
 * The assistant's tools. Each one reads the day's OISS records as they stood at time t, the demo's
 * playback time, and returns a small JSON object in retail terms with the id of every record it drew on,
 * so the answer can cite them. None of them changes anything.
 */

export type ToolArgs = Record<string, unknown>;
export type ToolResult = Record<string, unknown>;

const int = (v: unknown, def: number, max = 25) => {
  const n = typeof v === "number" ? Math.floor(v) : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : def;
};
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

const OPEN_STATES = new Set(["open", "assigned", "in_progress"]);

function itemOf(day: IndexedDay, v: FacingView) {
  const it = day.items.get(v.facing.gtin);
  return { item: it?.name ?? v.facing.gtin, gtin: v.facing.gtin, department: it?.department, promo: it?.promo || undefined, price: it ? money(it.price) : undefined };
}

function where(day: IndexedDay, v: FacingView) {
  return { facing: v.facing.id, fixture: v.fixture.id, zone: zoneName(day, v.zone) };
}

function taskLine(day: IndexedDay, view: TaskView, t: number) {
  const r = taskAt(view, t);
  if (!r) return undefined;
  return { id: r.id, kind: TASK_KIND[r.data.kind], state: TASK_STATE[r.data.state], title: r.data.title, assignedTo: assigneeName(r.data.assignedTo) || undefined, changed: clock(view.times[lastAtOrBefore(view.times, t)]!), raised: clock(view.times[0]!) };
}

function openTasksFor(day: IndexedDay, facing: string, t: number) {
  return (day.tasksByFacing.get(facing) ?? []).filter((view) => OPEN_STATES.has(taskAt(view, t)?.data.state ?? "")).map((view) => taskLine(day, view, t)!);
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
  for (const v of day.facings) {
    const st = latestObservation(v, t)?.data.status;
    if (st === "out_of_stock") outOfStock++;
    else if (st === "low_stock") lowStock++;
  }
  const open: Record<string, number> = {};
  const closed: Record<string, number> = {};
  for (const { latest } of tasksAt(day, t)) {
    const bucket = OPEN_STATES.has(latest.data.state) ? open : closed;
    const k = TASK_KIND[latest.data.kind];
    bucket[k] = (bucket[k] ?? 0) + 1;
  }
  const incidents = incidentsUpTo(day.incidents, t);
  const front = zoneMetricAt(day, "front-end", t);
  const sco = zoneMetricAt(day, "self-checkout", t);
  const lane = (r: typeof front) => r && { id: r.id, interval: `${clock(secondsOf(day, r.data.window.start))} to ${clock(secondsOf(day, r.data.window.end))}`, inLine: r.data.metrics.queueLength, avgWaitSeconds: r.data.metrics.avgWaitSeconds, openLanes: r.data.metrics.openLanes };
  return {
    facings: day.facings.length,
    outOfStock,
    lowStock,
    openTasksByKind: open,
    closedTasksByKind: closed,
    checkoutIncidents: incidents.length,
    checkoutIncidentsOpen: incidents.filter((r) => r.data.status === "open" || r.data.status === "under_review").length,
    staffedLanes: lane(front),
    selfCheckout: lane(sco),
    note: "Counts are from each facing's latest shelf observation at this time.",
  };
}

function shelfGaps(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const want = str(args.status) || "out_of_stock";
  const dept = str(args.department).toLowerCase().replaceAll(" ", "_").replace("&", "and");
  const n = int(args.limit, 10);
  const traffic = trafficByZone(day, t);
  const rows: { v: FacingView; obs: OissRecord<ShelfObservationData>; from: number; score: number }[] = [];
  for (const v of day.facings) {
    const obs = latestObservation(v, t);
    const st = obs?.data.status;
    if (!obs || !st) continue;
    if (!(want === "both" ? st === "out_of_stock" || st === "low_stock" : st === want)) continue;
    const it = day.items.get(v.facing.gtin);
    if (dept && it?.department !== dept && !it?.department.includes(dept) && !zoneName(day, v.zone).toLowerCase().includes(dept.replaceAll("_", " "))) continue;
    const from = since(v, t) ?? t;
    // Likely lost sales: a promoted item first, then how busy its zone is, then how long it has been empty.
    const score = (it?.promo ? 1e6 : 0) + (traffic.get(v.zone) ?? 0) * 100 + (st === "out_of_stock" ? 5e5 : 0) + (t - from) / 60;
    rows.push({ v, obs, from, score });
  }
  rows.sort((a, b) => b.score - a.score);
  return {
    asked: { status: want, department: dept || undefined },
    total: rows.length,
    facings: rows.slice(0, n).map(({ v, obs, from }) => ({
      ...itemOf(day, v),
      ...where(day, v),
      status: STATUS_LABEL[obs.data.status!],
      since: clock(from),
      reportedBy: observer(obs),
      record: obs.id,
      zoneTrafficLast15Min: traffic.get(v.zone),
      openTasks: openTasksFor(day, v.facing.id, t),
    })),
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
  return {
    asked: { state, kind: kind || undefined },
    total: list.length,
    tasks: list.slice(0, n).map(({ view, latest }) => ({ ...taskLine(day, view, t)!, location: taskWhere(day, latest), basedOn: latest.data.basedOn })),
  };
}

function taskWhere(day: IndexedDay, r: OissRecord<TaskData>): string {
  const l = r.data.location;
  if (l.facing) return `${zoneName(day, l.zone)}, ${l.facing}`;
  if (l.fixture) return checkoutName(l.fixture);
  return zoneName(day, l.zone);
}

function shelfTagIssues(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const n = int(args.limit, 10);
  const rows: ToolResult[] = [];
  for (const v of day.facings) {
    const robot = lastFrom(v, t, (r) => r.source.endsWith(ROBOT_SOURCE_SUFFIX) && !!r.data.tagPrice);
    const label = lastFrom(v, t, (r) => r.source.endsWith(LABEL_SOURCE_SUFFIX));
    const robotWrong = robot?.r.data.flags?.includes("price_mismatch");
    const labelWrong = label?.r.data.flags?.includes("price_mismatch");
    if (!robotWrong && !labelWrong) continue;
    const tagTasks = (day.tasksByFacing.get(v.facing.id) ?? []).filter((view) => view.versions[0]!.data.kind === "fix_shelf_tag");
    const latestTask = tagTasks.map((view) => taskLine(day, view, t)).filter(Boolean).at(-1);
    rows.push({ ...itemOf(day, v), ...where(day, v), robotRead: report(day, robot), shelfLabelReport: report(day, label), fixTask: latestTask, sources: robotWrong && labelWrong ? "both" : robotWrong ? "robot only" : "shelf labels only" });
  }
  // A disagreement still stands while the robot's latest tag read and the labels' latest report differ.
  const groups = groupDisagreements(disagreementsUpTo(day, t).filter((d) => d.kind === "price")).map((g) => {
    const v = day.facings[g.latest.facing]!;
    const robot = lastFrom(v, t, (r) => r.source.endsWith(ROBOT_SOURCE_SUFFIX) && !!r.data.tagPrice);
    const label = lastFrom(v, t, (r) => r.source.endsWith(LABEL_SOURCE_SUFFIX));
    const stands = !!robot && !!label && robot.r.data.tagPrice?.amount !== label.r.data.tagPrice?.amount;
    return { stands, row: { ...itemOf(day, v), facing: v.facing.id, robotTag: money(g.latest.robot.data.tagPrice), shelfLabel: money(g.latest.other.data.tagPrice), robotRecord: g.latest.robot.id, labelRecord: g.latest.other.id, first: clock(g.first), robotPasses: g.passes, latestRobotRead: robot && { record: robot.r.id, at: clock(robot.at), tagPrice: money(robot.r.data.tagPrice) } } };
  });
  return {
    wrongTagsNow: rows.length,
    tags: rows.slice(0, n),
    robotVsLabelDisagreementsStanding: groups.filter((g) => g.stands).slice(0, n).map((g) => g.row),
    robotVsLabelDisagreementsSettled: groups.filter((g) => !g.stands).length,
    note: "A settled disagreement is one where the robot's later reads match the shelf labels again.",
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
      out.push({ id: r.id, ends: clock(s.end[i]!), inLine: r.data.metrics.queueLength, avgWaitSeconds: r.data.metrics.avgWaitSeconds, openLanes: r.data.metrics.openLanes });
    }
    return out;
  };
  const laneTasks = tasksAt(day, t)
    .filter(({ latest }) => latest.data.kind === "open_lane")
    .slice(0, 5)
    .map(({ view }) => taskLine(day, view, t));
  return { hours, staffedLanes: series("front-end"), selfCheckout: series("self-checkout"), openLaneTasks: laneTasks };
}

function zoneTraffic(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const n = int(args.limit, 10);
  const rows = [...day.zones.values()]
    .map((z) => ({ z, r: zoneMetricAt(day, z.id, t) }))
    .filter(({ r }) => r && r.data.metrics.traffic !== undefined)
    .sort((a, b) => (b.r!.data.metrics.traffic ?? 0) - (a.r!.data.metrics.traffic ?? 0));
  return {
    zones: rows.slice(0, n).map(({ z, r }) => ({ zone: z.name, id: r!.id, interval: `${clock(secondsOf(day, r!.data.window.start))} to ${clock(secondsOf(day, r!.data.window.end))}`, entered: r!.data.metrics.traffic, avgOccupancy: r!.data.metrics.avgOccupancy, avgDwellSeconds: r!.data.metrics.avgDwellSeconds })),
  };
}

function checkoutIncidents(day: IndexedDay, t: number, args: ToolArgs): ToolResult {
  const sev = str(args.severity);
  const n = int(args.limit, 10);
  const reviewTask = new Map<string, TaskView>();
  for (const view of day.tasks) for (const id of view.versions[0]!.data.basedOn ?? []) if (id.startsWith("inc-")) reviewTask.set(id, view);
  const list = incidentsUpTo(day.incidents, t)
    .filter((r) => !sev || r.data.severity === sev)
    .reverse();
  return {
    total: list.length,
    incidents: list.slice(0, n).map((r) => {
      const task = reviewTask.get(r.id);
      return {
        id: r.id,
        at: clock(secondsOf(day, r.time)),
        type: INCIDENT_LABEL[r.data.incidentType] ?? r.data.incidentType,
        severity: r.data.severity,
        checkout: checkoutName(r.data.location.fixture),
        status: INCIDENT_STATUS[r.data.status] ?? r.data.status,
        items: r.data.gtins?.map((g) => day.items.get(g)?.name ?? g),
        vendorSummary: r.data.summary,
        confidence: r.data.confidence,
        evidence: r.data.evidence?.map((id) => ({ id, retainUntil: day.evidence.get(id)?.data.retainUntil?.slice(0, 10) })),
        reviewTask: task && taskLine(day, task, t),
      };
    }),
    note: "Every incident is a possible exception for a person to review, not a finding about anyone.",
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
