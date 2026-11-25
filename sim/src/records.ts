/** OISS v0.1 record envelopes (CloudEvents 1.0, structured JSON). See spec/envelope.md. */

export const OISS_VERSION = "0.1";
export const SCHEMA_BASE = "https://raw.githubusercontent.com/bcyong/oiss/main/schemas/v0.1/";
export const SIM_VERSION = "0.1.0";

export type RecordType = "StoreLayout" | "ShelfObservation" | "ZoneMetric" | "ShopperPath" | "Incident" | "Evidence" | "Task";
export type PrivacyClass = "operational" | "aggregate" | "anonymous_path" | "restricted";

const SCHEMA_FILE: Record<RecordType, string> = {
  StoreLayout: "store-layout.schema.json",
  ShelfObservation: "shelf-observation.schema.json",
  ZoneMetric: "zone-metric.schema.json",
  ShopperPath: "shopper-path.schema.json",
  Incident: "incident.schema.json",
  Evidence: "evidence.schema.json",
  Task: "task.schema.json",
};

export interface OissRecord<D = Record<string, unknown>> {
  specversion: "1.0";
  id: string;
  source: string;
  type: `oiss.${RecordType}`;
  time: string;
  subject: string;
  dataschema: string;
  datacontenttype: "application/json";
  oissversion: typeof OISS_VERSION;
  oissstore: string;
  oissprivacy: PrivacyClass;
  data: D;
}

export interface Provenance {
  system: string;
  vendor?: string;
  model?: { name: string; version?: string };
  adapter?: { name: string; version: string };
  synthetic?: boolean;
}

export function record<D>(type: RecordType, fields: { id: string; source: string; time: string; subject: string; store: string; privacy: PrivacyClass; data: D }): OissRecord<D> {
  return {
    specversion: "1.0",
    id: fields.id,
    source: fields.source,
    type: `oiss.${type}`,
    time: fields.time,
    subject: fields.subject,
    dataschema: SCHEMA_BASE + SCHEMA_FILE[type],
    datacontenttype: "application/json",
    oissversion: OISS_VERSION,
    oissstore: fields.store,
    oissprivacy: fields.privacy,
    data: fields.data,
  };
}

/** Record ids unique per source and day: prefix-YYYYMMDD-000001. */
export function idMaker(prefix: string, date: string): () => string {
  let n = 0;
  const day = date.replaceAll("-", "");
  return () => `${prefix}-${day}-${String(++n).padStart(6, "0")}`;
}

export const byTime = (a: OissRecord, b: OissRecord): number => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
