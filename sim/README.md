# Simulator

A deterministic simulator of one synthetic grocery store, `demo-001`. From a seed and a date it simulates a store day (shoppers, on-shelf inventory, recovery and the front end) and writes what four kinds of sources would report about it, as valid OISS v0.1 records.

It is plain TypeScript with no Node-only code, so the same source runs in Node from the command line and in the browser, where the demo's **Simulate another day** button uses it.

## The store

- A 60 m × 40 m supermarket: produce, bakery, deli, dairy, meat and seafood, six center-store aisles, a frozen aisle, endcaps on the action alley, eight staffed checkout lanes and six self-checkouts.
- 1,010 planogram facings, each with one item. Items have synthetic GTINs in the GS1 restricted-circulation range (prefix 02), so they can't collide with real products.
- An item master with names, departments, categories, prices, case packs and shrink risk. It is the retailer's data, not an OISS record: OISS refers to items by GTIN.

## The day

- About 1,600 shoppers arrive by hour of day, each on a shopping mission (quick trip, fill-in or stock-up). They walk the aisles, dwell at the shelf, take items when they're on the shelf and lose the sale when they aren't, then choose a staffed lane or self-checkout.
- Shelves deplete as items sell. Associates run recovery rounds at 11 AM, 3 PM and 7 PM from backroom stock; a few items have a supply issue and no backroom stock.
- The front-end lead opens a lane when lines grow and closes one when they shrink.
- Every checkout is a transaction with what the shopper bought. A small share of them carry a checkout exception: a non-scan, bottom of basket, ticket switch or sweethearting, at rates that differ between staffed lanes and self-checkout. These are ground truth, which a real store never sees directly.
- Shelf faults that the store's own systems don't see, also ground truth, at set rates each day:
  - **Misplaced items** (about 16 a day): go-backs, left on another item's facing as traffic allows. An associate clears most of them in the next recovery round.
  - **Price mismatches** (about 6 a day): a price change that took effect overnight, but the shelf still shows another price all day. Either the electronic shelf label didn't take the change, which the label system knows, or a promotion ended overnight and its paper sale sign was left up over a label that did take the regular price back, which only something that looks at the shelf can see. The label system then reports the regular price while the robot reads the sale price, so the two disagree.
  - **Phantom inventory** (about 3 a day): the units on a facing go missing without a sale and the backroom has none. The system still counts them, so no replenishment comes and the facing stays empty.
- A visitor can **inject** any of these faults at a set facing and time. An injected fault changes the day only from that time on: every record sent before it stays exactly the same, so the demo can replay the day with the fault and carry on where it was.

## The sources

| Source | Records | What it reports |
| --- | --- | --- |
| Demo Grocery space planning | StoreLayout | The floor plan, fixtures, shelves, facings, planogram and cameras |
| Mock shelf-scanning robot (mock vendor A) | ShelfObservation, Evidence | Every facing, every two hours from 8 AM to 8 PM, with fill level and shelf tag price. Flags a misplaced item most of the time it passes one, and every shelf tag that disagrees with the price file, whatever the cause. Sends mission reports in its own format, written as OISS by the [`mock-shelf-scan` adapter](../adapters/README.md) |
| Store shelf cameras (in-house) | ShelfObservation | Aisle 3 and the dairy wall every 5 minutes, reported on change. Flags most misplaced items; can't read shelf tags |
| Shelf scanner and shelf cameras | Evidence | A shelf image reference for each low-stock, out-of-stock or flagged observation, cropped to the shelf, kept 30 days and viewable by store and department managers. The synthetic store has no images, so the demo draws a placeholder |
| Mock people-counting system (mock vendor C) | ZoneMetric | Traffic, occupancy, dwell, line length, wait and open lanes per zone every 15 minutes. Sends a CSV in store wall-clock time, written as OISS by the [`mock-traffic-csv` adapter](../adapters/README.md) |
| Mock multi-camera tracker (mock vendor C) | ShopperPath | Anonymous paths with ids that rotate every 15 minutes |
| Mock electronic shelf labels (mock vendor D) | ShelfObservation price checks | At 6 AM the label system sends 40 or so labels their overnight price changes. The batch always includes the labels of promotions that ended overnight. Each label confirms, or fails and keeps its old price; a failed label is retried every hour until close. Each report is a price check with no on-shelf status, written as OISS by the [`mock-esl` adapter](../adapters/README.md) |
| Mock loss prevention (mock vendor B) | Incident, Evidence | Alerts about checkout exceptions, in the vendor's own format, written as OISS by the [`mock-lp-alerts` adapter](../adapters/README.md). The vendor catches most real exceptions, misses some and raises some false alerts, each with a 20-second clip kept 90 days |

Each source adds realistic noise and misses: missed reads reported as unknown, fill levels rounded to 5%, position noise on paths, and a confidence on every record.

## Run it

```sh
npm run golden -w sim         # writes the golden day to web/public/data
npm run golden:check -w sim   # regenerates it and checks it against golden/manifest.json
npm test -w sim               # determinism, identifiers, inventory, path order and plausibility checks
node src/cli.ts --seed 42 --date 2026-11-18 --out out   # any other day, from the sim folder
```

The day folder also holds each mock vendor's own export in `vendor/`, before its adapter: the robot's missions, the loss prevention alerts, the people-counting CSV and the shelf label reports. They are not OISS; the demo shows the vendor's data beside each record that came from it. `summary.json` scores the vendor against ground truth, which only a simulator can do.

The golden day is store `demo-001` on Tuesday, November 17, 2026, seed 20261117. If a change to the simulator is meant to change that day, update the manifest with `npm run golden:update -w sim` and commit it with the change.
