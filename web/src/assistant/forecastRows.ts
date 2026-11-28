/**
 * The stock forecast's rows, shared by the page and the server function. This file imports nothing, so
 * the server function's bundle stays free of the page's day index.
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

export const LIMITS = { maxContext: 3000, maxPredict: 1200, minLabeled: 200, minRanOut: 5 } as const;
