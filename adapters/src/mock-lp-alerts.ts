/**
 * Adapter: Vendor B's loss prevention alert feed -> OISS Incident and Evidence records.
 *
 * Vendor B is invented for the demo and labeled as mock. Its feed looks
 * like a typical vendor export: the vendor's own store code and register
 * numbers, its own camera names, EAN-13 codes, UTC epoch milliseconds and a
 * 0 to 100 score. The adapter does what any OISS adapter does:
 *
 * - maps the vendor's store, register and camera codes to ids in the
 *   retailer's StoreLayout, from a mapping table the retailer keeps;
 * - converts times to the store's local time with its UTC offset;
 * - writes items as 14-digit GTINs and checks each check digit;
 * - turns the score into a 0 to 1 confidence and the vendor's alert code
 *   into an OISS incident type;
 * - writes each clip as an Evidence record with its redaction, retention and
 *   the roles that may view it;
 * - rejects what it can't map, with a reason, instead of guessing.
 *
 * An Incident is a signal for a person to review, not an accusation, so the
 * adapter writes every one as open. Linking an incident to an anonymous
 * ShopperPath is left to a consumer that can see both, such as the loss
 * prevention agent.
 */

/** One alert in Vendor B's feed (newline-delimited JSON). */
export interface MockLpAlert {
  alert_id: string;
  /** The vendor's code for the store. */
  site: string;
  /** R01 to R08 for staffed registers, SCO01 to SCO06 for self-checkout stations. */
  register: string;
  /** When the vendor thinks the exception happened, epoch milliseconds, UTC. */
  event_ts: number;
  /** When the alert was raised, epoch milliseconds, UTC. */
  alert_ts: number;
  /** NSCN non-scan, BOTB bottom of basket, TKSW ticket switching, SWHT sweethearting. */
  alert_code: "NSCN" | "BOTB" | "TKSW" | "SWHT";
  /** 0 to 100. */
  score: number;
  items: { ean: string; qty: number; unit_price: number }[];
  clip: { camera: string; start_ts: number; end_ts: number; uri: string };
  mock: true;
}

export interface LpAdapterConfig {
  /** OISS store id. */
  store: string;
  /** The store's IANA time zone. */
  timezone: string;
  /** The vendor's code for this store. */
  site: string;
  /** Vendor register code -> StoreLayout fixture and zone ids, and the name store staff use for it. */
  registers: Record<string, { fixture: string; zone: string; name: string }>;
  /** Vendor camera name -> StoreLayout camera id. */
  cameras: Record<string, string>;
  /** How long clips are kept. */
  retentionDays: number;
  /** Who may view clips. */
  accessRoles: string[];
}

import { SCHEMA_BASE, localIso, midnightAfter, toGtin14 } from "./common.ts";

export { gs1CheckDigit, localIso, toGtin14 } from "./common.ts";

export const ADAPTER = { name: "mock-lp-alerts", version: "0.1.0" };

/** The mapping the retailer keeps for store demo-001. */
export function demo001Config(): LpAdapterConfig {
  const registers: LpAdapterConfig["registers"] = {};
  for (let i = 1; i <= 8; i++) registers[`R${String(i).padStart(2, "0")}`] = { fixture: `lane-${String(i).padStart(2, "0")}`, zone: "front-end", name: `Lane ${i}` };
  for (let i = 1; i <= 6; i++) registers[`SCO${String(i).padStart(2, "0")}`] = { fixture: `sco-${String(i).padStart(2, "0")}`, zone: "self-checkout", name: `Self-checkout ${i}` };
  return {
    store: "demo-001",
    timezone: "America/Los_Angeles",
    site: "DG0001",
    registers,
    cameras: { "FE-CAM-1": "cam-fe-1", "FE-CAM-2": "cam-fe-2", "SCO-CAM": "cam-sco" },
    retentionDays: 90,
    accessRoles: ["asset_protection", "store_manager"],
  };
}

const INCIDENT_TYPE = { NSCN: "non_scan", BOTB: "bottom_of_basket", TKSW: "ticket_switching", SWHT: "sweethearting" } as const;
const LABEL = { NSCN: "non-scan", BOTB: "bottom-of-basket", TKSW: "ticket switch", SWHT: "sweethearting" } as const;

