/**
 * What every adapter in this folder needs: GS1 item codes, and vendor times turned into the
 * store's local time with its UTC offset, which is how OISS writes every time.
 */

/** The OISS version these adapters write, unless an adapter says otherwise. */
export const OISS_VERSION = "0.2";
/** OISS versions an adapter can write. */
export type OissVersion = "0.1" | "0.2";

/** Where a version's schemas are published: its git tag, never a branch, so they can't change. See schemas/versions.json. */
export const schemaBase = (version: OissVersion) => `https://raw.githubusercontent.com/bcyong/oiss/v${version}/schemas/v${version}/`;
export const SCHEMA_BASE = schemaBase(OISS_VERSION);

/** GS1 check digit for the digits before it. */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[body.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

/** An EAN-13, UPC-A or GTIN-14 as a 14-digit GTIN, or null if it isn't a valid one. */
export function toGtin14(code: string): string | null {
  if (!/^\d{12,14}$/.test(code)) return null;
  const gtin = code.padStart(14, "0");
  return gs1CheckDigit(gtin.slice(0, 13)) === Number(gtin[13]) ? gtin : null;
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, string>();

/** The UTC offset of a time zone at an instant, as "-08:00". */
export function offsetAt(ms: number, timezone: string): string {
  // Offsets change only on a quarter hour (UTC), so one lookup per zone and quarter hour is enough.
  const key = `${timezone}|${Math.floor(ms / 900_000)}`;
  const hit = offsetCache.get(key);
  if (hit) return hit;
  let format = offsetFormats.get(timezone);
  if (!format) offsetFormats.set(timezone, (format = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })));
  const offset = readOffset(format.formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value ?? "GMT", timezone);
  offsetCache.set(key, offset);
  return offset;
}

function readOffset(name: string, timezone: string): string {
  if (name === "GMT") return "+00:00";
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!m) throw new Error(`can't read the UTC offset for ${timezone}: ${name}`);
  return `${m[1]}${m[2]!.padStart(2, "0")}:${m[3] ?? "00"}`;
}

/** Epoch milliseconds -> RFC 3339 in the store's local time, to the second. */
export function localIso(ms: number, timezone: string): string {
  const offset = offsetAt(ms, timezone);
  const sign = offset.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(Math.round(ms / 1000) * 1000 + minutes * 60_000);
  return local.toISOString().slice(0, 19) + offset;
}

/** Local midnight, a number of days after the local date of an instant. */
export function midnightAfter(ms: number, days: number, timezone: string): string {
  const date = localIso(ms, timezone).slice(0, 10);
  const later = new Date(`${date}T12:00:00Z`);
  later.setUTCDate(later.getUTCDate() + days);
  const day = later.toISOString().slice(0, 10);
  // Read the offset at local noon that day, so a daylight saving change in between is handled.
  return `${day}T00:00:00${offsetAt(Date.parse(`${day}T12:00:00Z`), timezone)}`;
}

/**
 * A local wall-clock time with no offset, "YYYY-MM-DD HH:MM[:SS]", as RFC 3339 with the store's
 * offset. In the hour that repeats when daylight saving time ends, it takes the first one.
 */
export function localToIso(local: string, timezone: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const wall = `${m[1]}T${m[2]}:${m[3]}:${m[4] ?? "00"}`;
  const asUtc = Date.parse(`${wall}Z`);
  if (Number.isNaN(asUtc)) return null;
  // Try the offsets in force a day either side, earliest instant first, and keep the one that reads back as this wall time.
  const candidates = [...new Set([offsetAt(asUtc - 86_400_000, timezone), offsetAt(asUtc, timezone), offsetAt(asUtc + 86_400_000, timezone)])];
  const instants = candidates.map((o) => Date.parse(`${wall}${o}`)).sort((a, b) => a - b);
  for (const ms of instants) if (localIso(ms, timezone).slice(0, 19) === wall) return localIso(ms, timezone);
  return null; // a time skipped when daylight saving time starts
}

