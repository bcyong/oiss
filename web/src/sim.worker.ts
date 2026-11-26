import { runDay, type Injection } from "@oiss/sim";

// Only the OISS records, the item master and the raw vendor feeds leave the worker: the page sees what any
// OISS consumer would, plus what one vendor sent before the adapter, to show what an adapter does. The one
// exception is the faults the visitor injected, so the page can say whether any record has caught them.
self.onmessage = (e: MessageEvent<{ seed: number; date: string; injections: Injection[] }>) => {
  try {
    const t0 = performance.now();
    const day = runDay({ seed: e.data.seed, date: e.data.date, injections: e.data.injections });
    self.postMessage({
      records: day.records,
      itemMaster: day.itemMaster,
      vendorFeeds: { mockLpAlerts: day.vendorExports.mockLpAlerts },
      injected: day.ground.faults.filter((f) => f.injected),
      ms: Math.round(performance.now() - t0),
    });
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
