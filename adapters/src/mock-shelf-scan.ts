/**
 * Adapter: Vendor A's shelf-scanning robot missions -> OISS ShelfObservation and Evidence records.
 *
 * Vendor A is invented for the demo and labeled as mock. Its export looks like a typical
 * robot vendor's: one report per scan mission, with the vendor's own store code and section codes,
 * bay positions, shelves counted from the top, EAN-13 item codes, UTC timestamps, a percentage
 * fill and the vendor's own exception codes ("PLUG" for an item filling another item's hole,
 * "PRICE" for a shelf tag that doesn't match the price file). The adapter:
 *
 * - maps the vendor's section codes to fixtures in the retailer's StoreLayout, and its bay position
 *   and top-down shelf number to the facing the planogram has there;
 * - checks that the item the vendor expected at a facing is the one the planogram puts there, so a
 *   robot working from an old planogram is caught instead of mislabeling facings;
 * - converts times to the store's local time with its UTC offset;
 * - writes items as 14-digit GTINs and checks each check digit;
 * - writes each shelf image as an Evidence record with its redaction, retention and viewer roles;
 * - rejects what it can't map, with a reason, instead of guessing.
 */
import { type Envelope, envelope, facingLocation, idCounter, type LayoutData, layoutIndex, localIso, midnightAfter, toGtin14 } from "./common.ts";

/** One shelf in one capture: everything the robot read at one facing. */
export interface MockShelfRead {
  /** Shelf number counted from the top of the fixture, 1 for the top shelf. */
  shelf: number;
  /** OK, LOW (under a quarter full), OOS (empty) or NOREAD (the robot couldn't read the shelf). */
  state: "OK" | "LOW" | "OOS" | "NOREAD";
  /** 0 to 100, in steps of 5. Missing for NOREAD. */
  fill_pct?: number;
  /** The item the vendor's copy of the planogram expects here, EAN-13. */
  expected: string;
  /** The item the robot saw, EAN-13, if any. */
  detected?: string;
  /** 0 to 1. */
  conf: number;
  /** The price the robot read off the shelf tag. Missing for NOREAD. */
  tag_price?: number;
  /** The price in the price file the retailer sends the vendor each night. */
  price_file?: number;
  /** PLUG: another item is filling this item's facing. PRICE: the tag doesn't match the price file. */
  exceptions: ("PLUG" | "PRICE")[];
  /** The crop of this shelf, kept for low, empty and exception reads. Relative to the mission. */
  image?: string;
}

/** One stop of the robot: a photo of every shelf at one bay position. */
export interface MockShelfCapture {
  capture_id: string;
  /** UTC, ISO 8601 with milliseconds. */
  ts: string;
  /** The vendor's code for the fixture, such as A03L for aisle 3, left side. */
  section: string;
  /** Position along the fixture, 1 at the left as you face it. */
  position: number;
  shelves: MockShelfRead[];
}

/** One scan mission, as Vendor A exports it (one JSON object per line). */
export interface MockShelfScanMission {
  mission_id: string;
  site: string;
  robot: string;
  started_at: string;
  ended_at: string;
  captures: MockShelfCapture[];
  mock: true;
}

export interface ShelfScanAdapterConfig {
  store: string;
  timezone: string;
  /** The vendor's code for this store. */
  site: string;
  /** The vendor's robot name -> the OISS source id for it. */
  robots: Record<string, string>;
  /** Vendor section code -> StoreLayout fixture id. */
  sections: Record<string, string>;
  /** The StoreLayout the facings are looked up in. */
  layout: LayoutData;
  /** How long a capture's exposure lasts, which becomes each record's window. */
  captureSeconds: number;
  /** Where the vendor's images are served from, relative to the retailer's evidence store. */
  imagePrefix: string;
  retentionDays: number;
  accessRoles: string[];
}

export const ADAPTER = { name: "mock-shelf-scan", version: "0.1.0" };

/** The vendor's section codes for store demo-001's fixtures. */
export const DEMO_001_SECTIONS: Record<string, string> = {
  ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => ["L", "R"].map((side) => [`A${String(i + 1).padStart(2, "0")}${side}`, `A${String(i + 1).padStart(2, "0")}-${side}`])).flat()),
  ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`END${String(i + 1).padStart(2, "0")}`, `EC-${String(i + 1).padStart(2, "0")}`])),
  "PROD-WALL": "PR-WALL",
  "PROD-T1": "PR-T1",
  "PROD-T2": "PR-T2",
  "BAKE-T1": "BK-T1",
  "BAKE-T2": "BK-T2",
  "DAIRY-WALL": "DA-WALL",
  "MEAT-WALL": "MT-WALL",
};

/** The mapping the retailer keeps for store demo-001, given its StoreLayout. */
/** The demo's own store. Every store of the district keeps the same codes, since all are built to one prototype. */
const DEMO_001 = { id: "demo-001", storeNumber: "0001" };

export function demo001ShelfScanConfig(layout: LayoutData, store: { id: string; storeNumber: string } = DEMO_001): ShelfScanAdapterConfig {
  return {
    store: store.id,
    timezone: "America/Los_Angeles",
    site: `DG${store.storeNumber}`,
    robots: { "MVA-R1": `urn:oiss:${store.id}:mock-vendor-a:robot-1` },
    sections: DEMO_001_SECTIONS,
    layout,
    captureSeconds: 4,
    imagePrefix: "mock-vendor-a/",
    retentionDays: 30,
    accessRoles: ["store_manager", "department_manager"],
  };
}

