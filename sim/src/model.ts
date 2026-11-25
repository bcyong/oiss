/**
 * Ground truth for one store day: shoppers, on-shelf inventory and the front
 * end. Nothing here is an OISS record yet; observe.ts turns ground truth into
 * what each source would report, with its own schedule and noise.
 */
import { buildCatalog, type Catalog, type Item, sizePlanogram } from "./catalog.ts";
import { Scheduler } from "./events.ts";
import { type Point, dist } from "./geometry.ts";
import { ALLEY_NORTH_Y, type Department, type Lane, route, routeLength, type Slot, type StoreLayoutModel, buildLayout } from "./layout.ts";
import { Rng } from "./rng.ts";
import { hours, type StoreClock, storeClock } from "./time.ts";

export interface DayConfig {
  seed: number;
  /** YYYY-MM-DD, in the store's time zone. */
  date: string;
  /** Expected shopper count for the day. */
  shoppers?: number;
  /** Times of the store's own shelf recovery rounds, seconds since midnight. */
  recoveryRounds?: number[];
}

export type Mission = "quick_trip" | "fill_in" | "stock_up";

export interface TrackPoint {
  t: number;
  x: number;
  y: number;
}

/** One shopper's visit, as the floor plan would see it. */
export interface ShopperTrack {
  shopper: number;
  mission: Mission;
  arrival: number;
  exit: number;
  /** Corner and stop points; the shopper moves in a straight line between consecutive points. */
  points: TrackPoint[];
  unitsBought: number;
  unitsMissed: number;
  checkout: "staffed" | "self";
  lane: string;
}

export interface FrontEndSnapshot {
  t: number;
  staffedWaiting: number;
  selfWaiting: number;
  openLanes: number;
}

export interface ServiceStart {
  t: number;
  kind: "staffed" | "self";
  lane: string;
  waitSeconds: number;
}

export interface DayStats {
  shoppers: number;
  unitsSold: number;
  unitsMissed: number;
  salesDollars: number;
  missedDollars: number;
  avgWaitStaffedSeconds: number;
  avgWaitSelfSeconds: number;
  maxStaffedWaiting: number;
  facingsOutOfStockAtClose: number;
  recoveryUnits: number;
}

export interface Ground {
  config: Required<DayConfig>;
  clock: StoreClock;
  layout: StoreLayoutModel;
  catalog: Catalog;
  open: number;
  close: number;
  /** When the last shopper left. */
  end: number;
  tracks: ShopperTrack[];
  /** Per facing: [time, units on the shelf] at each change, in time order, starting at the overnight fill. */
  shelfHistory: Map<string, [number, number][]>;
  frontEnd: FrontEndSnapshot[];
  serviceStarts: ServiceStart[];
  stats: DayStats;
  /** Units on the shelf at facing f at time t. */
  unitsAt(facing: string, t: number): number;
}

// ---- demand -------------------------------------------------------------------

const OPEN = hours(7);
const CLOSE = hours(22);
const LAST_ENTRY = hours(21, 50);

/** Relative arrivals by hour of day: a morning bump, lunch, and the after-work peak. */
const HOURLY: Record<number, number> = { 7: 2, 8: 4, 9: 5, 10: 6, 11: 7, 12: 9, 13: 7, 14: 6, 15: 7, 16: 9, 17: 11, 18: 10, 19: 7, 20: 5, 21: 3 };

const MISSIONS: { mission: Mission; share: number; basket: [number, number]; weights: Partial<Record<Department, number>> }[] = [
  { mission: "quick_trip", share: 0.45, basket: [2, 8], weights: { produce: 1.6, dairy: 1.6, bakery: 1.8, deli: 2.2, beverages: 1.5, snacks: 1.3, household: 0.4, baking: 0.4, pantry: 0.6 } },
  { mission: "fill_in", share: 0.35, basket: [8, 20], weights: { produce: 1.3, dairy: 1.3 } },
  { mission: "stock_up", share: 0.2, basket: [20, 45], weights: { household: 1.6, pantry: 1.4, frozen: 1.3, meat_and_seafood: 1.3 } },
];

/** Minimum staffed lanes open, by hour. The front-end lead opens more when lines grow. */
const MIN_LANES: Record<number, number> = { 7: 2, 8: 2, 9: 3, 10: 3, 11: 4, 12: 4, 13: 4, 14: 3, 15: 3, 16: 5, 17: 5, 18: 5, 19: 3, 20: 3, 21: 2, 22: 1 };

