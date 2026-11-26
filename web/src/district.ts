import { DISTRICT_PEERS } from "@oiss/sim";
import type { PeerStore } from "./assistant/tools.ts";

const cache = new Map<string, Promise<PeerStore[]>>();

function simulatePeer(store: string, date: string): Promise<PeerStore> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./peer.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<PeerStore | { error: string }>) => {
      worker.terminate();
      if ("error" in e.data) reject(new Error(e.data.error));
      else resolve(e.data);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "The simulator stopped"));
    };
    worker.postMessage({ store, date });
  });
}

/**
 * The other stores of the district on the same date, each simulated in its own worker. The first call
 * starts them and later calls share the result, so opening Ask the store can start them early.
 */
export function loadDistrict(date: string): Promise<PeerStore[]> {
  let p = cache.get(date);
  if (!p) {
    p = Promise.all(DISTRICT_PEERS.map((s) => simulatePeer(s.id, date)));
    p.catch(() => cache.delete(date));
    cache.set(date, p);
  }
  return p;
}
