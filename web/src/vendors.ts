/**
 * What each source in the demo stands for. The mock vendors are modeled on kinds of products that
 * retailers buy today, described by what they do, never by a real company's name.
 */
export interface SourceInfo {
  /** The kind of product it stands for. */
  kind: string;
  /** What it is, in a store team's words. */
  about: string;
  /** What it sends in the demo. */
  sends: string;
}

export const SOURCE_INFO: Record<string, SourceInfo> = {
  "Demo Grocery space planning": {
    kind: "Retailer's space planning system",
    about: "The planogram and floor-plan software category managers already use to decide what goes on each shelf.",
    sends: "One StoreLayout before opening: zones, fixtures, shelves, every facing with its GTIN, and camera positions. Every other record refers to it.",
  },
  "Mock shelf-scanning robot": {
    kind: "Autonomous shelf-scanning robot",
    about: "Modeled on the robots some US grocers run down every aisle several times a day, photographing each shelf to find out-of-stocks, misplaced items and wrong price tags.",
    sends: "A ShelfObservation for every facing it can reach, on seven runs a day from 8 AM, with shelf images as Evidence.",
  },
  "Store shelf cameras (in-house)": {
    kind: "Fixed shelf cameras, run by the retailer",
    about: "Cameras mounted across from high-value shelves, of the kind a chain builds on an edge AI platform such as NVIDIA Metropolis or buys from a shelf-camera vendor.",
    sends: "A look at aisle 3 and the dairy wall every 5 minutes, sending a ShelfObservation when a change holds for two looks. They can't read shelf tags.",
  },
  "Mock electronic shelf labels": {
    kind: "Electronic shelf labels",
    about: "Modeled on the radio-updated digital price labels now standard across much of European grocery and spreading in the US. The label system pushes overnight price changes and knows whether each label took its new price.",
    sends: "A ShelfObservation price check when a label confirms its new price or fails to, with the price it shows and no on-shelf status.",
  },
  "Mock people-counting system": {
    kind: "People counting and queue measurement",
    about: "Modeled on overhead 3D sensors at the doors and over the checkout lines, the kind stores use to staff lanes and measure conversion.",
    sends: "A ZoneMetric for every sales-floor zone every 15 minutes: traffic, occupancy and, at the front end, line length, wait and lanes open. The vendor's own export is a CSV.",
  },
  "Mock multi-camera tracker": {
    kind: "Anonymous shopper tracking",
    about: "The same vendor's ceiling cameras that follow shoppers across the store without identifying anyone, the technology behind cashierless checkout and store layout studies.",
    sends: "ShopperPaths of anonymous positions over time, with ids that change every 15 minutes, never a face or an identity.",
  },
  "Mock loss prevention": {
    kind: "Checkout loss prevention",
    about: "Modeled on computer vision over staffed lanes and self-checkout that spots missed scans and other exceptions as they happen, so a person can review a short clip.",
    sends: "An Incident for each exception, with its clip as Evidence carrying a retention date and access roles.",
  },
};
