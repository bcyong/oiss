# Web app

The public site, deployed to Netlify from this repository (see [deploy-netlify.md](../docs/deploy-netlify.md)). Every page shares one header, with RFC, Schemas and Demo on the left and GitHub on the right, and no header link leaves the site. The header and footer live in [`site/layout.ts`](site/layout.ts), and a Vite plugin, [`site/plugin.ts`](site/plugin.ts), puts them into each page at build time.

- **`/`**: the OISS landing page, laid out like a blueprint card: overview, architecture diagram, key features, record types, what adoption takes, software used, ethical considerations and license. Plain HTML and CSS in [`index.html`](index.html) and [`src/landing.css`](src/landing.css).
- **`/demo/`**: the demo store, built with React and SVG. It reads only OISS records and the retailer's item master, the same way any OISS consumer would.
- **`/rfc/`**: the OISS RFC, rendered at build time from [`docs/rfc/OISS-RFC.md`](../docs/rfc/OISS-RFC.md) by a small Markdown renderer in [`site/markdown.ts`](site/markdown.ts). Edit the Markdown to change the page.
- **`/github/`**: an overview of the repository, with links out to GitHub from the page itself.
- **`/spec/`**: the spec browser. Every record type with its fields, rules, vocabularies and the valid example, read straight from the current version's schemas (`schemas/v0.2`) and `examples/valid` at build time.

## The demo store

