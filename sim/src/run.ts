import { simulateDay, type DayConfig, type DayStats, type Ground } from "./model.ts";
import { observeDay, type ObservedDay } from "./observe.ts";
import { SIM_VERSION } from "./records.ts";

export interface ItemMasterEntry {
  gtin: string;
  name: string;
  department: string;
  category: string;
  price: { amount: number; currency: string };
  casePack: number;
  shrinkRisk: string;
  promo: boolean;
}

/** One simulated store day: the ground truth, the OISS records each source reports, and the item master. */
export interface SimulatedDay {
  ground: Ground;
  records: ObservedDay;
  itemMaster: { store: string; note: string; generator: string; items: ItemMasterEntry[] };
  summary: { store: string; date: string; seed: number; generator: string; stats: DayStats };
}

export function runDay(config: DayConfig): SimulatedDay {
  const ground = simulateDay(config);
  const records = observeDay(ground);
  const store = ground.layout.store.id;
  const generator = `oiss-sim ${SIM_VERSION}`;
  return {
    ground,
    records,
    itemMaster: {
      store,
      note: "Synthetic item master. Not an OISS record: OISS references items by GTIN, and retailers keep names and prices in their own item master. GTINs use the GS1 restricted-circulation prefix 20.",
      generator,
      items: ground.catalog.items.map((i) => ({
        gtin: i.gtin,
        name: i.name,
        department: i.department,
        category: i.category,
        price: { amount: i.price, currency: "USD" },
        casePack: i.casePack,
        shrinkRisk: i.shrinkRisk,
        promo: i.promo,
      })),
    },
    summary: { store, date: ground.config.date, seed: ground.config.seed, generator, stats: ground.stats },
  };
}
