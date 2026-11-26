/**
 * Adapter: Vendor D's electronic shelf label events -> OISS ShelfObservation records.
 *
 * Vendor D is invented for the demo and labeled as mock. An electronic shelf label (ESL)
 * system knows two things about each label: the item it is linked to and the price it shows. When
 * the retailer's price file changes, the ESL system sends each label its new price and reports
 * whether the label confirmed it. Its export is a stream of those reports, with the vendor's own
 * label ids, EAN-13 item codes, prices as decimal strings and UTC times. The adapter:
 *
 * - maps each label to the facing it sits on, from the label-to-location table the retailer keeps;
 * - checks that the item the label is linked to is the one the planogram puts on that facing,
 *   since a label linked to the wrong item shows the wrong item's price;
 * - writes each report as a price check: a ShelfObservation with the label's price as tagPrice, the
 *   price it was sent as systemPrice, a price_mismatch flag when they differ, and no on-shelf
 *   availability, since a label can't see the shelf;
 * - converts times to the store's local time with its UTC offset;
 * - rejects what it can't map, with a reason, instead of guessing.
 *
 * A label only knows what it shows. A paper sale sign taped over a correct label is a price
 * mismatch the ESL system never sees; a shelf scan does.
 */
import { type Envelope, envelope, facingLocation, idCounter, type LayoutData, layoutIndex, localIso, toGtin14 } from "./common.ts";

/** One report in Vendor D's feed (newline-delimited JSON). */
export interface MockEslEvent {
  event_id: string;
  /** The vendor's code for the store. */
  store_ref: string;
  label_id: string;
  /** The item the label is linked to, EAN-13. */
  item: string;
  /** PRICE_CONFIRMED: the label shows the price it was sent. UPDATE_FAILED: it still shows its old price. */
  event: "PRICE_CONFIRMED" | "UPDATE_FAILED";
  /** The price the label shows, such as "4.49". */
  displayed_price: string;
  /** The price the label was sent. */
  target_price: string;
  /** 1 for the first try, then one more for each retry. */
  attempt: number;
  /** UTC, ISO 8601. */
  at: string;
  mock: true;
}

export interface EslAdapterConfig {
  store: string;
  timezone: string;
  storeRef: string;
  /** Label id -> StoreLayout facing id: the retailer's label-to-location table. */
  labels: Record<string, string>;
  layout: LayoutData;
  /** How sure a report is, by event: a confirmation comes from the label itself; a failure repeats the last price it confirmed. */
  confidence: Record<MockEslEvent["event"], number>;
}

export const ADAPTER = { name: "mock-esl", version: "0.1.0" };

/** The label on a facing in store demo-001. Label ids are the vendor's; this table stands in for the retailer's linking records. */
export function eslLabelFor(facing: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < facing.length; i++) h = Math.imul(h ^ facing.charCodeAt(i), 0x01000193);
  return `ESL-${(h >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

export function demo001EslConfig(layout: LayoutData): EslAdapterConfig {
  return {
    store: "demo-001",
    timezone: "America/Los_Angeles",
    storeRef: "0001",
    labels: Object.fromEntries(layout.facings.map((f) => [eslLabelFor(f.id), f.id])),
    layout,
    confidence: { PRICE_CONFIRMED: 0.99, UPDATE_FAILED: 0.9 },
  };
}

const price = (s: string) => (/^\d+(\.\d{1,2})?$/.test(s.trim()) ? Math.round(Number(s) * 100) / 100 : null);

export interface EslResult {
  observations: Envelope<"oiss.ShelfObservation">[];
  rejected: { event_id: string; reason: string }[];
}

export function adaptEslEvents(events: MockEslEvent[], config: EslAdapterConfig): EslResult {
  const index = layoutIndex(config.layout);
  const source = `urn:oiss:${config.store}:mock-vendor-d:esl`;
  const provenance = { system: "Mock electronic shelf labels", vendor: "Vendor D", adapter: ADAPTER, synthetic: true };
  const result: EslResult = { observations: [], rejected: [] };
  const nextId = idCounter(config.timezone);
  for (const e of events) {
    const reject = (reason: string) => result.rejected.push({ event_id: e.event_id, reason });
    if (e.store_ref !== config.storeRef) {
      reject(`unknown store ${e.store_ref}`);
      continue;
    }
    const facing = config.labels[e.label_id];
    const place = facing ? index.facing(facing) : undefined;
    if (!place) {
      reject(`label ${e.label_id} isn't linked to a facing in the StoreLayout`);
      continue;
    }
    const gtin = toGtin14(e.item);
    if (!gtin) {
      reject(`item code ${e.item} is not a valid EAN, UPC or GTIN`);
      continue;
    }
    if (gtin !== place.gtin) {
      reject(`label ${e.label_id} is linked to ${gtin}, but the planogram puts ${place.gtin ?? "nothing"} on ${place.facing}`);
      continue;
    }
    const shown = price(e.displayed_price);
    const sent = price(e.target_price);
    if (shown === null || sent === null) {
      reject("a price is not a decimal amount");
      continue;
    }
    const confidence = config.confidence[e.event];
    const ms = Date.parse(e.at);
    if (confidence === undefined || Number.isNaN(ms)) {
      reject(confidence === undefined ? `unknown event ${e.event}` : `unreadable time ${e.at}`);
      continue;
    }
    const time = localIso(ms, config.timezone);
    result.observations.push(
      envelope({
        type: "oiss.ShelfObservation",
        id: nextId("so-esl", ms),
        source,
        time,
        subject: place.facing,
        schema: "shelf-observation.schema.json",
        store: config.store,
        privacy: "operational",
        data: {
          provenance,
          window: { start: time, end: time },
          location: facingLocation(place),
          ...(shown !== sent ? { flags: ["price_mismatch"] } : {}),
          planogramGtin: gtin,
          tagPrice: { amount: shown, currency: "USD" },
          systemPrice: { amount: sent, currency: "USD" },
          confidence,
        },
      }),
    );
  }
  return result;
}