const WALK_SPEED: [number, number] = [0.6, 1.0];
const QUEUE_STEP = 0.8;

const DEFAULT_ROUNDS = [hours(11), hours(15), hours(19)];

export function simulateDay(input: DayConfig): Ground {
  const config: Required<DayConfig> = { shoppers: 1600, recoveryRounds: DEFAULT_ROUNDS, ...input };
  const root = new Rng(config.seed);
  const layout = buildLayout();
  const clock = storeClock(config.date, layout.store.timezone);
  const catalog = buildCatalog(layout, root);
  const meanBasket = MISSIONS.reduce((s, m) => s + m.share * ((m.basket[0] + m.basket[1]) / 2), 0);
  sizePlanogram(catalog, config.shoppers * meanBasket * 1.1, root);

  const sched = new Scheduler();
  sched.now = hours(6);
  const slotById = new Map(layout.slots.map((s) => [s.id, s]));
  const slotByGtin = new Map(catalog.planogram.map((p) => [p.gtin, slotById.get(p.facing)!]));

  // ---- inventory ----
  const invRng = root.fork("inventory");
  const units = new Map<string, number>();
  const backroom = new Map<string, number>();
  const shelfHistory = new Map<string, [number, number][]>();
  for (const pos of catalog.planogram) {
    const item = catalog.byGtin.get(pos.gtin)!;
    const supplyIssue = invRng.chance(0.05);
    const start = Math.round(pos.capacity * (supplyIssue ? invRng.uniform(0.15, 0.5) : invRng.uniform(0.8, 1.0)));
    units.set(pos.facing, start);
    backroom.set(pos.facing, supplyIssue ? 0 : item.casePack * invRng.int(1, 4));
    shelfHistory.set(pos.facing, [[hours(6), start]]);
  }
  const setUnits = (facing: string, n: number) => {
    units.set(facing, n);
    shelfHistory.get(facing)!.push([sched.now, n]);
  };

  let recoveryUnits = 0;
  const recover = (facing: string) => {
    const cap = catalog.byFacing.get(facing)!.capacity;
    const have = units.get(facing)!;
    const fill = Math.min(cap - have, backroom.get(facing)!);
    if (fill <= 0) return;
    backroom.set(facing, backroom.get(facing)! - fill);
    recoveryUnits += fill;
    setUnits(facing, have + fill);
  };

  // The store's own recovery rounds: an associate works the aisles in order and fills what is low, missing some.
  const roundRng = root.fork("recovery");
  for (const start of config.recoveryRounds) {
    sched.at(start, () => {
      const low = layout.slots.filter((s) => {
        const pos = catalog.byFacing.get(s.id);
        return pos && units.get(s.id)! < 0.5 * pos.capacity && roundRng.chance(0.7);
      });
      const span = hours(1, 15);
      low.forEach((s, i) => sched.at(start + (span * (i + 1)) / (low.length + 1), () => recover(s.id)));
    });
  }

  // ---- shoppers ----
  const shopRng = root.fork("shoppers");
  const tracks: ShopperTrack[] = [];
  const arrivals: number[] = [];
  const totalWeight = Object.values(HOURLY).reduce((a, b) => a + b, 0);
  for (const [h, w] of Object.entries(HOURLY)) {
    const hourStart = hours(Number(h));
    const n = shopRng.poisson((config.shoppers * w) / totalWeight);
    for (let i = 0; i < n; i++) arrivals.push(Math.min(LAST_ENTRY, hourStart + shopRng.uniform(0, 3600)));
  }
  arrivals.sort((a, b) => a - b);

  // Cumulative weights per mission, for fast weighted item draws.
  const draws = MISSIONS.map((m) => {
    let acc = 0;
    const cum = catalog.items.map((item) => (acc += item.velocity * (m.weights[item.department] ?? 1)));
    return { ...m, cum, total: acc };
  });
  const drawItem = (d: (typeof draws)[number], rng: Rng): Item => {
    const r = rng.next() * d.total;
    let lo = 0, hi = d.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (d.cum[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    return catalog.items[lo]!;
  };

  // Shoppers walk the store west to east, snaking up and down the walkways.
  const columns = [...new Set(layout.walk.nodes.map((n) => n.x))].sort((a, b) => a - b);
  const tourKey = (p: Point): number => {
    let col = 0;
    for (let i = 0; i < columns.length; i++) if (Math.abs(columns[i]! - p.x) < Math.abs(columns[col]! - p.x)) col = i;
    const along = col % 2 === 0 ? 100 - p.y : p.y;
    return col * 1000 + along * 10 + p.x / 100;
  };

  // ---- front end ----
  interface StaffedLane { lane: Lane; open: boolean; closing: boolean; serving: number | null; waiting: number[] }
  const staffed: StaffedLane[] = layout.lanes.filter((l) => l.kind === "staffed").map((lane) => ({ lane, open: false, closing: false, serving: null, waiting: [] }));
  const selfLane = layout.lanes.find((l) => l.kind === "self")!;
  const stations = layout.fixtures.filter((f) => f.kind === "self_checkout").map((f) => ({ id: f.id, busy: false, at: { x: (f.footprint[0]!.x + f.footprint[2]!.x) / 2, y: f.footprint[0]!.y - 0.4 } }));
  const selfWaiting: number[] = [];
  const frontEnd: FrontEndSnapshot[] = [];
  const serviceStarts: ServiceStart[] = [];
  const snapshot = () => {
    const s = {
      t: sched.now,
      staffedWaiting: staffed.reduce((n, l) => n + l.waiting.length, 0),
      selfWaiting: selfWaiting.length,
      openLanes: staffed.filter((l) => l.open).length,
    };
    const last = frontEnd[frontEnd.length - 1];
    if (last && last.t === s.t) frontEnd[frontEnd.length - 1] = s;
    else frontEnd.push(s);
  };

  interface Live { track: ShopperTrack; speed: number; joinedAt: number; items: number; rng: Rng }
  const live = new Map<number, Live>();
  const moveTo = (s: Live, p: Point, seconds?: number) => {
    const pts = s.track.points;
    const last = pts[pts.length - 1]!;
    // A shopper still on the way to their last point finishes that move first.
    const t0 = Math.max(sched.now, last.t);
    if (last.t < t0) pts.push({ t: t0, x: last.x, y: last.y });
    const dt = seconds ?? dist(last, p) / s.speed;
    pts.push({ t: t0 + dt, x: p.x, y: p.y });
    return t0 + dt - sched.now;
  };
  const queueSpot = (head: Point, k: number): Point => ({ x: head.x, y: head.y - QUEUE_STEP * k });
  const stepUp = (ids: number[], head: Point) => ids.forEach((id, k) => moveTo(live.get(id)!, queueSpot(head, k), 1.5));

  const leave = (s: Live, from: Point) => {
    // Out past the end of the belt, along the front walkway, and out the exit door.
    const legs = [{ x: from.x, y: layout.frontWalkY }, { x: layout.exit.x, y: layout.frontWalkY }, layout.exit];
    let t = Math.max(sched.now, s.track.points[s.track.points.length - 1]!.t);
    let prev = from;
    for (const p of legs) {
      t += dist(prev, p) / s.speed;
      s.track.points.push({ t, x: p.x, y: p.y });
      prev = p;
    }
    s.track.exit = t;
    live.delete(s.track.shopper);
  };

  const startStaffed = (l: StaffedLane) => {
    if (l.serving !== null || l.waiting.length === 0) return;
    const id = l.waiting.shift()!;
    const s = live.get(id)!;
    l.serving = id;
    serviceStarts.push({ t: sched.now, kind: "staffed", lane: l.lane.id, waitSeconds: sched.now - s.joinedAt });
    const walk = moveTo(s, l.lane.service, 3);
    stepUp(l.waiting, l.lane.queueHead);
    snapshot();
    const service = (40 + 3.2 * s.items) * s.rng.lognormal(1, 0.2);
    sched.after(walk + service, () => {
      l.serving = null;
      leave(s, l.lane.service);
      if (l.closing && l.waiting.length === 0) {
        l.open = false;
        l.closing = false;
      }
      startStaffed(l);
      snapshot();
    });
  };

  const startSelf = () => {
    for (const st of stations) {
      if (st.busy || selfWaiting.length === 0) continue;
      const id = selfWaiting.shift()!;
      const s = live.get(id)!;
      st.busy = true;
      serviceStarts.push({ t: sched.now, kind: "self", lane: st.id, waitSeconds: sched.now - s.joinedAt });
      const walk = moveTo(s, st.at);
      stepUp(selfWaiting, selfLane.queueHead);
      const service = (55 + 5 * s.items) * s.rng.lognormal(1, 0.25);
      sched.after(walk + service, () => {
        st.busy = false;
        leave(s, st.at);
        startSelf();
        snapshot();
      });
    }
    snapshot();
  };

  const join = (s: Live, choice: StaffedLane | "self") => {
    s.joinedAt = sched.now;
    if (choice === "self") {
      moveTo(s, queueSpot(selfLane.queueHead, selfWaiting.length));
      selfWaiting.push(s.track.shopper);
      startSelf();
    } else {
      moveTo(s, queueSpot(choice.lane.queueHead, choice.waiting.length));
      choice.waiting.push(s.track.shopper);
      startStaffed(choice);
    }
    snapshot();
  };

  const chooseCheckout = (s: Live): StaffedLane | "self" => {
    const pSelf = s.items <= 8 ? 0.6 : s.items <= 15 ? 0.35 : 0;
    if (s.rng.chance(pSelf)) return "self";
    const open = staffed.filter((l) => l.open && !l.closing);
    if (open.length === 0) return "self";
    const last = s.track.points[s.track.points.length - 1]!;
    return open.reduce((best, l) => {
      const load = (x: StaffedLane) => x.waiting.length + (x.serving === null ? 0 : 1) + Math.abs(x.lane.queueHead.x - last.x) / 40;
      return load(l) < load(best) ? l : best;
    });
  };

  const doneShopping = (s: Live) => {
    const choice = chooseCheckout(s);
    const lane = choice === "self" ? selfLane : choice.lane;
    s.track.checkout = choice === "self" ? "self" : "staffed";
    s.track.lane = lane.id;
    const here = s.track.points[s.track.points.length - 1]!;
    const approach = route(layout.walk, { x: here.x, y: here.y }, { x: lane.queueHead.x, y: ALLEY_NORTH_Y });
    let t = sched.now;
    for (let i = 1; i < approach.length; i++) {
      t += dist(approach[i - 1]!, approach[i]!) / s.speed;
      s.track.points.push({ t, x: approach[i]!.x, y: approach[i]!.y });
    }
    sched.at(t, () => join(s, choice));
  };

  const pick = (s: Live, item: Item, qty: number) => {
    const facing = slotByGtin.get(item.gtin)!.id;
    const have = units.get(facing)!;
    const take = Math.min(have, qty);
    if (take > 0) setUnits(facing, have - take);
    s.items += take;
    s.track.unitsBought += take;
    s.track.unitsMissed += qty - take;
    sales += take * item.price;
    missed += (qty - take) * item.price;
  };
  let sales = 0;
  let missed = 0;

  arrivals.forEach((arrival, index) => {
    sched.at(arrival, () => {
      const rng = shopRng.fork(`shopper-${index}`);
      const d = rng.weighted(draws, (m) => m.share);
      const size = rng.int(d.basket[0], d.basket[1]);
      const basket = new Map<string, { item: Item; qty: number }>();
      for (let tries = 0; basket.size < size && tries < size * 4; tries++) {
        const item = drawItem(d, rng);
        if (!basket.has(item.gtin)) basket.set(item.gtin, { item, qty: rng.chance(0.15) ? (rng.chance(0.25) ? 3 : 2) : 1 });
      }
      const stops = [...basket.values()].map((b) => ({ ...b, slot: slotByGtin.get(b.item.gtin)! })).sort((a, b) => tourKey(a.slot.access) - tourKey(b.slot.access));
      const track: ShopperTrack = { shopper: index, mission: d.mission, arrival, exit: arrival, points: [{ t: arrival, ...layout.entrance }], unitsBought: 0, unitsMissed: 0, checkout: "staffed", lane: "" };
      tracks.push(track);
      const s: Live = { track, speed: rng.uniform(...WALK_SPEED), joinedAt: 0, items: 0, rng };
      live.set(index, s);

      // Lay out the whole shopping trip now; picks happen at their times.
      let t = arrival;
      let here: Point = layout.entrance;
      let lastStop: Slot | null = null;
      for (const stop of stops) {
        if (lastStop?.access.x !== stop.slot.access.x || lastStop.access.y !== stop.slot.access.y) {
          const legs = route(layout.walk, here, stop.slot.access);
          for (let i = 1; i < legs.length; i++) {
            t += dist(legs[i - 1]!, legs[i]!) / s.speed;
            track.points.push({ t, x: legs[i]!.x, y: legs[i]!.y });
          }
          here = stop.slot.access;
        }
        const dwell = rng.uniform(15, 45) + (stop.item.department === "deli" ? rng.uniform(45, 150) : 0);
        const pickAt = t + dwell * 0.6;
        sched.at(pickAt, () => pick(s, stop.item, stop.qty));
        t += dwell;
        track.points.push({ t, x: here.x, y: here.y });
        lastStop = stop.slot;
      }
      sched.at(t, () => doneShopping(s));
    });
  });

  // ---- front-end staffing ----
  let pendingOpen = false;
  const openLane = () => {
    const closed = staffed.filter((l) => !l.open);
    // Open the closed lane nearest the middle of the front end.
    const lane = closed.sort((a, b) => Math.abs(a.lane.queueHead.x - 26) - Math.abs(b.lane.queueHead.x - 26))[0];
    if (lane) {
      lane.open = true;
      lane.closing = false;
    }
    snapshot();
  };
  const leadCheck = () => {
    const hour = Math.floor(sched.now / 3600);
    const min = MIN_LANES[hour] ?? 1;
    const open = staffed.filter((l) => l.open && !l.closing);
    const waiting = open.reduce((n, l) => n + l.waiting.length, 0);
    if (open.length < min) {
      // A scheduled cashier starts a shift: open now, or take back a lane that was closing.
      const closing = staffed.find((l) => l.closing);
      if (closing) closing.closing = false;
      else openLane();
    } else if (open.length < staffed.length && waiting / Math.max(1, open.length) > 2 && !pendingOpen) {
      pendingOpen = true;
      sched.after(180, () => {
        pendingOpen = false;
        openLane();
      });
    } else if (open.length > min && waiting / open.length < 0.5) {
      const quiet = open.reduce((a, b) => (a.waiting.length + (a.serving === null ? 0 : 1) <= b.waiting.length + (b.serving === null ? 0 : 1) ? a : b));
      quiet.closing = true;
      if (quiet.serving === null && quiet.waiting.length === 0) {
        quiet.open = false;
        quiet.closing = false;
      }
    }
    snapshot();
    if (sched.now < CLOSE || live.size > 0) sched.after(120, leadCheck);
  };
  sched.at(OPEN, leadCheck);

  sched.run();

  tracks.sort((a, b) => a.shopper - b.shopper);
  const end = Math.max(CLOSE, ...tracks.map((t) => t.exit));

  const unitsAt = (facing: string, t: number): number => {
    const h = shelfHistory.get(facing);
    if (!h) throw new Error(`no such facing: ${facing}`);
    let lo = 0, hi = h.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (h[mid]![0] <= t) lo = mid;
      else hi = mid - 1;
    }
    return h[lo]![1];
  };

  const waits = (kind: "staffed" | "self") => {
    const w = serviceStarts.filter((s) => s.kind === kind);
    return w.length ? Math.round(w.reduce((a, s) => a + s.waitSeconds, 0) / w.length) : 0;
  };
  const stats: DayStats = {
    shoppers: tracks.length,
    unitsSold: tracks.reduce((a, t) => a + t.unitsBought, 0),
    unitsMissed: tracks.reduce((a, t) => a + t.unitsMissed, 0),
    salesDollars: Math.round(sales * 100) / 100,
    missedDollars: Math.round(missed * 100) / 100,
    avgWaitStaffedSeconds: waits("staffed"),
    avgWaitSelfSeconds: waits("self"),
    maxStaffedWaiting: Math.max(0, ...frontEnd.map((f) => f.staffedWaiting)),
    facingsOutOfStockAtClose: catalog.planogram.filter((p) => unitsAt(p.facing, CLOSE) === 0).length,
    recoveryUnits,
  };

  return { config, clock, layout, catalog, open: OPEN, close: CLOSE, end, tracks, shelfHistory, frontEnd, serviceStarts, stats, unitsAt };
}

export { routeLength };
