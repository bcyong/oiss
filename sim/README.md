# Simulator

A deterministic simulator of one synthetic grocery store, `demo-001`. From a seed and a date it simulates a store day (shoppers, on-shelf inventory, recovery and the front end) and writes what three kinds of sources would report about it, as valid OISS v0.1 records.

It is plain TypeScript with no Node-only code, so the same source runs in Node from the command line and in the browser, where the demo's **Simulate another day** button uses it.

## The store

- A 60 m × 40 m supermarket: produce, bakery, deli, dairy, meat and seafood, six center-store aisles, a frozen aisle, endcaps on the action alley, eight staffed checkout lanes and six self-checkouts.
- 1,010 planogram facings, each with one item. Items have synthetic GTINs in the GS1 restricted-circulation range (prefix 02), so they can't collide with real products.
- An item master with names, departments, categories, prices, case packs and shrink risk. It is the retailer's data, not an OISS record: OISS refers to items by GTIN.

## The day

- About 1,600 shoppers arrive by hour of day, each on a shopping mission (quick trip, fill-in or stock-up). They walk the aisles, dwell at the shelf, take items when they're on the shelf and lose the sale when they aren't, then choose a staffed lane or self-checkout.
- Shelves deplete as items sell. Associates run recovery rounds at 11 AM, 3 PM and 7 PM from backroom stock; a few items have a supply issue and no backroom stock.
- The front-end lead opens a lane when lines grow and closes one when they shrink.

## The sources

| Source | Records | What it reports |
| --- | --- | --- |
| Demo Grocery space planning | StoreLayout | The floor plan, fixtures, shelves, facings, planogram and cameras |
| Mock shelf-scanning robot (mock vendor A) | ShelfObservation | Every facing at 8 AM and 2 PM, with fill level and shelf tag price |
| Store shelf cameras (in-house) | ShelfObservation | Aisle 3 and the dairy wall every 5 minutes, reported on change |
| Mock people-counting system (mock vendor C) | ZoneMetric | Traffic, occupancy, dwell, line length, wait and open lanes per zone every 15 minutes |
| Mock multi-camera tracker (mock vendor C) | ShopperPath | Anonymous paths with ids that rotate every 15 minutes |

Each source adds realistic noise: missed reads reported as unknown, fill levels rounded to 5%, position noise on paths, and a confidence on every record.

## Run it

```sh
npm run golden -w sim         # writes the golden day to web/public/data
npm run golden:check -w sim   # regenerates it and checks it against golden/manifest.json
npm test -w sim               # determinism, identifiers, inventory, path order and plausibility checks
node src/cli.ts --seed 42 --date 2026-11-18 --out out   # any other day, from the sim folder
```

The golden day is store `demo-001` on Tuesday, November 17, 2026, seed 20261117. If a change to the simulator is meant to change that day, update the manifest with `npm run golden:update -w sim` and commit it with the change.
