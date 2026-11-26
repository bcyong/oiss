import { DISTRICT_PEERS, runDay } from "@oiss/sim";
import { storeCard, type PeerStore, type StoreCard } from "./assistant/tools.ts";
import { indexDay, liveSeed } from "./day.ts";
import type { DayFiles } from "./load.ts";

/** How often through the day a store's figures are worked out, in seconds. */
const STEP = 300;

/**
 * Simulates another store of the district on a date and works out its figures through the day. Only
 * the figures come back: that store's records stay where they were made, as they would at another store.
 */
export function simulatePeerStore(store: string, date: string): PeerStore {
  const profile = DISTRICT_PEERS.find((p) => p.id === store);
  if (!profile) throw new Error(`No store ${store} in the district`);
  const seed = liveSeed(profile.id, date);
  const sim = runDay({ seed, date, store: profile });
  const files: DayFiles = { store: profile.id, date, seed, origin: "browser", records: sim.records as unknown as DayFiles["records"], itemMaster: sim.itemMaster as unknown as DayFiles["itemMaster"] };
  const day = indexDay(files);
  const times: number[] = [];
  const cards: StoreCard[] = [];
  for (let t = day.open; t <= day.close; t += STEP) {
    times.push(t);
    cards.push(storeCard(day, t));
  }
  return { id: profile.id, storeNumber: profile.storeNumber, name: profile.name, times, cards };
}
