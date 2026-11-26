import { simulateDay, type DayConfig, type DayStats, type Ground, type WorkOrder } from "./model.ts";
import { adaptLpAlerts, demo001Config } from "../../adapters/src/mock-lp-alerts.ts";
import { type LossPreventionDay, lossPreventionDay, type MockLpAlert } from "./lossPrevention.ts";
import type { MockShelfScanMission } from "../../adapters/src/mock-shelf-scan.ts";
import { toTrafficCsv } from "../../adapters/src/mock-traffic-csv.ts";
import type { MockEslEvent } from "./esl.ts";
import { FAULT_KINDS, type FaultKind } from "./faults.ts";
import { observeDay, type ObservedDay } from "./observe.ts";
import { byTime, type OissRecord, SIM_VERSION } from "./records.ts";
import { storeTasks, workOrders } from "./tasks.ts";

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
  records: Omit<ObservedDay, "shelfScanMissions" | "trafficRows" | "eslEvents"> & { incidents: OissRecord[]; tasks: OissRecord[] };
  /** Vendor exports in the vendors' own formats, before any adapter. */
  vendorExports: { mockLpAlerts: MockLpAlert[]; mockShelfScans: MockShelfScanMission[]; mockTrafficCsv: string; mockEsl: MockEslEvent[] };
  /** Vendor alert id -> the OISS Incident id the adapter made from it. */
  incidentFor: Record<string, string>;
  itemMaster: { store: string; note: string; generator: string; items: ItemMasterEntry[] };
  summary: { store: string; date: string; seed: number; generator: string; stats: DayStats; shelfFaults: Record<FaultKind, number> & { injected: number }; lossPrevention: LossPreventionDay["scorecard"] };
}

/** Most passes runDay takes to settle what the associates did for the day's tasks. */
const MAX_TASK_PASSES = 25;

/**
 * Runs the day, then again with the shelf work its tasks asked for, until that work stops changing.
 * Work done at a time changes the day only from then on, and tasks raise work only later, so each
 * pass settles at least one more piece of work on every facing, and the day converges.
 */
function settleDay(config: DayConfig): Ground {
  let orders: WorkOrder[] = [];
  for (let pass = 0; pass < MAX_TASK_PASSES; pass++) {
    const ground = simulateDay({ ...config, workOrders: orders });
    const next = workOrders(ground, observeDay(ground, { shelvesOnly: true }).shelfObservations);
    if (JSON.stringify(next) === JSON.stringify(orders)) return ground;
    orders = next;
  }
  throw new Error(`the store's task work did not settle in ${MAX_TASK_PASSES} passes`);
}

export function runDay(config: DayConfig): SimulatedDay {
  const ground = settleDay(config);
  const observed = observeDay(ground);
  const lp = lossPreventionDay(ground);
  const adapted = adaptLpAlerts(lp.alerts, demo001Config());
  if (adapted.rejected.length) throw new Error(`the loss prevention adapter rejected ${adapted.rejected.length} alerts: ${adapted.rejected[0]!.reason}`);
  const { shelfScanMissions: _missions, trafficRows: _rows, eslEvents: _labels, ...observedRecords } = observed;
  const records = {
    ...observedRecords,
    evidence: [...observed.evidence, ...(adapted.evidence as unknown as OissRecord[])].sort(byTime),
    incidents: adapted.incidents as unknown as OissRecord[],
    tasks: [] as OissRecord[],
  };
  records.tasks = storeTasks(ground, records.shelfObservations, records.zoneMetrics, records.incidents);
  const store = ground.layout.store.id;
  const generator = `oiss-sim ${SIM_VERSION}`;
  return {
    ground,
    records,
    vendorExports: { mockLpAlerts: lp.alerts, mockShelfScans: observed.shelfScanMissions, mockTrafficCsv: toTrafficCsv(observed.trafficRows), mockEsl: observed.eslEvents },
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
    summary: {
      store,
      date: ground.config.date,
      seed: ground.config.seed,
      generator,
      stats: ground.stats,
      shelfFaults: { ...(Object.fromEntries(FAULT_KINDS.map((k) => [k, ground.faults.filter((f) => f.kind === k).length])) as Record<FaultKind, number>), injected: ground.faults.filter((f) => f.injected).length },
      lossPrevention: lp.scorecard,
    },
  };
}
