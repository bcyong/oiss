import { hours } from "./time.ts";

/**
 * The stores of the demo's district. They share one prototype floor plan and planogram, as chain stores
 * built to one prototype do, so their records line up zone for zone and facing for facing. What sets
 * them apart is how they run: how many shoppers come in, how often the grocery team recovers the shelves,
 * how well the distribution center keeps them supplied and how many cashiers the schedule puts on.
 */
export interface StoreProfile {
  /** OISS store id. */
  id: string;
  storeNumber: string;
  name: string;
  /** Expected shopper count for the day. */
  shoppers: number;
  /** Times of the store's own shelf recovery rounds, seconds since midnight. */
  recoveryRounds: number[];
  /** Share of facings that open the day short with nothing in the backroom. */
  supplyIssueRate: number;
  /** Staffed lanes the schedule puts on above or below the chain's minimum for each hour. */
  laneOffset: number;
}

/** The demo's own store. Its day is the one the site ships and checks against the golden manifest. */
export const MAIN_STREET: StoreProfile = {
  id: "demo-001",
  storeNumber: "0001",
  name: "Demo Grocery, Main Street",
  shoppers: 1600,
  recoveryRounds: [hours(11), hours(15), hours(19)],
  supplyIssueRate: 0.05,
  laneOffset: 0,
};

/** The other stores in Main Street's district, simulated on demand for store comparisons. */
export const DISTRICT_PEERS: StoreProfile[] = [
  // A busier store on the same front-end schedule.
  { id: "demo-002", storeNumber: "0002", name: "Demo Grocery, Harbor Point", shoppers: 2000, recoveryRounds: [hours(11), hours(15), hours(19)], supplyIssueRate: 0.05, laneOffset: 0 },
  // A store that recovers its shelves once a day.
  { id: "demo-003", storeNumber: "0003", name: "Demo Grocery, Oak Ridge", shoppers: 1450, recoveryRounds: [hours(13)], supplyIssueRate: 0.05, laneOffset: 0 },
  // A store with supply problems from its distribution center and an extra cashier on the schedule.
  { id: "demo-004", storeNumber: "0004", name: "Demo Grocery, Riverside", shoppers: 1500, recoveryRounds: [hours(11), hours(15), hours(19)], supplyIssueRate: 0.1, laneOffset: 1 },
];

export const DISTRICT: StoreProfile[] = [MAIN_STREET, ...DISTRICT_PEERS];

/** What an adapter needs to know about the store it maps a vendor's feed for. */
export interface StoreRef {
  id: string;
  storeNumber: string;
}
