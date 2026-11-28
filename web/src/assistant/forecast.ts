import { lastAtOrBefore, taskAt, zoneMetricAt, type FacingView, type IndexedDay } from "../day.ts";

/**
 * The stock forecast: which facings are likely to be out of stock when the shelf-scanning robot next
 * passes. NVIDIA Kumo Relational, a foundation model for predictions over relational data, learns from
 * the day's own records without any training run: each earlier robot pass is a set of labeled
 * examples (where each facing stood then, and whether the next pass found it out of stock), and each
 * facing that isn't out of stock now is a row to score.
 *
 * The page builds both sets from the OISS records up to the playback time, so the forecast never sees
 * a record from later in the day. The server function checks the rows and builds the request to Kumo
 * itself, so the site's key can be used only for this forecast.
 */

/** A facing's state at one moment, as Kumo reads it. Order matters: rows carry these values in this order. */
export const FEATURES = [
  { name: "fill", kind: "num", min: 0, max: 1, about: "fill level at the latest shelf read" },
  { name: "status", kind: "cat", values: ["in_stock", "low_stock"], about: "status at the latest shelf read" },
  { name: "fill_drop_per_hour", kind: "num", min: -50, max: 50, about: "how fast the fill level fell between the robot's last two reads" },
  { name: "hours_since_read", kind: "num", min: 0, max: 24, about: "hours since the latest shelf read" },
  { name: "department", kind: "cat", about: "the item's department" },
  { name: "promo", kind: "cat", values: ["yes", "no"], about: "whether the item is on promotion" },
  { name: "zone", kind: "cat", about: "the sales-floor zone" },
  { name: "zone_traffic", kind: "num", min: 0, max: 100_000, about: "shoppers through the zone in the latest 15 minutes" },
  { name: "hour_of_day", kind: "num", min: 0, max: 24, about: "the store's clock" },
  { name: "task_open", kind: "cat", values: ["yes", "no"], about: "whether a replenishment task is open on the facing" },
  { name: "capacity", kind: "num", min: 0, max: 10_000, about: "units the facing holds" },
] as const;

export type FeatureValue = number | string;
/** An earlier robot pass: when, which facing, whether the next pass found it out of stock, then the features. */
export type ContextRow = [anchor: string, facing: number, label: boolean, ...features: FeatureValue[]];
/** A facing to score now: which facing, then the features. */
export type PredictRow = [facing: number, ...features: FeatureValue[]];

export interface ForecastInput {
  /** The playback time, as the forecast's anchor time. */
  anchor: string;
  context: ContextRow[];
  predict: PredictRow[];
}

/** What the server function sends back: the chance of each predict row, in order. */
export interface ForecastReply {
  model: string;
  probabilities: (number | null)[];
}

export type Forecaster = (input: ForecastInput) => Promise<ForecastReply>;

/** What the forecast tool works from, worked out once per question. */
export type ForecastRun =
  | { state: "ready"; input: ForecastInput; reply: ForecastReply; meta: ForecastMeta }
  | { state: "not_enough"; reason: string }
  | { state: "error"; reason: string };

export interface ForecastMeta {
  /** Facing reads from earlier passes with a known outcome, before any were sampled out. */
  labeled: number;
  /** Of those, how many the next pass found out of stock. */
  ranOut: number;
  /** Earlier robot passes it learned from. */
  passes: number;
  /** When the robot would pass next if it keeps its schedule so far, in seconds since midnight, and how often it has passed. */
  nextPass?: number;
  passEvery?: number;
  /** For each predict row, the facing's latest shelf read record. */
  records: string[];
}

export const LIMITS = { maxContext: 3000, maxPredict: 1200, minLabeled: 200, minRanOut: 5 } as const;

/** Store seconds to an ISO time in UTC, as Kumo's examples write them. */
export const isoAt = (day: IndexedDay, t: number) => new Date(day.midnightMs + Math.round(t) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;

/** A small, steady number from a string, for sampling the same rows every time. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** The robot's reads of a facing: their times and indexes into statusObs. */
function robotReads(day: IndexedDay, v: FacingView): number[] {
  const out: number[] = [];
  v.statusObs.forEach((o, i) => {
    if (o.source === day.robot.source) out.push(i);
  });
  return out;
}

function taskOpenAt(day: IndexedDay, v: FacingView, t: number): boolean {
  return (day.tasksByFacing.get(v.facing.id) ?? []).some((view) => {
    if (view.versions[0]!.data.kind !== "replenish" || view.times[0]! > t) return false;
    const s = taskAt(view, t)?.data.state;
    return s === "open" || s === "assigned" || s === "in_progress";
  });
}

/** A facing's features at time t from the records up to t, or nothing when it is out of stock or unread. */
function featuresAt(day: IndexedDay, v: FacingView, robot: number[], t: number): { values: FeatureValue[]; record: string } | undefined {
  const i = lastAtOrBefore(v.statusTimes, t);
  if (i < 0) return undefined;
  const obs = v.statusObs[i]!;
  const status = obs.data.status;
  if (status !== "in_stock" && status !== "low_stock") return undefined;
  const fill = obs.data.fillLevel ?? (status === "in_stock" ? 0.6 : 0.15);
  // The fall in fill between the robot's last two reads at or before t.
  const done = robot.filter((k) => v.statusTimes[k]! <= t);
  let drop = 0;
  if (done.length >= 2) {
    const a = done.at(-2)!;
    const b = done.at(-1)!;
    const hours = (v.statusTimes[b]! - v.statusTimes[a]!) / 3600;
    const fa = v.statusObs[a]!.data.fillLevel;
    const fb = v.statusObs[b]!.data.fillLevel;
    if (hours > 0 && fa !== undefined && fb !== undefined) drop = Math.max(-50, Math.min(50, (fa - fb) / hours));
  }
  const item = day.items.get(v.facing.gtin);
  return {
    record: obs.id,
    values: [
      round(Math.max(0, Math.min(1, fill))),
      status,
      round(drop),
      round(Math.max(0, Math.min(24, (t - v.statusTimes[i]!) / 3600))),
      item?.department ?? "unknown",
      item?.promo ? "yes" : "no",
      v.zone,
      zoneMetricAt(day, v.zone, t)?.data.metrics.traffic ?? 0,
      round(t / 3600),
      taskOpenAt(day, v, t) ? "yes" : "no",
      v.facing.capacity,
    ],
  };
}

/** When the robot will likely pass next, from the starts of its passes so far. */
function nextPassAfter(day: IndexedDay, t: number): { at: number; every: number } | undefined {
  const starts = day.robot.runs.filter((r) => r.end <= t).map((r) => r.start);
  if (starts.length < 2) return undefined;
  const gaps = starts.slice(1).map((s, i) => s - starts[i]!).sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)]!;
  let next = starts.at(-1)! + gap;
  while (next <= t) next += gap;
  return next < day.close ? { at: next, every: gap } : undefined;
}