const STATUS = { OK: "in_stock", LOW: "low_stock", OOS: "out_of_stock", NOREAD: "unknown" } as const;
const FLAG = { PLUG: "misplaced_item", PRICE: "price_mismatch" } as const;
const usd = (amount: number) => ({ amount, currency: "USD" });

export interface ShelfScanResult {
  observations: Envelope<"oiss.ShelfObservation">[];
  evidence: Envelope<"oiss.Evidence">[];
  rejected: { capture_id: string; shelf?: number; reason: string }[];
}

export function adaptShelfScans(missions: MockShelfScanMission[], config: ShelfScanAdapterConfig): ShelfScanResult {
  const index = layoutIndex(config.layout);
  const levels = new Map<string, number>();
  for (const s of config.layout.shelves) levels.set(s.fixture, Math.max(levels.get(s.fixture) ?? 0, s.level + 1));
  const provenance = { system: "Mock shelf-scanning robot", vendor: "Vendor A", model: { name: "shelf-detector", version: "0.1" }, adapter: ADAPTER, synthetic: true };
  const result: ShelfScanResult = { observations: [], evidence: [], rejected: [] };
  const nextId = idCounter(config.timezone);
  const made: { ms: number; facing: string; obs: Envelope<"oiss.ShelfObservation">; ev?: Envelope<"oiss.Evidence"> }[] = [];

  for (const mission of missions) {
    const robot = config.robots[mission.robot];
    for (const c of mission.captures) {
      const reject = (reason: string, shelf?: number) => result.rejected.push({ capture_id: c.capture_id, ...(shelf !== undefined ? { shelf } : {}), reason });
      if (mission.site !== config.site) {
        reject(`unknown site ${mission.site}`);
        continue;
      }
      if (!robot) {
        reject(`unknown robot ${mission.robot}`);
        continue;
      }
      const fixture = config.sections[c.section];
      const ms = Date.parse(c.ts);
      if (!fixture || !levels.has(fixture)) {
        reject(`unknown section ${c.section}`);
        continue;
      }
      if (Number.isNaN(ms)) {
        reject(`unreadable time ${c.ts}`);
        continue;
      }
      for (const s of c.shelves) {
        const level = levels.get(fixture)! - s.shelf;
        const place = index.at(fixture, level, c.position);
        if (!place) {
          reject(`no facing at ${c.section} position ${c.position}, shelf ${s.shelf} from the top`, s.shelf);
          continue;
        }
        const expected = toGtin14(s.expected);
        const detected = s.detected === undefined ? undefined : toGtin14(s.detected);
        if (!expected || detected === null) {
          reject("an item code is not a valid EAN, UPC or GTIN", s.shelf);
          continue;
        }
        if (expected !== place.gtin) {
          reject(`the vendor expected ${expected} at ${place.facing}, but the planogram puts ${place.gtin ?? "nothing"} there`, s.shelf);
          continue;
        }
        const status = STATUS[s.state];
        if (!status) {
          reject(`unknown state ${s.state}`, s.shelf);
          continue;
        }
        const window = { start: localIso(ms - config.captureSeconds * 1000, config.timezone), end: localIso(ms, config.timezone) };
        const location = facingLocation(place);
        let ev: Envelope<"oiss.Evidence"> | undefined;
        if (s.image) {
          const id = nextId("ev-scan", ms);
          ev = envelope({
            type: "oiss.Evidence",
            id,
            source: robot.replace(/:[^:]+$/, ":evidence"),
            time: localIso(ms, config.timezone),
            subject: id,
            schema: "evidence.schema.json",
            store: config.store,
            privacy: "restricted",
            data: {
              provenance,
              window,
              location,
              mediaType: "image/jpeg",
              uri: `${config.imagePrefix}${mission.mission_id}/${s.image}`,
              redaction: "cropped_to_shelf",
              retainUntil: midnightAfter(ms, config.retentionDays, config.timezone),
              accessRoles: config.accessRoles,
            },
          });
        }
        const flags = s.exceptions.map((e) => FLAG[e]);
        const obs = envelope({
          type: "oiss.ShelfObservation",
          id: "",
          source: robot,
          time: localIso(ms, config.timezone),
          subject: place.facing,
          schema: "shelf-observation.schema.json",
          store: config.store,
          privacy: "operational",
          data: {
            provenance,
            window,
            location,
            status,
            ...(flags.length ? { flags } : {}),
            ...(detected ? { observedGtin: detected } : {}),
            planogramGtin: place.gtin,
            ...(s.fill_pct !== undefined ? { fillLevel: s.fill_pct / 100 } : {}),
            ...(s.tag_price !== undefined && s.price_file !== undefined ? { tagPrice: usd(s.tag_price), systemPrice: usd(s.price_file) } : {}),
            confidence: s.conf,
            ...(ev ? { evidence: [ev.id] } : {}),
          },
        });
        made.push({ ms, facing: place.facing, obs, ev });
      }
    }
  }
  // Records go out in time order, and in facing order for one capture, bottom shelf first.
  made.sort((a, b) => a.ms - b.ms || (a.facing < b.facing ? -1 : a.facing > b.facing ? 1 : 0));
  for (const m of made) {
    m.obs.id = nextId("so-scan", m.ms);
    result.observations.push(m.obs);
    if (m.ev) result.evidence.push(m.ev);
  }
  return result;
}
