import type { DayRecords, ItemMaster } from "./oiss.ts";

export interface DayFiles {
  store: string;
  date: string;
  seed: number;
  origin: "golden" | "browser";
  records: DayRecords;
  itemMaster: ItemMaster;
  /** How long the browser took to simulate the day, for a day made in the browser. */
  simulatedInMs?: number;
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
  const [storeLayout, shelfObservations, zoneMetrics, shopperPaths, itemMaster] = await Promise.all([
    get(`${day.path}store-layout.json`).then((r) => r.json()),
    jsonl(`${day.path}shelf-observations.jsonl`),
    jsonl(`${day.path}zone-metrics.jsonl`),
    jsonl(`${day.path}shopper-paths.jsonl`),
    get(`${day.path}item-master.json`).then((r) => r.json()),
  ]);
  return {
    store: day.store,
    date: day.date,
    seed: day.seed,
    origin: "golden",
    records: { storeLayout, shelfObservations, zoneMetrics, shopperPaths } as DayRecords,
    itemMaster: itemMaster as ItemMaster,
  };
}

/** Runs the store simulator in a web worker, so a new day never blocks the page. */
export function simulateInBrowser(seed: number, date: string): Promise<DayFiles> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ records: DayRecords; itemMaster: ItemMaster; ms: number } | { error: string }>) => {
      worker.terminate();
      if ("error" in e.data) return reject(new Error(e.data.error));
      resolve({ store: e.data.records.storeLayout.oissstore, date, seed, origin: "browser", records: e.data.records, itemMaster: e.data.itemMaster, simulatedInMs: e.data.ms });
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "The simulator stopped"));
    };
    worker.postMessage({ seed, date });
  });
}
