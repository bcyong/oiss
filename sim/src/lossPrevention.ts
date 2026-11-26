/**
 * Loss prevention at the front end: ground-truth checkout exceptions, and the
 * alert feed a mock loss prevention vendor would send about them.
 *
 * The feed is in the vendor's own format, not OISS: its own store code,
 * register numbers, camera names, EAN codes, epoch-millisecond timestamps
 * and 0 to 100 scores. The adapter in adapters/src/mock-lp-alerts.ts turns it
 * into OISS Incident and Evidence records. Everything here is synthetic and
 * labeled as mock.
 */
import type { MockLpAlert } from "../../adapters/src/mock-lp-alerts.ts";
import type { Item } from "./catalog.ts";
import type { Ground, Transaction } from "./model.ts";
import { Rng } from "./rng.ts";

export type { MockLpAlert };

export type ExceptionType = "non_scan" | "bottom_of_basket" | "ticket_switching" | "sweethearting";

/** What really happened at a checkout. The vendor sees some of it; the store never sees this directly. */
export interface CheckoutException {
  type: ExceptionType;
  shopper: number;
  kind: "staffed" | "self";
  lane: string;
  /** Seconds since local midnight. */
  t: number;
  items: { gtin: string; qty: number }[];
  /** Retail value not paid for, in dollars. */
  value: number;
}

/** Chance per completed checkout, by checkout kind. At most one exception per checkout. */
const RATES: Record<"staffed" | "self", [ExceptionType, number][]> = {
  staffed: [
    ["non_scan", 0.006],
    ["bottom_of_basket", 0.004],
    ["sweethearting", 0.0015],
    ["ticket_switching", 0.001],
  ],
  self: [
    ["non_scan", 0.009],
    ["ticket_switching", 0.004],
    ["bottom_of_basket", 0.002],
  ],
};

const SHRINK_WEIGHT = { low: 1, medium: 2, high: 4 } as const;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function checkoutExceptions(ground: Ground): CheckoutException[] {
  const rng = new Rng(ground.config.seed).fork("checkout-exceptions");
  const out: CheckoutException[] = [];
  for (const txn of ground.transactions) {
    if (txn.lines.length === 0) continue;
    const units = txn.lines.reduce((a, l) => a + l.qty, 0);
    const roll = rng.next();
    let acc = 0;
    let type: ExceptionType | undefined;
    for (const [candidate, p] of RATES[txn.kind]) {
      acc += p;
      if (roll < acc) {
        type = candidate;
        break;
      }
    }
    // Bottom of basket needs a big enough order to leave something on the cart.
    if (!type || (type === "bottom_of_basket" && units < 8)) continue;
    const items = pickItems(ground, txn, type, rng);
    const value = round2(items.reduce((a, l) => a + l.qty * itemOf(ground, l.gtin).price * (type === "ticket_switching" ? 0.6 : 1), 0));
    out.push({ type, shopper: txn.shopper, kind: txn.kind, lane: txn.lane, t: txn.start + rng.uniform(0.2, 0.9) * (txn.end - txn.start), items, value });
  }
  return out;
}

const itemOf = (ground: Ground, gtin: string): Item => ground.catalog.byGtin.get(gtin)!;

function pickItems(ground: Ground, txn: Transaction, type: ExceptionType, rng: Rng) {
  const count = type === "sweethearting" ? Math.min(txn.lines.length, rng.int(2, 4)) : 1;
  const pool = [...txn.lines];
  const items: { gtin: string; qty: number }[] = [];
  while (items.length < count && pool.length > 0) {
    const line = rng.weighted(pool, (l) => SHRINK_WEIGHT[itemOf(ground, l.gtin).shrinkRisk]);
    pool.splice(pool.indexOf(line), 1);
    items.push({ gtin: line.gtin, qty: type === "non_scan" || type === "ticket_switching" ? 1 : line.qty });
  }
  return items;
}

// ---- the mock vendor's alert feed ----------------------------------------------


const CODE: Record<ExceptionType, MockLpAlert["alert_code"]> = { non_scan: "NSCN", bottom_of_basket: "BOTB", ticket_switching: "TKSW", sweethearting: "SWHT" };

/** How often the vendor catches each kind of exception. */
const RECALL: Record<ExceptionType, number> = { non_scan: 0.8, bottom_of_basket: 0.7, ticket_switching: 0.65, sweethearting: 0.5 };
/** False alerts per completed checkout. */
const FALSE_ALERT_RATE = { staffed: 0.003, self: 0.005 };

