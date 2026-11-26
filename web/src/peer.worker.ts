import { simulatePeerStore } from "./peers.ts";

// Simulates one other store of the district, off the page's main thread.
self.onmessage = (e: MessageEvent<{ store: string; date: string }>) => {
  try {
    self.postMessage(simulatePeerStore(e.data.store, e.data.date));
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
