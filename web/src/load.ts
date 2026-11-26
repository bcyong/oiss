import type { MockEslEvent } from "@oiss/adapters/mock-esl";
import type { MockLpAlert } from "@oiss/adapters/mock-lp-alerts";
import type { MockShelfScanMission } from "@oiss/adapters/mock-shelf-scan";
import type { Injection, RequestedTask, ShelfFault } from "@oiss/sim";
import type { DayRecords, ItemMaster } from "./oiss.ts";

export interface DayFiles {
  store: string;
  date: string;
  seed: number;
  origin: "golden" | "browser";
  records: DayRecords;
  itemMaster: ItemMaster;
  /**
   * Vendor exports exactly as the mock vendors sent them, before any adapter. Not OISS: the demo
   * keeps them only to show what an adapter starts from.
   */
  vendorFeeds?: VendorFeeds;
  /** How long the browser took to simulate the day, for a day made in the browser. */
  simulatedInMs?: number;
  /**
   * Faults the visitor injected, as the simulator played them out. Not OISS: this is what really
   * happened on the shelf, kept so the demo can show whether any record has caught each one yet.
   */
  injected?: ShelfFault[];
  /** Shelf tasks the visitor approved, which the simulator raised in the store's task system and played out. */
  requested?: RequestedTask[];
}

export interface VendorFeeds {
  mockShelfScans?: MockShelfScanMission[];
  mockLpAlerts?: MockLpAlert[];
  mockTrafficCsv?: string;
  mockEsl?: MockEslEvent[];
}

const base = import.meta.env.BASE_URL;

async function get(path: string): Promise<Response> {
  const res = await fetch(`${base}data/${path}`);
  if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status})`);
  return res;
}

const jsonl = async <T,>(path: string): Promise<T[]> =>
  (await (await get(path)).text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);

/** Loads the golden day that the build wrote to /data. */
export async function loadGoldenDay(): Promise<DayFiles> {
  const index = (await (await get("index.json")).json()) as { days: { store: string; date: string; seed: number; path: string }[] };
  const day = index.days[0];
  if (!day) throw new Error("No days in data/index.json");
  const [storeLayout, shelfObservations, zoneMetrics, shopperPaths, evidence, incidents, tasks, mockShelfScans, mockLpAlerts, mockTrafficCsv, mockEsl, itemMaster] = await Promise.all([
    get(`${day.path}store-layout.json`).then((r) => r.json()),
    jsonl(`${day.path}shelf-observations.jsonl`),
    jsonl(`${day.path}zone-metrics.jsonl`),
    jsonl(`${day.path}shopper-paths.jsonl`),
    jsonl(`${day.path}evidence.jsonl`),
    jsonl(`${day.path}incidents.jsonl`),
    jsonl(`${day.path}tasks.jsonl`),
    jsonl<MockShelfScanMission>(`${day.path}vendor/mock-vendor-a-shelf-scans.ndjson`),
    jsonl<MockLpAlert>(`${day.path}vendor/mock-vendor-b-lp-alerts.ndjson`),
    get(`${day.path}vendor/mock-vendor-c-traffic.csv`).then((r) => r.text()),
    jsonl<MockEslEvent>(`${day.path}vendor/mock-vendor-d-esl.ndjson`),
    get(`${day.path}item-master.json`).then((r) => r.json()),
  ]);
  return {
    store: day.store,
    date: day.date,
    seed: day.seed,
    origin: "golden",
    records: { storeLayout, shelfObservations, zoneMetrics, shopperPaths, evidence, incidents, tasks } as DayRecords,
    itemMaster: itemMaster as ItemMaster,
    vendorFeeds: { mockShelfScans, mockLpAlerts, mockTrafficCsv, mockEsl },
  };
}

/** Runs the store simulator in a web worker, so a new day never blocks the page. */
export function simulateInBrowser(seed: number, date: string, injections: Injection[] = [], requestedTasks: RequestedTask[] = []): Promise<DayFiles> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ records: DayRecords; itemMaster: ItemMaster; vendorFeeds: DayFiles["vendorFeeds"]; injected: ShelfFault[]; ms: number } | { error: string }>) => {
      worker.terminate();
      if ("error" in e.data) return reject(new Error(e.data.error));
      resolve({ store: e.data.records.storeLayout.oissstore, date, seed, origin: "browser", records: e.data.records, itemMaster: e.data.itemMaster, vendorFeeds: e.data.vendorFeeds, simulatedInMs: e.data.ms, injected: e.data.injected, ...(requestedTasks.length ? { requested: requestedTasks } : {}) });
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "The simulator stopped"));
    };
    worker.postMessage({ seed, date, injections, requestedTasks });
  });
}
