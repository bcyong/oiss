// How the demo reads OISS records of more than one version, the way spec/versioning.md asks any
// reader to. The demo store holds 0.2 records from most feeds and 0.1 records from the loss
// prevention vendor, which hasn't upgraded yet.

import type { DayRecords, OissRecord } from "./oiss.ts";

/** The OISS versions this demo can read, oldest first. */
export const READS = ["0.1", "0.2"] as const;
/** The version the demo reads every record as. */
export const CURRENT = READS[READS.length - 1]!;

export const OISS_RECORD_TYPES = new Set(["oiss.StoreLayout", "oiss.ShelfObservation", "oiss.ZoneMetric", "oiss.ShopperPath", "oiss.Incident", "oiss.Evidence", "oiss.Task"]);
export const PRIVACY_CLASSES = ["operational", "aggregate", "anonymous_path", "restricted"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

/**
 * The privacy class to apply. Privacy class and record type are closed vocabularies: a class or an
 * OISS type this reader doesn't know means restricted, so a record from a newer version can never
 * show more than it should.
 */
export function effectivePrivacy(r: Pick<OissRecord<unknown>, "type" | "oissprivacy">): PrivacyClass {
  if (!(PRIVACY_CLASSES as readonly string[]).includes(r.oissprivacy)) return "restricted";
  if (r.type.startsWith("oiss.") && !OISS_RECORD_TYPES.has(r.type)) return "restricted";
  return r.oissprivacy as PrivacyClass;
}

/**
 * Steps that turn a record of one version into the next. A minor version only adds, so its step
 * changes nothing; a major version's step does what its migration note says. The record keeps
 * the oissversion its producer wrote, so the inspector still shows where it came from.
 */
const UPGRADES: Record<string, { to: string; step: <R extends OissRecord<unknown>>(r: R) => R }> = {
  "0.1": { to: "0.2", step: (r) => r },
};

/** Whether the demo can read a record: a version it knows, and an OISS type it knows. */
export function canRead(r: OissRecord<unknown>): boolean {
  return (READS as readonly string[]).includes(r.oissversion) && OISS_RECORD_TYPES.has(r.type);
}

/** The record as the current version describes it. */
export function toCurrent<R extends OissRecord<unknown>>(r: R): R {
  let out = r;
  for (let v = r.oissversion; v !== CURRENT; ) {
    const up = UPGRADES[v];
    if (!up) throw new Error(`no upgrade from OISS ${v}`);
    out = up.step(out);
    v = up.to;
  }
  return out;
}

/**
 * A day's records as the demo reads them: every record of a version and type it knows, in the
 * current version's shape. Records it can't read, such as a vendor's own record types, are left
 * out, as a reader that wasn't built for them must.
 */
export function readable(records: DayRecords): DayRecords {
  const keep = <R extends OissRecord<unknown>>(rs: R[] | undefined): R[] | undefined => rs && rs.filter(canRead).map(toCurrent);
  return {
    storeLayout: toCurrent(records.storeLayout),
    shelfObservations: keep(records.shelfObservations)!,
    zoneMetrics: keep(records.zoneMetrics)!,
    shopperPaths: keep(records.shopperPaths)!,
    evidence: keep(records.evidence),
    incidents: keep(records.incidents),
    tasks: keep(records.tasks),
  };
}