/** The vendor's register code for a lane or station id. */
export const registerOf = (lane: string): string => (lane.startsWith("sco-") ? `SCO${lane.slice(4)}` : `R${lane.slice(5)}`);

/** Which of the vendor's front-end cameras sees a lane. */
function cameraOf(ground: Ground, lane: string): string {
  if (lane.startsWith("sco-")) return "SCO-CAM";
  const fixture = ground.layout.fixtures.find((f) => f.id === lane)!;
  return fixture.footprint[0]!.x < 26 ? "FE-CAM-1" : "FE-CAM-2";
}

export interface LossPreventionDay {
  exceptions: CheckoutException[];
  alerts: MockLpAlert[];
  /** For each alert id, whether the exception really happened: what a person reviewing the clip would find. */
  realByAlert: Record<string, boolean>;
  /** How the vendor did against ground truth. Not something a real store gets to see. */
  scorecard: { exceptions: number; valueNotPaid: number; alerts: number; trueAlerts: number; falseAlerts: number; missed: number };
}

export function lossPreventionDay(ground: Ground): LossPreventionDay {
  const exceptions = checkoutExceptions(ground);
  const rng = new Rng(ground.config.seed).fork("mock-vendor-b");
  const clock = ground.clock;
  const ean = (gtin: string) => gtin.slice(1);
  const raw: (Omit<MockLpAlert, "alert_id"> & { truth: boolean })[] = [];

  // False alerts draw from their own stream, so a change to one checkout late in the day leaves earlier alerts as they were.
  const falseRng = new Rng(ground.config.seed).fork("mock-vendor-b:false-alerts");
  const alert = (lane: string, t: number, type: ExceptionType, score: number, items: { gtin: string; qty: number }[], truth: boolean, rng: Rng) => {
    const eventMs = clock.epochMs(t);
    raw.push({
      site: `DG${ground.layout.store.storeNumber}`,
      register: registerOf(lane),
      event_ts: Math.round(eventMs),
      alert_ts: Math.round(eventMs + rng.uniform(4, 40) * 1000),
      alert_code: CODE[type],
      score: Math.max(5, Math.min(99, Math.round(score))),
      items: items.map((l) => ({ ean: ean(l.gtin), qty: l.qty, unit_price: itemOf(ground, l.gtin).price })),
      clip: { camera: cameraOf(ground, lane), start_ts: Math.round(eventMs - 15_000), end_ts: Math.round(eventMs + 5_000), uri: "" },
      mock: true,
      truth,
    });
  };

  let caught = 0;
  for (const ex of exceptions) {
    if (!rng.chance(RECALL[ex.type])) continue;
    caught++;
    alert(ex.lane, ex.t + rng.uniform(-3, 3), ex.type, rng.normal(80, 9), ex.items, true, rng);
  }
  const confused = new Set(exceptions.map((e) => `${e.shopper}`));
  for (const txn of ground.transactions) {
    if (txn.lines.length === 0 || confused.has(`${txn.shopper}`) || !falseRng.chance(FALSE_ALERT_RATE[txn.kind])) continue;
    const types: ExceptionType[] = txn.kind === "self" ? ["non_scan", "ticket_switching"] : ["non_scan", "bottom_of_basket", "sweethearting"];
    const type = falseRng.pick(types);
    const line = falseRng.pick(txn.lines);
    alert(txn.lane, txn.start + falseRng.uniform(0.2, 0.9) * (txn.end - txn.start), type, falseRng.normal(56, 12), [{ gtin: line.gtin, qty: 1 }], false, falseRng);
  }

  raw.sort((a, b) => a.alert_ts - b.alert_ts);
  const day = ground.config.date.replaceAll("-", "");
  const realByAlert: Record<string, boolean> = {};
  const alerts = raw.map(({ truth, ...a }, i) => {
    const alert_id = `MVB-${day}-${String(i + 1).padStart(5, "0")}`;
    realByAlert[alert_id] = truth;
    return { alert_id, ...a, clip: { ...a.clip, uri: `clips/${alert_id}.mp4` } };
  });
  return {
    exceptions,
    alerts,
    realByAlert,
    scorecard: {
      exceptions: exceptions.length,
      valueNotPaid: round2(exceptions.reduce((a, e) => a + e.value, 0)),
      alerts: alerts.length,
      trueAlerts: caught,
      falseAlerts: alerts.length - caught,
      missed: exceptions.length - caught,
    },
  };
}
