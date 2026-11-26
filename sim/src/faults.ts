/**
 * Shelf faults: things that go wrong on the sales floor that the store's own systems don't see,
 * and that shelf scans and cameras should catch. Each one is ground truth. observe.ts decides what
 * each source reports about it.
 *
 * - Misplaced item: an item left on another item's facing, usually by a shopper who changed their
 *   mind (a "go-back"). An associate clears go-backs during a recovery round, most of the time, or
 *   sooner when a store task asks for it.
 * - Price mismatch: the shelf tag doesn't match the price in the price file, because an electronic
 *   shelf label didn't take a price change or a paper sale sign was left up over the label. It stays
 *   wrong until an associate fixes the tag for a store task.
 * - Phantom inventory: the units on a facing disappear without a sale (theft or damage that was
 *   never written off), so the store's system still counts them on hand. No replenishment order
 *   goes in and the backroom has none, so the facing stays out of stock while the system says it
 *   isn't. Only a shelf scan shows the gap.
 *
 * Faults come at set rates each day, and a visitor can inject more. An injected fault changes the
 * day only from its own time on, so every record sent before it stays exactly the same.
 */
import type { Catalog, Item } from "./catalog.ts";
import { Rng } from "./rng.ts";
import { hours } from "./time.ts";

export type FaultKind = "misplaced_item" | "price_mismatch" | "phantom_inventory";

export const FAULT_KINDS: FaultKind[] = ["misplaced_item", "price_mismatch", "phantom_inventory"];

export type PriceMismatchCause = "label_not_updated" | "sale_sign_left_up";

/** A fault to add to the day at a set time and facing. The details (which item, what price) come from the seed. */
export interface Injection {
  kind: FaultKind;
  facing: string;
  /** Seconds since local midnight. */
  t: number;
}

export interface ShelfFault {
  id: string;
  kind: FaultKind;
  facing: string;
  start: number;
  /** When it was put right, or null if it lasts the rest of the day. */
  end: number | null;
  /** Who put it right: an associate on a recovery round, or one working a store task. */
  endedBy?: "recovery_round" | "task";
  /** Misplaced item: the GTIN of the item left on the facing. */
  gtin?: string;
  /** Price mismatch: the price on the shelf tag. The price file keeps the item's own price. */
  tagPrice?: number;
  /**
   * Price mismatch: why the tag is wrong. label_not_updated: the electronic shelf label never took
   * the price change, so the label system knows. sale_sign_left_up: the label is right, but a paper
   * sale sign over it shows an old sale price, which only something that looks at the shelf sees.
   */
  cause?: PriceMismatchCause;
  injected: boolean;
}

/** Expected faults per day, by kind. */
export const FAULT_RATES: Record<FaultKind, number> = { misplaced_item: 16, price_mismatch: 6, phantom_inventory: 3 };

/** Chance an associate clears a go-back in a recovery round. */
const CLEAR_IN_ROUND = 0.7;
const ROUND_SPAN = hours(1, 15);

interface Context {
  seed: number;
  catalog: Catalog;
  open: number;
  lastEntry: number;
  /** Relative shopper arrivals by hour, so go-backs follow traffic. */
  hourly: Record<number, number>;
  recoveryRounds: number[];
  injections: Injection[];
}

/** A shelf price ending in 9, near the item's price but not equal to it. */
function wrongPrice(item: Item, rng: Rng): number {
  // A sale tag left up or a price increase not re-tagged shows a lower price; a price cut not re-tagged, a higher one.
  const lower = rng.chance(0.6);
  for (;;) {
    const d = rng.uniform(0.08, 0.25) * (lower ? -1 : 1);
    const p = Math.max(0.49, Math.floor(item.price * (1 + d) * 10) / 10 + 0.09);
    const rounded = Math.round(p * 100) / 100;
    if (rounded !== item.price) return rounded;
  }
}

function details(kind: FaultKind, facing: string, start: number, ctx: Context, rng: Rng): Omit<ShelfFault, "id" | "injected"> {
  const pos = ctx.catalog.byFacing.get(facing);
  if (!pos) throw new Error(`no such facing in the planogram: ${facing}`);
  const own = ctx.catalog.byGtin.get(pos.gtin)!;
  if (kind === "misplaced_item") {
    let stray = rng.pick(ctx.catalog.items);
    while (stray.gtin === own.gtin) stray = rng.pick(ctx.catalog.items);
    let end: number | null = null;
    for (const round of ctx.recoveryRounds) {
      if (round <= start) continue;
      if (rng.chance(CLEAR_IN_ROUND)) {
        end = round + rng.uniform(0, ROUND_SPAN);
        break;
      }
    }
    return { kind, facing, start, end, ...(end !== null ? { endedBy: "recovery_round" as const } : {}), gtin: stray.gtin };
  }
  if (kind === "price_mismatch") {
    const tagPrice = wrongPrice(own, rng);
    // Only a lower price can be a sale sign left up; either can be a label that missed a price change.
    const cause: PriceMismatchCause = tagPrice < own.price && rng.chance(0.5) ? "sale_sign_left_up" : "label_not_updated";
    return { kind, facing, start, end: null, tagPrice, cause };
  }
  return { kind, facing, start, end: null };
}

/** The day's faults: the usual ones at set rates, then any injected ones. */
export function planFaults(ctx: Context): ShelfFault[] {
  const rng = new Rng(ctx.seed).fork("faults");
  const facings = ctx.catalog.planogram.map((p) => p.facing);
  const hoursList = Object.entries(ctx.hourly).map(([h, w]) => ({ h: Number(h), w }));
  const planned: Omit<ShelfFault, "id" | "injected">[] = [];

  for (const kind of FAULT_KINDS) {
    const n = rng.poisson(FAULT_RATES[kind]);
    for (let i = 0; i < n; i++) {
      const facing = rng.pick(facings);
      let start: number;
      if (kind === "misplaced_item") start = Math.min(ctx.lastEntry, hours(rng.weighted(hoursList, (x) => x.w).h) + rng.uniform(0, 3600));
      else if (kind === "price_mismatch") start = hours(6); // a price change that took effect overnight
      else start = rng.uniform(hours(8), hours(20));
      planned.push(details(kind, facing, start, ctx, rng.fork(`${kind}-${i}`)));
    }
  }
  planned.sort((a, b) => a.start - b.start);
  const faults: ShelfFault[] = planned.map((f, i) => ({ id: `fault-${String(i + 1).padStart(3, "0")}`, ...f, injected: false }));

  const injRng = new Rng(ctx.seed).fork("injections");
  ctx.injections.forEach((inj, i) => {
    if (!FAULT_KINDS.includes(inj.kind)) throw new Error(`unknown fault kind: ${inj.kind}`);
    faults.push({ id: `injected-${String(i + 1).padStart(3, "0")}`, ...details(inj.kind, inj.facing, inj.t, ctx, injRng.fork(`injection-${i}`)), injected: true });
  });
  return faults;
}

/** Faults active at a facing at time t. */
export function activeFaults(byFacing: Map<string, ShelfFault[]>, facing: string, t: number): ShelfFault[] {
  const list = byFacing.get(facing);
  if (!list) return [];
  return list.filter((f) => f.start <= t && (f.end === null || t < f.end));
}