export interface AdaptedRecord {
  specversion: "1.0";
  id: string;
  source: string;
  type: "oiss.Incident" | "oiss.Evidence";
  time: string;
  subject: string;
  dataschema: string;
  datacontenttype: "application/json";
  oissversion: "0.1";
  oissstore: string;
  oissprivacy: "restricted";
  data: Record<string, unknown>;
}

export interface AdaptResult {
  incidents: AdaptedRecord[];
  evidence: AdaptedRecord[];
  /** Vendor alert id -> the Incident record id it became. */
  incidentFor: Record<string, string>;
  rejected: { alert_id: string; reason: string }[];
}

const severityOf = (value: number): "low" | "medium" | "high" => (value < 10 ? "low" : value < 40 ? "medium" : "high");
const money = (n: number) => `$${n.toFixed(2)}`;

export function adaptLpAlerts(alerts: MockLpAlert[], config: LpAdapterConfig): AdaptResult {
  const source = `urn:oiss:${config.store}:mock-vendor-b:lp-alerts`;
  const provenance = { system: "Mock loss prevention", vendor: "Vendor B", model: { name: "exception-detector", version: "2.4" }, adapter: ADAPTER, synthetic: true };
  const result: AdaptResult = { incidents: [], evidence: [], incidentFor: {}, rejected: [] };
  const counters = new Map<string, number>();
  const nextId = (prefix: string, ms: number) => {
    const day = localIso(ms, config.timezone).slice(0, 10).replaceAll("-", "");
    const key = `${prefix}-${day}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return `${key}-${String(n).padStart(6, "0")}`;
  };
  const envelope = (type: AdaptedRecord["type"], id: string, ms: number, schema: string, data: Record<string, unknown>): AdaptedRecord => ({
    specversion: "1.0",
    id,
    source,
    type,
    time: localIso(ms, config.timezone),
    subject: id,
    dataschema: SCHEMA_BASE + schema,
    datacontenttype: "application/json",
    oissversion: "0.1",
    oissstore: config.store,
    oissprivacy: "restricted",
    data,
  });

  for (const a of alerts) {
    const reject = (reason: string) => result.rejected.push({ alert_id: a.alert_id, reason });
    if (a.site !== config.site) {
      reject(`unknown site ${a.site}`);
      continue;
    }
    const where = config.registers[a.register];
    if (!where) {
      reject(`unknown register ${a.register}`);
      continue;
    }
    const type = INCIDENT_TYPE[a.alert_code];
    if (!type) {
      reject(`unknown alert code ${a.alert_code}`);
      continue;
    }
    const gtins = a.items.map((i) => toGtin14(i.ean));
    if (gtins.some((g) => g === null)) {
      reject("an item code is not a valid EAN, UPC or GTIN");
      continue;
    }
    if (!(a.score >= 0 && a.score <= 100)) {
      reject(`score out of range: ${a.score}`);
      continue;
    }
    const camera = config.cameras[a.clip.camera];
    const window = { start: localIso(a.clip.start_ts, config.timezone), end: localIso(a.clip.end_ts, config.timezone) };
    const evidenceId = nextId("ev-lp", a.alert_ts);
    result.evidence.push(
      envelope("oiss.Evidence", evidenceId, a.alert_ts, "evidence.schema.json", {
        provenance,
        window,
        location: { zone: where.zone, fixture: where.fixture, ...(camera ? { camera } : {}) },
        mediaType: "video/mp4",
        uri: `mock-vendor-b/${a.clip.uri}`,
        redaction: "people_blurred",
        retainUntil: midnightAfter(a.alert_ts, config.retentionDays, config.timezone),
        accessRoles: config.accessRoles,
      }),
    );
    const value = Math.round(a.items.reduce((s, i) => s + i.qty * i.unit_price, 0) * 100) / 100;
    const units = a.items.reduce((s, i) => s + i.qty, 0);
    const incidentId = nextId("inc", a.alert_ts);
    result.incidentFor[a.alert_id] = incidentId;
    result.incidents.push(
      envelope("oiss.Incident", incidentId, a.alert_ts, "incident.schema.json", {
        provenance,
        window,
        location: { zone: where.zone, fixture: where.fixture },
        incidentType: type,
        severity: severityOf(value),
        status: "open",
        gtins: [...new Set(gtins as string[])],
        summary: `Possible ${LABEL[a.alert_code]} at ${where.name}: ${units} ${units === 1 ? "item" : "items"}, ${money(value)} at the register's prices. For review.`,
        confidence: Math.round(a.score) / 100,
        evidence: [evidenceId],
      }),
    );
  }
  return result;
}
