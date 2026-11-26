/**
 * Store tasks: the retailer's own task management system raising work from OISS records and
 * following it through to a fix.
 *
 * Tasks are raised only from what the records say, the way a task system that reads OISS would:
 * - replenish: a facing reported out of stock, or a promoted item reported low.
 * - go_back: a misplaced item reported on a facing.
 * - fix_shelf_tag: a shelf tag price that doesn't match the price file.
 * - review_exception: a checkout Incident from loss prevention, for a person to review.
 * - open_lane: front-end waits of three minutes or more with staffed lanes still closed.
 *
 * What the associates do comes from the ground truth: a facing is restocked in a recovery round,
 * a go-back is cleared, a tag is fixed, a lane opens. That marks the task done. A task that needs
 * verification closes only when a later record shows the fix, and names that record.
 *
 * Each status change is a new Task record with the same subject (spec/record-types.md).
 */
import type { Department } from "./layout.ts";
import type { Ground } from "./model.ts";
import { idMaker, type OissRecord, type Provenance, record } from "./records.ts";
import { Rng } from "./rng.ts";

export type TaskKind = "replenish" | "go_back" | "fix_shelf_tag" | "review_exception" | "open_lane";
type TaskState = "open" | "assigned" | "in_progress" | "done" | "verified" | "cancelled";

const PROV: Provenance = { system: "Demo Grocery task management", synthetic: true };
const CREATED_BY = "system:task-management";

/** Waits at or above this, with a staffed lane still closed, raise an open_lane task. */
export const OPEN_LANE_WAIT_SECONDS = 180;
/** An open_lane task no lane answers within this long is cancelled: the rush has passed. */
const OPEN_LANE_TIMEOUT = 30 * 60;
/** Seconds from the record to the task, and from the task to its assignment. */
const RAISE_DELAY = 30;
const ASSIGN_DELAY = 60;

const TEAM: Partial<Record<Department, string>> = {
  produce: "team:produce",
  dairy: "team:dairy",
  bakery: "team:bakery",
  deli: "team:deli",
  frozen: "team:frozen",
  meat_and_seafood: "team:meat",
};

interface Step {
  t: number;
  state: TaskState;
  verifiedBy?: string;
}

interface Plan {
  kind: TaskKind;
  title: string;
  location: Record<string, string>;
  assignedTo: string;
  basedOn: string[];
  verify: boolean;
  steps: Step[];
}

type Obs = OissRecord<{
  window: { end: string };
  location: Record<string, string>;
  status?: string;
  flags?: string[];
  tagPrice?: { amount: number };
}>;

/** Where on a facing the work is, without the camera that saw it. */
const facingLocation = (loc: Record<string, string>) => {
  const { camera: _camera, point: _point, ...rest } = loc as Record<string, string> & { point?: unknown };
  return rest;
};

const EXCEPTION: Record<string, string> = { non_scan: "non-scan", ticket_switching: "ticket switch", bottom_of_basket: "bottom-of-basket miss", sweethearting: "sweethearting" };

/** lane-06 -> Lane 6, sco-02 -> self-checkout 2. */
function laneName(id: string): string {
  const m = /^(lane|sco)-0*(\d+)$/.exec(id);
  if (!m) return id || "the front end";
  return m[1] === "lane" ? `Lane ${m[2]}` : `self-checkout ${m[2]}`;
}

