import { runDay } from "@oiss/sim";

// Only the OISS records and the item master leave the worker: the page sees what any OISS consumer would.
self.onmessage = (e: MessageEvent<{ seed: number; date: string }>) => {
  try {
    const t0 = performance.now();
    const day = runDay({ seed: e.data.seed, date: e.data.date });
    self.postMessage({ records: day.records, itemMaster: day.itemMaster, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
