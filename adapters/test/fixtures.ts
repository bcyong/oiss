import type { LayoutData } from "../src/common.ts";

/** A two-shelf slice of store demo-001's StoreLayout: aisle 3, left side, positions 1 and 2. */
export const LAYOUT: LayoutData = {
  store: { id: "demo-001", storeNumber: "0001", timezone: "America/Los_Angeles" },
  zones: [{ id: "aisle-03", kind: "aisle" }],
  fixtures: [{ id: "A03-L", zone: "aisle-03", kind: "gondola" }],
  shelves: [
    { id: "A03-L-S0", fixture: "A03-L", level: 0 },
    { id: "A03-L-S1", fixture: "A03-L", level: 1 },
  ],
  facings: [
    { id: "A03-L-S0-F01", shelf: "A03-L-S0", sequence: 1, gtin: "02000000003030" },
    { id: "A03-L-S0-F02", shelf: "A03-L-S0", sequence: 2, gtin: "02000000003047" },
    { id: "A03-L-S1-F01", shelf: "A03-L-S1", sequence: 1, gtin: "02000000003054" },
    { id: "A03-L-S1-F02", shelf: "A03-L-S1", sequence: 2, gtin: "02000000003061" },
  ],
};