export function storeTasks(g: Ground, shelfObservations: OissRecord[], zoneMetrics: OissRecord[], incidents: OissRecord[]): OissRecord[] {
  const { clock, catalog, layout } = g;
  const store = layout.store.id;
  const last = 86_399;
  const sec = (iso: string) => (Date.parse(iso) - clock.epochMs(0)) / 1000;
  const fixtureDept = new Map(layout.fixtures.map((f) => [f.id, f.department]));
  const slotFixture = new Map(layout.slots.map((s) => [s.id, s.fixture]));
  const teamFor = (facing: string) => {
    const dept = fixtureDept.get(slotFixture.get(facing) ?? "");
    return (dept && TEAM[dept]) || "team:grocery";
  };
  const itemAt = (facing: string) => {
    const pos = catalog.byFacing.get(facing);
    return pos ? catalog.byGtin.get(pos.gtin) : undefined;
  };
  const plans: Plan[] = [];
  const recovery = new Map<string, Ground["recoveryWork"]>();
  for (const w of g.recoveryWork) recovery.set(w.facing, [...(recovery.get(w.facing) ?? []), w]);

  // ---- shelf work, facing by facing ----
  const byFacing = new Map<string, { t: number; r: Obs }[]>();
  for (const r of shelfObservations as Obs[]) {
    const f = r.data.location.facing;
    if (!f) continue;
    const list = byFacing.get(f) ?? [];
    list.push({ t: sec(r.data.window.end), r });
    byFacing.set(f, list);
  }
  for (const [facing, list] of [...byFacing].sort(([a], [b]) => (a < b ? -1 : 1))) {
    list.sort((a, b) => a.t - b.t || (a.r.id < b.r.id ? -1 : 1));
    const item = itemAt(facing);
    const name = item?.name ?? facing;
    const busyUntil: Record<"replenish" | "go_back" | "fix_shelf_tag", number> = { replenish: -1, go_back: -1, fix_shelf_tag: -1 };

    for (const { t, r } of list) {
      const flags = r.data.flags ?? [];
      const raise = (kind: keyof typeof busyUntil, title: string, done: number | undefined, verifiedBy: (after: number) => { t: number; id: string } | undefined, cancelled?: number) => {
        if (t <= busyUntil[kind]) return;
        const created = t + RAISE_DELAY;
        const steps: Step[] = [
          { t: created, state: "open" },
          { t: created + ASSIGN_DELAY, state: "assigned" },
        ];
        let end = Infinity;
        if (cancelled !== undefined && cancelled < last) {
          steps.push({ t: Math.max(cancelled, created + ASSIGN_DELAY + 1), state: "cancelled" });
          // No backroom stock: only a store order fixes it, so the facing gets no more replenish tasks today.
          end = Infinity;
        } else if (done !== undefined && done < last) {
          const doneAt = Math.max(done, created + ASSIGN_DELAY + 1);
          steps.push({ t: doneAt, state: "done" });
          const check = verifiedBy(doneAt);
          if (check) {
            steps.push({ t: Math.max(check.t + RAISE_DELAY, doneAt + 1), state: "verified", verifiedBy: check.id });
            end = check.t;
          }
        }
        busyUntil[kind] = end;
        plans.push({ kind, title, location: facingLocation(r.data.location), assignedTo: kind === "fix_shelf_tag" ? "team:price-integrity" : teamFor(facing), basedOn: [r.id], verify: true, steps });
      };
      const next = (after: number, ok: (o: Obs) => boolean) => {
        const hit = list.find((o) => o.t > after && ok(o.r));
        return hit ? { t: hit.t, id: hit.r.id } : undefined;
      };

      if (r.data.status === "out_of_stock" || (r.data.status === "low_stock" && item?.promo)) {
        // The associate works it in the next recovery round that reaches the facing: done if the backroom
        // had stock, cancelled if it had none, since only a store order can fix that.
        const work = recovery.get(facing)?.find((w) => w.t > t + RAISE_DELAY + ASSIGN_DELAY);
        raise("replenish", `Replenish ${name}`, work && work.units > 0 ? work.t : undefined, (after) => next(after, (o) => o.data.status === "in_stock"), work && work.units === 0 ? work.t : undefined);
      }
      if (flags.includes("misplaced_item")) {
        const fault = g.faultsAt(facing, t).find((f) => f.kind === "misplaced_item");
        const done = fault?.end ?? undefined;
        raise("go_back", `Clear a go-back from the ${name} facing`, done, (after) => next(after, (o) => o.data.status !== undefined && !(o.data.flags ?? []).includes("misplaced_item")));
      }
      if (flags.includes("price_mismatch")) {
        const fault = g.faultsAt(facing, t).find((f) => f.kind === "price_mismatch");
        const done = fault?.end ?? undefined;
        raise("fix_shelf_tag", `Fix the shelf tag for ${name}`, done, (after) => next(after, (o) => o.data.tagPrice !== undefined && !(o.data.flags ?? []).includes("price_mismatch")));
      }
    }
  }

  // ---- checkout exceptions, for a person to review ----
  for (const r of incidents as OissRecord<{ location: Record<string, string>; incidentType: string }>[]) {
    const t = sec(r.time);
    const rng = new Rng(g.config.seed).fork(`task-review:${r.id}`);
    const created = t + RAISE_DELAY;
    const done = Math.min(last, created + ASSIGN_DELAY + Math.round(rng.uniform(8, 40) * 60));
    const steps: Step[] = [
      { t: created, state: "open" },
      { t: created + ASSIGN_DELAY, state: "assigned" },
    ];
    if (done > created + ASSIGN_DELAY) steps.push({ t: done, state: "done" });
    const what = EXCEPTION[r.data.incidentType] ?? r.data.incidentType.replaceAll("_", " ");
    const lane = laneName(r.data.location.fixture ?? "");
    plans.push({ kind: "review_exception", title: `Review a possible ${what} at ${lane}`, location: { ...r.data.location }, assignedTo: "team:asset-protection", basedOn: [r.id], verify: false, steps });
  }

  // ---- the front end ----
  const staffedLanes = layout.lanes.filter((l) => l.kind === "staffed").length;
  type Metric = OissRecord<{ window: { end: string }; metrics: { avgWaitSeconds?: number; openLanes?: number; queueLength?: number } }>;
  const front = (zoneMetrics as Metric[]).filter((r) => r.subject === "front-end").map((r) => ({ t: sec(r.data.window.end), r }));
  let laneBusyUntil = -1;
  for (const { t, r } of front) {
    const { avgWaitSeconds = 0, openLanes = staffedLanes } = r.data.metrics;
    if (t <= laneBusyUntil || avgWaitSeconds < OPEN_LANE_WAIT_SECONDS || openLanes >= staffedLanes) continue;
    const created = t + RAISE_DELAY;
    const steps: Step[] = [
      { t: created, state: "open" },
      { t: created + ASSIGN_DELAY, state: "assigned" },
    ];
    const opened = g.frontEnd.find((s) => s.t > created && s.t <= created + OPEN_LANE_TIMEOUT && s.openLanes > openLanes);
    if (opened) {
      const doneAt = Math.max(opened.t, created + ASSIGN_DELAY + 1);
      steps.push({ t: doneAt, state: "done" });
      const check = front.find((m) => m.t > doneAt && (m.r.data.metrics.openLanes ?? 0) > openLanes);
      if (check) steps.push({ t: Math.max(check.t + RAISE_DELAY, doneAt + 1), state: "verified", verifiedBy: check.r.id });
      laneBusyUntil = check ? check.t : Infinity;
    } else {
      steps.push({ t: Math.min(last, created + OPEN_LANE_TIMEOUT), state: "cancelled" });
      laneBusyUntil = created + OPEN_LANE_TIMEOUT;
    }
    plans.push({ kind: "open_lane", title: "Open another staffed lane", location: { zone: "front-end" }, assignedTo: "team:front-end", basedOn: [r.id], verify: true, steps });
  }

  // Number tasks by when they were raised, so a change late in the day leaves earlier ids as they were.
  plans.sort((a, b) => a.steps[0]!.t - b.steps[0]!.t || (a.basedOn[0]! < b.basedOn[0]! ? -1 : 1) || (a.kind < b.kind ? -1 : 1));
  const nextId = idMaker("task", clock.date);
  const out: OissRecord[] = [];
  for (const p of plans) {
    const subject = nextId();
    p.steps.forEach((s, i) => {
      if (s.t > last) return;
      out.push(
        record("Task", {
          id: `${subject}-v${i + 1}`,
          source: `urn:oiss:${store}:task-management`,
          time: clock.iso(s.t),
          subject,
          store,
          privacy: "operational",
          data: {
            provenance: PROV,
            location: p.location,
            kind: p.kind,
            state: s.state,
            title: p.title,
            createdBy: CREATED_BY,
            ...(s.state === "open" ? {} : { assignedTo: p.assignedTo }),
            basedOn: p.basedOn,
            verification: s.verifiedBy ? { required: p.verify, verifiedBy: s.verifiedBy } : { required: p.verify },
          },
        }),
      );
    });
  }
  return out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : 1));
}