/**
 * The forecast's rows at time t, from the records up to t. Each robot pass that ended before t is an
 * example for every facing it found in stock or low, labeled by what the robot's next read of that
 * facing found, if that read came by t.
 */
export function forecastInput(day: IndexedDay, t: number): { input: ForecastInput; meta: ForecastMeta } | { reason: string } {
  const passes = day.robot.runs.filter((r) => r.end <= t);
  const positives: ContextRow[] = [];
  const negatives: { row: ContextRow; key: number }[] = [];
  const predict: PredictRow[] = [];
  const records: string[] = [];
  const passesUsed = new Set<number>();
  day.facings.forEach((v, idx) => {
    const robot = robotReads(day, v);
    for (const [p, run] of passes.entries()) {
      const f = featuresAt(day, v, robot, run.end);
      if (!f) continue;
      const next = robot.find((k) => v.statusTimes[k]! > run.end);
      if (next === undefined || v.statusTimes[next]! > t) continue;
      const label = v.statusObs[next]!.data.status === "out_of_stock";
      const row: ContextRow = [isoAt(day, run.end), idx, label, ...f.values];
      passesUsed.add(p);
      if (label) positives.push(row);
      else negatives.push({ row, key: hash(`${v.facing.id}@${run.end}`) });
    }
    const now = featuresAt(day, v, robot, t);
    if (now) {
      predict.push([idx, ...now.values]);
      records.push(now.record);
    }
  });
  const labeled = positives.length + negatives.length;
  if (labeled < LIMITS.minLabeled || positives.length < LIMITS.minRanOut)
    return {
      reason: passesUsed.size
        ? `Not enough history yet: the robot's earlier passes found only ${positives.length} ${positives.length === 1 ? "facing" : "facings"} out of stock at the pass after, too few to learn from. The forecast needs at least ${LIMITS.minRanOut}.`
        : "Not enough history yet: the robot hasn't finished two passes today, so there is nothing to learn from.",
    };
  // Keep every facing that ran out and a steady sample of the rest, so the request stays small.
  negatives.sort((a, b) => a.key - b.key);
  const context = [...positives, ...negatives.slice(0, Math.max(0, LIMITS.maxContext - positives.length)).map((n) => n.row)].slice(0, LIMITS.maxContext);
  // Score the facings closest to empty first when there are more than a request holds.
  const order = predict.map((_, i) => i).sort((a, b) => (predict[a]![1] as number) - (predict[b]![1] as number)).slice(0, LIMITS.maxPredict);
  return {
    input: { anchor: isoAt(day, t), context, predict: order.map((i) => predict[i]!) },
    meta: { labeled, ranOut: positives.length, passes: passesUsed.size, nextPass: nextPassAfter(day, t)?.at, passEvery: nextPassAfter(day, t)?.every, records: order.map((i) => records[i]!) },
  };
}

/** Runs the forecast at time t, or says why it can't. */
export async function runForecast(day: IndexedDay, t: number, forecaster: Forecaster): Promise<ForecastRun> {
  const built = forecastInput(day, t);
  if ("reason" in built) return { state: "not_enough", reason: built.reason };
  try {
    const reply = await forecaster(built.input);
    if (reply.probabilities.length !== built.input.predict.length || reply.probabilities.every((p) => p === null)) return { state: "error", reason: "The forecast model sent back no usable predictions." };
    return { state: "ready", input: built.input, reply, meta: built.meta };
  } catch (err) {
    return { state: "error", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Calls the site's forecast function. */
export const httpForecast =
  (url = "/api/forecast"): Forecaster =>
  async (input) => {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    } catch {
      throw new Error("Couldn't reach the forecast.");
    }
    const body = (await res.json().catch(() => null)) as (ForecastReply & { error?: string }) | null;
    if (res.status === 404) throw new Error("The forecast runs on the deployed site, not on the local dev server.");
    if (!res.ok || !body || !Array.isArray(body.probabilities)) throw new Error(body?.error ?? `The forecast answered ${res.status}.`);
    return body;
  };

