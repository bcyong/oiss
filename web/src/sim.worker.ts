import { runDay } from "@oiss/sim";

// Only the OISS records, the item master and the raw vendor feeds leave the worker: the page sees what any
// OISS consumer would, plus what one vendor sent before the adapter, to show what an adapter does.
self.onmessage = (e: MessageEvent<{ seed: number; date: string }>) => {
  try {
    const t0 = performance.now();
    const day = runDay({ seed: e.data.seed, date: e.data.date });
    self.postMessage({ records: day.records, itemMaster: day.itemMaster, vendorFeeds: { mockLpAlerts: day.vendorExports.mockLpAlerts }, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
