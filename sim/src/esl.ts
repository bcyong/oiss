/**
 * Electronic shelf labels: the reports Vendor D's label system would send about the day.
 *
 * Every facing has an electronic shelf label. At 6 AM the label system sends the overnight price
 * changes to the labels that need them, and each label confirms its new price or fails to. A label
 * that fails keeps showing its old price, and the system retries it every hour until the store
 * closes. A price mismatch whose cause is label_not_updated is one of those failures, so the label
 * system reports it within 15 minutes. A paper sale sign left up over a correct label is a price
 * mismatch the label system never sees: the promotion ended overnight, the label took the regular
 * price back and confirmed it, and the sign still shows the sale price. Only something that looks at
 * the shelf, such as the robot, sees the sign, so the two sources disagree about that facing's price.
 *
 * The reports are in the vendor's own format, not OISS. The adapter in adapters/src/mock-esl.ts
 * turns them into ShelfObservation price checks. Everything here is synthetic and labeled as mock.
 */
import { eslLabelFor, type MockEslEvent } from "../../adapters/src/mock-esl.ts";
import type { Ground } from "./model.ts";
import { Rng } from "./rng.ts";
import { hours } from "./time.ts";

export type { MockEslEvent };

/** When the overnight price changes go out to the labels. */
export const ESL_PUSH = hours(6);
/** How many labels get an overnight price change, besides the ones that fail. */
const PRICE_CHANGES = 40;
/** How long the label system waits for a label to confirm before it reports a failure. */
const CONFIRM_TIMEOUT = 900;

export function eslEvents(g: Ground): MockEslEvent[] {
  const rng = new Rng(g.config.seed).fork("esl");
  const { catalog, clock } = g;
  const price = (gtin: string) => catalog.byGtin.get(gtin)!.price;
  const at = (t: number) => new Date(clock.epochMs(t)).toISOString().slice(0, 19) + "Z";
  const out: Omit<MockEslEvent, "event_id">[] = [];
  const report = (facing: string, t: number, event: MockEslEvent["event"], shown: number, attempt: number) => {
    const gtin = catalog.byFacing.get(facing)!.gtin;
    out.push({ store_ref: g.layout.store.storeNumber, label_id: eslLabelFor(facing), item: gtin.slice(1), event, displayed_price: shown.toFixed(2), target_price: price(gtin).toFixed(2), attempt, at: at(t), mock: true });
  };

  // Labels that miss a price change keep their old price, report failure, and get retried every hour.
  const failures = g.faults.filter((f) => f.kind === "price_mismatch" && f.cause === "label_not_updated");
  const failing = new Set(failures.filter((f) => !f.injected && f.start === ESL_PUSH).map((f) => f.facing));

  // A sale sign left up means the promotion ended overnight, so its label is in the batch going back to
  // the regular price. The rest of the batch is chosen from its own stream. Injected faults change none of it.
  const saleEnded = new Set(g.faults.filter((f) => !f.injected && f.cause === "sale_sign_left_up" && f.start === ESL_PUSH).map((f) => f.facing));
  const shuffled = rng.fork("batch").shuffle(catalog.planogram.map((p) => p.facing));
  const batch = [...saleEnded, ...shuffled.filter((f) => !saleEnded.has(f))].slice(0, Math.max(PRICE_CHANGES, saleEnded.size));
  for (const facing of batch) {
    if (failing.has(facing)) continue;
    report(facing, ESL_PUSH + rng.fork(`confirm-${facing}`).uniform(20, 600), "PRICE_CONFIRMED", price(catalog.byFacing.get(facing)!.gtin), 1);
  }
  for (const f of failures) {
    const r = rng.fork(`fault-${f.id}`);
    let attempt = 1;
    report(f.facing, f.start + CONFIRM_TIMEOUT + r.uniform(0, 60), "UPDATE_FAILED", f.tagPrice!, attempt);
    for (let h = Math.floor((f.start + CONFIRM_TIMEOUT) / 3600) + 1; hours(h) < g.close; h++) {
      if (f.end !== null && hours(h) >= f.end) break;
      report(f.facing, hours(h) + r.uniform(5, 300), "UPDATE_FAILED", f.tagPrice!, ++attempt);
    }
  }

  out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.label_id < b.label_id ? -1 : 1));
  const day = g.config.date.replaceAll("-", "");
  return out.map((e, i) => ({ event_id: `MVD-${day}-${String(i + 1).padStart(5, "0")}`, ...e }));
}