- **Story**, the tab the demo opens on: four moments a store team would act on, found in the day's records the way any OISS consumer could: the lunch rush at the front end, a promoted item running out, two systems disagreeing on a shelf price, and a checkout incident to review. Each says what happened and why it matters, and tapping it jumps the floor plan and inspector to that moment. A day simulated in the browser gets its own moments, and a moment drops out when its feed is switched off.
- **Ask the store** is the Store Operations Assistant. Ask about the store at the playback time, or tap a sample question. A router sends the question to one of five agents (availability, price and label, front end, loss prevention, store insights), and the agent answers from read-only tools over the day's OISS records as they stood at that time: shelf gaps by priority, an item's latest reads from each source, store tasks, shelf tag issues, the front end's lines and waits, zone traffic, checkout exceptions, where two vendors disagree about a shelf, and how the store compares with the other stores in its district. Those other stores are simulated in the browser when Ask the store opens, from the same prototype floor plan with different traffic, shelf recovery, supply and staffing, and only their figures leave the worker that simulates them. Every answer cites the records it used, and each cited id opens that record in the inspector. An id the tools didn't return is counted under the answer. The tools run in the browser, in [`src/assistant/tools.ts`](src/assistant/tools.ts); the model is NVIDIA-hosted, reached through the site's server function, which holds the API key ([deploy-netlify.md](../docs/deploy-netlify.md#switch-on-the-store-operations-assistant)). The assistant reads only, and never describes or acts toward a shopper: shopper paths and evidence show only their envelope.
- A floor plan of store `demo-001`: every planogram facing colored by its latest ShelfObservation, zones shaded by occupancy from ZoneMetric, shopper dots moving along anonymous ShopperPaths, line length at each checkout, loss prevention incidents at each checkout lane and self-checkout station, the shelf-scanning robot and its route during a scan run, and cameras with their fields of view (shown by default; turn them off with the camera button at the top left of the floor plan).
- **Zoom** with the + and − buttons, ctrl or ⌘ and the scroll wheel, a trackpad pinch or a two-finger pinch on a phone. Drag to pan when zoomed in. The corners button goes back to the whole store.
- Facings whose latest ShelfObservation is flagged (a misplaced item or a shelf tag that disagrees with the price file) are outlined, and the inspector says what was found.
- A playback bar for the store day, in real time or at 10 seconds, 1, 5 or 15 minutes of store time per second, and a day timeline of out-of-stock and low-stock facings with a tick for each checkout incident. Click or drag the timeline to jump to a time.
- On-shelf availability, out-of-stock facings, flagged facings, shoppers in the store, staffed lanes open, line length, average wait, checkout incidents waiting for review and what the robot is doing, all at the chosen time.
- Tap a facing, zone, shopper, camera, checkout incident marker or the robot to open the **record inspector** on its latest record at the playback time. It shows a plain summary, the raw JSON, provenance (system, vendor, model and adapter), the privacy class and a link to the schema in the spec browser. A record picked from the stream or from a link stays put while playback runs; close it to go back to following the selection.
- A low-stock or out-of-stock observation links to its **Evidence**: a shelf image reference with its redaction, retention date and access roles. The synthetic store has no camera frames yet, so the preview is a drawn placeholder, labeled as one.
- A checkout **Incident** shows the exception, lane, items, severity, status and confidence, its 20-second clip (a drawn placeholder) and, under **What Vendor B sent**, the vendor's raw alert before the adapter. The demo finds that alert by running the same adapter on the vendor's feed in the browser.
- A record from the robot, the people counter or the shelf labels shows, under **What Vendor A sent** (or C or D), the vendor's own read, CSV row or label report before its adapter, and what the adapter changed. The demo finds it by place and time: one facing at one second, or one zone over one interval.
- A shelf label price check carries a price and no on-shelf status, so the floor plan keeps coloring a facing by the latest record that does report one. A facing's card shows what its shelf label last reported.
- The robot's route is drawn only from its ShelfObservation records: each bay column it photographs is a stop. No separate location feed is needed.
- The **record stream** lists the latest records as they arrive, filterable by record type. Tap one to inspect it.
- **Go live** simulates today's store day (the same for every visitor) and plays it in real time from the store's own clock. A live store doesn't stop at close: the next day starts at opening.
- **Tasks** is the store's task board: every Task the task management system raised by the playback time, open or closed, with how many are open, done, verified and cancelled. While it's open, the floor plan circles every facing with an open task. Tap a task to see it on the floor plan and in the inspector, which links the records it was raised on, the record that verified it and each status change. A facing, checkout or the front end's card lists its own tasks.
- **Shelf faults** lets a visitor misplace an item, mistag a price or empty a facing without a sale (phantom inventory), on the facing they picked or a random one, at the playback time. The browser replays the day with the fault, keeping every record sent before it, and lists each fault with whether the robot, a shelf camera or the shelf labels have caught it yet.
- **Disagreements** lists the facings where two systems watching the same shelf don't agree, so someone should look: the robot says out of stock and a shelf camera says low stock, a shelf camera sees a misplaced item the robot missed, or the robot reads a lower price on the shelf than the shelf label shows (a sale sign left up after its promotion ended). Each robot pass is compared with what the shelf cameras and shelf labels last reported for that facing. A facing's card shows the same.
- **Sources** lists every feed with its record counts for the day. Switch a feed off to see what the store would know without it: the floor plan, figures, faults caught, disagreements and tasks then use only the feeds that are on. A task raised only on records from a feed that is off is left out, since those records never arrived.
- **Vendors** describes who sends each feed: Vendors A to D, which are made up and each modeled on a kind of company that sells to retailers today without naming any, and the retailer's own systems. The descriptions live in `src/vendors.ts`; a record's "Produced by" row shows the vendor's kind.
- **Simulate another day** runs the store simulator in the browser, in a web worker, with a new seed.

The day is about 12,000 records and is indexed in memory in the browser, so the demo doesn't use DuckDB-WASM or Parquet. They arrive with the server and query API (M3 and M4), where weeks of history make them worth it.

## Run it

From the repository root:

```sh
npm install
npm run dev            # generates the golden day, then serves the site at http://localhost:5173 (demo at /demo/)
npm run build:web      # the same build Netlify runs, into web/dist
npm run preview -w web
```

The records in `public/data/` are generated by `npm run golden` and aren't committed. `npm test -w web` tests the assistant's tools on a simulated day, its question loop with a scripted model, and the server function with a fake model provider.
