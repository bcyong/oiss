/**
 * What each mock vendor sent for one OISS record, found again in the vendor's own export.
 *
 * Vendor exports don't carry OISS ids, and OISS records don't carry the vendor's ids, so the demo
 * links them the way an auditor would: by place and time. A shelf read and a shelf label report
 * are at one facing at one second; a traffic row is one zone over one interval.
 */
import { layoutIndex, localToIso, type LayoutData } from "@oiss/adapters/common";
import { demo001EslConfig, type MockEslEvent } from "@oiss/adapters/mock-esl";
import { DEMO_001_SECTIONS, type MockShelfCapture, type MockShelfRead } from "@oiss/adapters/mock-shelf-scan";
import { DEMO_001_TRAFFIC_ZONES, demo001TrafficConfig, type MockTrafficRow, parseTrafficCsv, TRAFFIC_COLUMNS } from "@oiss/adapters/mock-traffic-csv";
import type { IndexedDay } from "./day.ts";
import type { AnyRecord } from "./oiss.ts";

export type VendorRaw =
  | { kind: "shelf-scan"; mission: string; capture: Omit<MockShelfCapture, "shelves">; read: MockShelfRead; levels: number }
  | { kind: "traffic"; header: string; line: string; row: MockTrafficRow }
  | { kind: "esl"; event: MockEslEvent };

interface Lookup {
  scans: Map<string, Extract<VendorRaw, { kind: "shelf-scan" }>>;
  traffic: Map<string, Extract<VendorRaw, { kind: "traffic" }>>;
  esl: Map<string, Extract<VendorRaw, { kind: "esl" }>>;
}

const cache = new WeakMap<IndexedDay, Lookup>();
const key = (place: string, ms: number) => `${place}|${Math.round(ms / 1000)}`;

function build(day: IndexedDay): Lookup {
  const out: Lookup = { scans: new Map(), traffic: new Map(), esl: new Map() };
  const feeds = day.files.vendorFeeds;
  // The mapping tables are store demo-001's; another store would keep its own.
  if (!feeds || day.files.store !== "demo-001") return out;
  const layout = day.layout as unknown as LayoutData;
  const index = layoutIndex(layout);
  const levels = new Map<string, number>();
  for (const s of layout.shelves) levels.set(s.fixture, Math.max(levels.get(s.fixture) ?? 0, s.level + 1));

  for (const m of feeds.mockShelfScans ?? []) {
    for (const { shelves, ...capture } of m.captures) {
      const fixture = DEMO_001_SECTIONS[capture.section];
      const n = fixture ? levels.get(fixture) : undefined;
      if (!fixture || n === undefined) continue;
      for (const read of shelves) {
        const place = index.at(fixture, n - read.shelf, capture.position);
        if (place) out.scans.set(key(place.facing, Date.parse(capture.ts)), { kind: "shelf-scan", mission: m.mission_id, capture, read, levels: n });
      }
    }
  }

  if (feeds.mockTrafficCsv) {
    const lines = feeds.mockTrafficCsv.split(/\r?\n/).filter((l) => l.trim() !== "");
    const { rows } = parseTrafficCsv(feeds.mockTrafficCsv);
    const tz = demo001TrafficConfig().timezone;
    rows.forEach((row, i) => {
      const zone = DEMO_001_TRAFFIC_ZONES[row.zone_code];
      const start = localToIso(row.interval_start, tz);
      if (zone && start) out.traffic.set(key(zone, Date.parse(start)), { kind: "traffic", header: TRAFFIC_COLUMNS.join(","), line: lines[i + 1] ?? "", row });
    });
  }

  const labels = demo001EslConfig(layout).labels;
  for (const event of feeds.mockEsl ?? []) {
    const facing = labels[event.label_id];
    if (facing) out.esl.set(key(facing, Date.parse(event.at)), { kind: "esl", event });
  }
  return out;
}

/** The vendor's own data behind a record, if the record came through one of the shelf, traffic or label adapters. */
export function vendorRawFor(day: IndexedDay, record: AnyRecord): VendorRaw | undefined {
  const source = record.source;
  if (!/:mock-vendor-[acd]:/.test(source) || record.type === "oiss.ShopperPath") return undefined;
  let lookup = cache.get(day);
  if (!lookup) {
    lookup = build(day);
    cache.set(day, lookup);
  }
  const d = record.data as { location?: { facing?: string; zone?: string }; window?: { start: string } };
  if (record.type === "oiss.ShelfObservation" && d.location?.facing) {
    const k = key(d.location.facing, Date.parse(record.time));
    return source.endsWith(":esl") ? lookup.esl.get(k) : lookup.scans.get(k);
  }
  if (record.type === "oiss.Evidence" && d.location?.facing) return lookup.scans.get(key(d.location.facing, Date.parse(record.time)));
  if (record.type === "oiss.ZoneMetric" && d.location?.zone && d.window) return lookup.traffic.get(key(d.location.zone, Date.parse(d.window.start)));
  return undefined;
}

/** What vendor sent it, in a few words. */
export const VENDOR_NAME: Record<VendorRaw["kind"], string> = {
  "shelf-scan": "Vendor A",
  traffic: "Vendor C",
  esl: "Vendor D",
};
