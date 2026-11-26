import { simulateDay, type DayConfig, type DayStats, type Ground } from "./model.ts";
import { adaptLpAlerts, demo001Config } from "../../adapters/src/mock-lp-alerts.ts";
import { type LossPreventionDay, lossPreventionDay, type MockLpAlert } from "./lossPrevention.ts";
import { observeDay, type ObservedDay } from "./observe.ts";
import { byTime, type OissRecord, SIM_VERSION } from "./records.ts";

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

/**
 * One simulated store day: the ground truth, the OISS records each source reports, the raw
 * exports of vendors that don't speak OISS (with the records their adapters made), and the
 * item master.
 */
export interface SimulatedDay {
  ground: Ground;
  records: ObservedDay & { incidents: OissRecord[] };
  /** Vendor exports in the vendors' own formats, before any adapter. */
  vendorExports: { mockLpAlerts: MockLpAlert[] };
  /** Vendor alert id -> the OISS Incident id the adapter made from it. */
  incidentFor: Record<string, string>;
  itemMaster: { store: string; note: string; generator: string; items: ItemMasterEntry[] };
  summary: { store: string; date: string; seed: number; generator: string; stats: DayStats; lossPrevention: LossPreventionDay["scorecard"] };
}

export function runDay(config: DayConfig): SimulatedDay {
  const ground = simulateDay(config);
  const observed = observeDay(ground);
  const lp = lossPreventionDay(ground);
  const adapted = adaptLpAlerts(lp.alerts, demo001Config());
  if (adapted.rejected.length) throw new Error(`the loss prevention adapter rejected ${adapted.rejected.length} alerts: ${adapted.rejected[0]!.reason}`);
  const records = {
    ...observed,
    evidence: [...observed.evidence, ...(adapted.evidence as unknown as OissRecord[])].sort(byTime),
    incidents: adapted.incidents as unknown as OissRecord[],
  };
  const store = ground.layout.store.id;
  const generator = `oiss-sim ${SIM_VERSION}`;
  return {
    ground,
    records,
    vendorExports: { mockLpAlerts: lp.alerts },
    incidentFor: adapted.incidentFor,
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
    summary: { store, date: ground.config.date, seed: ground.config.seed, generator, stats: ground.stats, lossPrevention: lp.scorecard },
  };
}
