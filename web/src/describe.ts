import { clockOf, LABEL_SOURCE_SUFFIX, ROBOT_SOURCE_SUFFIX, type IndexedDay } from "./day.ts";
import type { AnyRecord, EvidenceData, IncidentData, OissRecord, ShelfObservationData, ShelfStatus, ShopperPathData, StoreLayoutData, TaskData, TaskKind, TaskState, ZoneMetricData } from "./oiss.ts";

export const STATUS_LABEL: Record<ShelfStatus | "none", string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  out_of_stock: "Out of stock",
  unknown: "Not readable",
  none: "Not yet observed",
};

/** Shelf observation flags, in the words a store team uses. */
export const FLAG_LABEL: Record<string, string> = {
  misplaced_item: "Misplaced item",
  price_mismatch: "Price mismatch",
};
export const flagName = (f: string) => FLAG_LABEL[f] ?? humanize(f);

/** What a flagged shelf observation found, in a sentence fragment, such as "the tag says $3.49 and the price file $3.99". */
export function flagDetail(day: IndexedDay, d: ShelfObservationData): string {
  const parts: string[] = [];
  if (d.flags?.includes("misplaced_item")) parts.push(`${(d.observedGtin && day.items.get(d.observedGtin)?.name) || "another item"} is on the facing`);
  if (d.flags?.includes("price_mismatch")) parts.push(`the shelf tag says ${money(d.tagPrice)} and the price file ${money(d.systemPrice)}`);
  return parts.join(", and ");
}

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
// How long something took, rounded for a person: "45 s", "73 min", "2 h 5 min".
export const elapsed = (s: number) => {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};
export const duration = (s?: number) => (s === undefined ? "–" : s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`);
export const humanize = (v: string) => v.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());

export const isType = <D,>(r: AnyRecord, type: string): r is OissRecord<D> & AnyRecord => r.type === type;

export function itemNameAt(day: IndexedDay, facingId: string | undefined): string {
  if (!facingId) return "";
  const i = day.facingById.get(facingId);
  const gtin = i === undefined ? undefined : day.facings[i]!.facing.gtin;
  return (gtin && day.items.get(gtin)?.name) || facingId;
}

/** A checkout lane or self-checkout station the way store staff say it, such as "Lane 3". */
export function checkoutName(id: string | undefined): string {
  if (!id) return "";
  const lane = /^lane-0*(\d+)$/.exec(id);
  if (lane) return `Lane ${lane[1]}`;
  const sco = /^sco-0*(\d+)$/.exec(id);
  if (sco) return `Self-checkout ${sco[1]}`;
  return id;
}

export const INCIDENT_LABEL: Record<string, string> = {
  non_scan: "Non-scan",
  ticket_switching: "Ticket switching",
  bottom_of_basket: "Bottom of basket",
  sweethearting: "Sweethearting",
  push_out: "Push-out",
  shelf_sweep: "Shelf sweep",
  safety_hazard: "Safety hazard",
  other: "Other",
};

export const INCIDENT_STATUS: Record<string, string> = {
  open: "Open, waiting for review",
  under_review: "Under review",
  confirmed: "Confirmed by a reviewer",
  dismissed: "Dismissed by a reviewer",
};

export const TASK_KIND: Record<TaskKind, string> = {
  replenish: "Replenish",
  recover: "Recovery",
  fix_shelf_tag: "Fix a shelf tag",
  go_back: "Go-back",
  open_lane: "Open a lane",
  review_exception: "Review an exception",
  cleanup: "Cleanup",
  other: "Other",
};

export const TASK_STATE: Record<TaskState, string> = {
  open: "Open",
  assigned: "Assigned",
  in_progress: "In progress",
  done: "Done",
  verified: "Verified",
  cancelled: "Cancelled",
};

/** Who a task is assigned to or raised by, such as "Dairy team" for team:dairy. */
export function assigneeName(id: string | undefined): string {
  if (!id) return "";
  const team = /^team:(.+)$/.exec(id);
  if (team) return `${humanize(team[1]!.replaceAll("-", " "))} team`;
  if (id === "system:task-management") return "Task management";
  return id;
}

export function zoneName(day: IndexedDay, id: string | undefined): string {
  return (id && day.zones.get(id)?.name) || id || "";
}

/** One line about a record, in retail terms, for lists. */
export function summarize(day: IndexedDay, r: AnyRecord): string {
  switch (r.type) {
    case "oiss.ShelfObservation": {
      const d = (r as OissRecord<ShelfObservationData>).data;
      const flags = d.flags?.length ? `, ${d.flags.map((f) => flagName(f).toLowerCase()).join(", ")}` : "";
      const what = d.status ? STATUS_LABEL[d.status].toLowerCase() : `shelf label shows ${money(d.tagPrice)}`;
      return `${itemNameAt(day, d.location.facing)}: ${what}${flags}`;
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
      if (d.mediaType.startsWith("video/")) return `Checkout clip: ${checkoutName(d.location.fixture)}`;
      return `Shelf image: ${itemNameAt(day, d.location.facing)}`;
    }
    case "oiss.Incident": {
      const d = (r as OissRecord<IncidentData>).data;
      return `Possible ${(INCIDENT_LABEL[d.incidentType] ?? humanize(d.incidentType)).toLowerCase()} at ${checkoutName(d.location.fixture)}, for review`;
    }
    case "oiss.Task": {
      const d = (r as OissRecord<TaskData>).data;
      return `${d.title}: ${TASK_STATE[d.state].toLowerCase()}${d.assignedTo && d.state === "assigned" ? `, ${assigneeName(d.assignedTo)}` : ""}`;
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

/** Where a shelf observation came from, in a few words. */
export function observer(r: { source: string; data: { location: { camera?: string } } }): string {
  if (r.data.location.camera) return `shelf camera ${r.data.location.camera}`;
  if (r.source.endsWith(ROBOT_SOURCE_SUFFIX)) return "the robot";
  if (r.source.endsWith(LABEL_SOURCE_SUFFIX)) return "the shelf labels";
  return r.source;
}