/** Cents or a decimal string from a vendor, as dollars to the cent. */
export const dollars = (n: number) => Math.round(n * 100) / 100;

/** The parts of an OISS StoreLayout's data that adapters look things up in. */
export interface LayoutData {
  store: { id: string; storeNumber?: string; timezone: string };
  zones: { id: string; name?: string; kind?: string }[];
  fixtures: { id: string; zone: string; kind?: string }[];
  shelves: { id: string; fixture: string; level: number }[];
  facings: { id: string; shelf: string; sequence: number; gtin?: string; shelfPrice?: { amount: number; currency: string } }[];
}

export interface FacingPlace {
  zone: string;
  fixture: string;
  shelf: string;
  facing: string;
  gtin?: string;
}

/** Find facings in a StoreLayout by fixture, shelf level and position, or by the item the planogram puts there. */
export function layoutIndex(layout: LayoutData) {
  const fixtures = new Map(layout.fixtures.map((f) => [f.id, f]));
  const shelves = new Map(layout.shelves.map((s) => [s.id, s]));
  const byPosition = new Map<string, FacingPlace>();
  const byGtin = new Map<string, FacingPlace[]>();
  const byId = new Map<string, FacingPlace>();
  for (const f of layout.facings) {
    const shelf = shelves.get(f.shelf);
    const fixture = shelf && fixtures.get(shelf.fixture);
    if (!shelf || !fixture) continue;
    const place: FacingPlace = { zone: fixture.zone, fixture: fixture.id, shelf: shelf.id, facing: f.id, ...(f.gtin ? { gtin: f.gtin } : {}) };
    byPosition.set(`${fixture.id}|${shelf.level}|${f.sequence}`, place);
    byId.set(f.id, place);
    if (f.gtin) byGtin.set(f.gtin, [...(byGtin.get(f.gtin) ?? []), place]);
  }
  return {
    /** The facing at a fixture, shelf level (0 at the bottom) and position along the shelf (1 at the left). */
    at: (fixture: string, level: number, sequence: number) => byPosition.get(`${fixture}|${level}|${sequence}`),
    /** The facings the planogram gives an item. */
    forGtin: (gtin: string) => byGtin.get(gtin) ?? [],
    facing: (id: string) => byId.get(id),
    fixtures,
  };
}

/** Where an OISS record says something happened at a facing. */
export const facingLocation = (p: FacingPlace) => ({ zone: p.zone, fixture: p.fixture, shelf: p.shelf, facing: p.facing });

/** An OISS record envelope as the adapters write it (CloudEvents 1.0, structured JSON). */
export interface Envelope<T extends string = string> {
  specversion: "1.0";
  id: string;
  source: string;
  type: T;
  time: string;
  subject: string;
  dataschema: string;
  datacontenttype: "application/json";
  oissversion: OissVersion;
  oissstore: string;
  oissprivacy: "operational" | "aggregate" | "anonymous_path" | "restricted";
  data: Record<string, unknown>;
}

export function envelope<T extends string>(fields: { type: T; id: string; source: string; time: string; subject: string; schema: string; store: string; privacy: Envelope["oissprivacy"]; data: Record<string, unknown> }): Envelope<T> {
  return {
    specversion: "1.0",
    id: fields.id,
    source: fields.source,
    type: fields.type,
    time: fields.time,
    subject: fields.subject,
    dataschema: SCHEMA_BASE + fields.schema,
    datacontenttype: "application/json",
    oissversion: OISS_VERSION,
    oissstore: fields.store,
    oissprivacy: fields.privacy,
    data: fields.data,
  };
}

/** Ids for one adapter run: prefix-YYYYMMDD-000001, counted per local day. */
export function idCounter(timezone: string) {
  const counters = new Map<string, number>();
  return (prefix: string, ms: number) => {
    const key = `${prefix}-${localIso(ms, timezone).slice(0, 10).replaceAll("-", "")}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return `${key}-${String(n).padStart(6, "0")}`;
  };
}
