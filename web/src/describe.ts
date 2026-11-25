import { clockOf, type IndexedDay } from "./day.ts";
import type { AnyRecord, EvidenceData, OissRecord, ShelfObservationData, ShelfStatus, ShopperPathData, StoreLayoutData, ZoneMetricData } from "./oiss.ts";

export const STATUS_LABEL: Record<ShelfStatus | "none", string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  unknown: "Not readable",
  none: "Not yet observed",
};

export const PRIVACY: Record<string, { label: string; meaning: string }> = {
  operational: { label: "Operational", meaning: "Nothing about people. For store teams and agents." },
  aggregate: { label: "Aggregate", meaning: "Counts and averages over people, never individuals." },
  anonymous_path: { label: "Anonymous path", meaning: "One unnamed shopper's movement, with an id that changes every 15 minutes." },
  restricted: { label: "Restricted", meaning: "Media and incidents. Named roles only." },
};

/** Each record type's schema page in the spec browser. */
export const SPEC_SLUG: Record<string, string> = {
  "oiss.StoreLayout": "store-layout",
  "oiss.ShelfObservation": "shelf-observation",
  "oiss.ZoneMetric": "zone-metric",
  "oiss.ShopperPath": "shopper-path",
  "oiss.Incident": "incident",
  "oiss.Evidence": "evidence",
  "oiss.Task": "task",
};

export const typeName = (type: string) => type.replace(/^oiss\./, "");

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const money = (m?: { amount: number; currency: string }) => (m ? m.amount.toLocaleString("en-US", { style: "currency", currency: m.currency }) : "");
export const duration = (s?: number) => (s === undefined ? "–" : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);
export const humanize = (v: string) => v.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

export const isType = <D,>(r: AnyRecord, type: string): r is OissRecord<D> & AnyRecord => r.type === type;

export function itemNameAt(day: IndexedDay, facingId: string | undefined): string {
  if (!facingId) return "";
  const i = day.facingById.get(facingId);
  const gtin = i === undefined ? undefined : day.facings[i]!.facing.gtin;
  return (gtin && day.items.get(gtin)?.name) || facingId;
}

export function zoneName(day: IndexedDay, id: string | undefined): string {
  return (id && day.zones.get(id)?.name) || id || "";
}

/** One line about a record, in retail terms, for lists. */
export function summarize(day: IndexedDay, r: AnyRecord): string {
  switch (r.type) {
    case "oiss.ShelfObservation": {
      const d = (r as OissRecord<ShelfObservationData>).data;
      return `${itemNameAt(day, d.location.facing)}: ${STATUS_LABEL[d.status].toLowerCase()}`;
    }
    case "oiss.ZoneMetric": {
      const d = (r as OissRecord<ZoneMetricData>).data;
      const m = d.metrics;
      const name = zoneName(day, d.location.zone).split(", ")[0];
      if (m.queueLength !== undefined) return `${name}: ${m.queueLength} in line, ${m.openLanes ?? 0} open`;
      return `${name}: ${m.traffic ?? 0} entered, ${m.avgOccupancy ?? 0} on average`;
    }
    case "oiss.ShopperPath": {
      const d = (r as OissRecord<ShopperPathData>).data;
      return `Anonymous shopper, ${d.points.length} points over ${duration((Date.parse(d.window.end) - Date.parse(d.window.start)) / 1000)}`;
    }
    case "oiss.Evidence": {
      const d = (r as OissRecord<EvidenceData>).data;
      return `Shelf image: ${itemNameAt(day, d.location.facing)}`;
    }
    case "oiss.StoreLayout": {
      const d = (r as OissRecord<StoreLayoutData>).data;
      return `Store layout and planogram ${d.planogramVersion}`;
    }
    default:
      return r.subject;
  }
}

export const timeOf = (day: IndexedDay, r: AnyRecord) => clockOf(day, r.time);
