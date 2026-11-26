/**
 * Who stands behind each source in the demo. Vendors A to D are made up, modeled on kinds of companies that
 * sell to retailers today, described by what they do, never by a real company's name.
 */
export interface Vendor {
  /** As records name it in provenance.vendor, or the retailer for its own systems. */
  name: string;
  /** What kind of company or system it is, in a few words. */
  kind: string;
  /** A general description, one paragraph each. */
  about: string[];
  /** The feeds it sends in the demo, by provenance.system. */
  systems: string[];
}

export const VENDORS: Vendor[] = [
  {
    name: "Vendor A",
    kind: "Shelf-scanning robots",
    about: [
      "Vendor A makes autonomous shelf-scanning robots for grocery and mass-merchandise stores. It uses a fleet of mobile robots, each carrying high-resolution cameras and depth sensors on a mast, that drive the aisles on a schedule and photograph every shelf from floor to top.",
      "Computer vision on those images finds out-of-stocks, low stock, misplaced items and shelf tags whose price doesn't match the price file. The retailer usually sees the results in the vendor's own dashboard and associate app.",
    ],
    systems: ["Mock shelf-scanning robot"],
  },
  {
    name: "Vendor B",
    kind: "Checkout loss prevention",
    about: [
      "Vendor B sells computer vision loss prevention for the front end. It uses overhead cameras at staffed lanes and self-checkout, with models that compare what crosses the scanner to what the register records.",
      "When an item leaves the lane without a scan, or a cheaper item is scanned in its place, it raises an alert with a short clip for a person to review. It never identifies the shopper.",
    ],
    systems: ["Mock loss prevention"],
  },
  {
    name: "Vendor C",
    kind: "People counting and store analytics",
    about: [
      "Vendor C sells people counting and in-store analytics. It uses ceiling-mounted 3D stereo sensors at the doors and over the front end to count shoppers in and out, measure occupancy, and time lines at each checkout, so stores can staff lanes and measure conversion.",
      "The same sensors follow anonymous shoppers across the floor for layout and display studies, the technology behind cashierless checkout. The vendor delivers its counts as a CSV every 15 minutes.",
    ],
    systems: ["Mock people-counting system", "Mock multi-camera tracker"],
  },
  {
    name: "Vendor D",
    kind: "Electronic shelf labels",
    about: [
      "Vendor D makes electronic shelf labels: battery-powered digital price labels on every facing, updated by radio from ceiling base stations. They are standard across much of European grocery and spreading in the US.",
      "Price changes from the retailer's price file go out overnight, and each label confirms when it shows its new price, so the system knows which labels failed. A label shows a price; it can't see what's on the shelf.",
    ],
    systems: ["Mock electronic shelf labels"],
  },
  {
    name: "Demo Grocery",
    kind: "The retailer's own systems",
    about: [
      "Demo Grocery runs three sources itself. Its space planning system is the planogram and floor-plan software category managers already use to decide what goes on each shelf, and it publishes the StoreLayout every other record refers to.",
      "It also runs its own fixed shelf cameras over aisle 3 and the dairy wall, built on an edge AI platform such as NVIDIA Metropolis. They report a change on a shelf when it holds for two looks, but can't read shelf tags.",
      "Its task management system is the work list store teams already carry on handhelds. It raises a Task when OISS records call for work, such as an out-of-stock read or a long wait at the staffed lanes, assigns it to a department team, and closes it when a later record from any vendor shows the fix.",
    ],
    systems: ["Demo Grocery space planning", "Store shelf cameras (in-house)", "Demo Grocery task management"],
  },
];

/** The vendor behind a source system, if the demo knows it. */
export function vendorOf(system: string): Vendor | undefined {
  return VENDORS.find((v) => v.systems.includes(system));
}
