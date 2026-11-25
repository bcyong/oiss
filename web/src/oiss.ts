// The parts of OISS v0.1 records that the demo reads. The app works only from OISS records
// (plus the retailer's item master), the same way any other consumer would.

export interface Point {
  x: number;
  y: number;
}
export interface Money {
  amount: number;
  currency: string;
}
export interface Provenance {
  system: string;
  vendor?: string;
  model?: { name: string; version?: string };
  adapter?: { name: string; version: string };
  synthetic?: boolean;
}
export interface Window {
  start: string;
  end: string;
}

export interface OissRecord<D> {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  time: string;
  subject: string;
  oissversion: string;
  oissstore: string;
  oissprivacy: string;
  dataschema?: string;
  datacontenttype?: string;
  data: D;
}

export interface Zone {
  id: string;
  name: string;
  kind: string;
  polygon: Point[];
}
export interface Fixture {
  id: string;
  zone: string;
  kind: string;
  footprint: Point[];
}
export interface Shelf {
  id: string;
  fixture: string;
  level: number;
  height: number;
}
export interface Facing {
  id: string;
  shelf: string;
  sequence: number;
  width: number;
  gtin: string;
  facings: number;
  capacity: number;
  shelfPrice?: Money;
}
export interface Camera {
  id: string;
  position: Point & { z: number };
  /** Degrees, 0 along +x, increasing toward +y. */
  yaw?: number;
  pitch?: number;
  hfov?: number;
  vfov?: number;
  range?: number;
  covers?: string[];
}
export interface StoreLayoutData {
  provenance: Provenance;
  store: { id: string; storeNumber: string; banner: string; name: string; timezone: string; floor: { width: number; depth: number; units: string } };
  planogramVersion: string;
  zones: Zone[];
  fixtures: Fixture[];
  shelves: Shelf[];
  facings: Facing[];
  cameras: Camera[];
}

export type ShelfStatus = "in_stock" | "low_stock" | "out_of_stock" | "unknown";
export interface ShelfObservationData {
  provenance: Provenance;
  window: Window;
  location: { zone: string; fixture: string; shelf: string; facing: string; camera?: string };
  status: ShelfStatus;
  observedGtin?: string;
  planogramGtin?: string;
  fillLevel?: number;
  tagPrice?: Money;
  systemPrice?: Money;
  flags?: string[];
  confidence: number;
  evidence?: string[];
}

export interface ZoneMetricData {
  provenance: Provenance;
  window: Window;
  location: { zone: string };
  metrics: {
    traffic?: number;
    avgOccupancy?: number;
    peakOccupancy?: number;
    avgDwellSeconds?: number;
    queueLength?: number;
    avgWaitSeconds?: number;
    openLanes?: number;
  };
  confidence: number;
}

export interface ShopperPathData {
  provenance: Provenance;
  window: Window;
  objectClass: string;
  idValidUntil: string;
  points: { t: string; x: number; y: number }[];
  confidence?: number;
}

export interface EvidenceData {
  provenance: Provenance;
  window: Window;
  location: { zone?: string; fixture?: string; shelf?: string; facing?: string; camera?: string };
  mediaType: string;
  uri: string;
  sha256?: string;
  redaction: string;
  retainUntil: string;
  accessRoles: string[];
}

/** The retailer's item master. Not an OISS record: OISS refers to items by GTIN. */
export interface ItemMaster {
  store: string;
  note: string;
  items: { gtin: string; name: string; department: string; category: string; price: Money; casePack: number; shrinkRisk: string; promo: boolean }[];
}

export interface DayRecords {
  storeLayout: OissRecord<StoreLayoutData>;
  shelfObservations: OissRecord<ShelfObservationData>[];
  zoneMetrics: OissRecord<ZoneMetricData>[];
  shopperPaths: OissRecord<ShopperPathData>[];
  /** Shelf images behind low-stock and out-of-stock reads. Days written before M2 have none. */
  evidence?: OissRecord<EvidenceData>[];
}

export type AnyRecord =
  | OissRecord<StoreLayoutData>
  | OissRecord<ShelfObservationData>
  | OissRecord<ZoneMetricData>
  | OissRecord<ShopperPathData>
  | OissRecord<EvidenceData>;
