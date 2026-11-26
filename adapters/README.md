# Adapters

An adapter turns one vendor's export, in the vendor's own format, into OISS records. It is the work a retailer's team or a vendor does once per feed, so it is the part of adopting OISS worth seeing up close.

Each adapter here is plain TypeScript with no Node-only code, so the same source runs in the simulator, in tests and in the demo's browser. Every vendor in this folder is invented and labeled as mock.

| Adapter | Vendor feed | OISS records | Status |
| --- | --- | --- | --- |
| [`mock-shelf-scan`](src/mock-shelf-scan.ts) | Vendor A's shelf-scanning robot missions, one JSON report per line | ShelfObservation, Evidence | Done in M3 |
| [`mock-lp-alerts`](src/mock-lp-alerts.ts) | Vendor B's loss prevention exception alerts, newline-delimited JSON | Incident, Evidence | Done in M3 |
| [`mock-traffic-csv`](src/mock-traffic-csv.ts) | Vendor C's people-counting CSV | ZoneMetric | Done in M3 |
| [`mock-esl`](src/mock-esl.ts) | Vendor D's electronic shelf label reports, newline-delimited JSON | ShelfObservation price checks | Done in M3 |

Every adapter shares [`common.ts`](src/common.ts): GS1 check digits, times in store time with the UTC offset, and lookups in the retailer's StoreLayout. Each keeps its own mapping table for store `demo-001`, the part a retailer fills in once per vendor.

## Shelf-scan missions

Vendor A's robot sends one report per scan mission: its own store code (`DG0001`) and robot name, its own section codes (`A03L` for aisle 3, left side; `END01`; `DAIRY-WALL`), a bay position, shelves counted from the top, EAN-13 codes, UTC times, a fill percentage and its own exception codes (`PLUG` for an item filling another item's hole, `PRICE` for a shelf tag that disagrees with the price file).

The adapter:

- maps the section, bay position and top-down shelf number to the facing in the StoreLayout, whose shelves count from the bottom;
- checks that the item the robot expected is the one the planogram puts there, and rejects the read if not, so a robot working from an old planogram can't mislabel facings;
- turns the vendor's states and exception codes into OISS statuses and flags, and the fill percentage into a 0 to 1 fill level;
- writes each shelf crop as a restricted Evidence record, kept 30 days and viewable by store and department managers, under the vendor's own image name.

## People-counting CSV

Vendor C drops a CSV every 15 minutes: its own zone codes (`AISLE03`, `FRONTEND`, `SCO`), interval starts in store wall-clock time with no UTC offset, blank cells for metrics a zone doesn't have and an accuracy percentage.

The adapter:

- maps the zone codes to StoreLayout zones;
- gives each wall-clock time the store's UTC offset. In the hour that repeats when daylight saving time ends it takes the first one, and it rejects a time the clocks skip;
- writes only the metrics the vendor filled in, under OISS names, and the accuracy as a confidence;
- rejects rows it can't read, with the line and the reason.

## Shelf label reports

Vendor D's label system reports each time a label confirms a new price or fails to: the label id, the item it is linked to, the price it shows and the price it was sent, as decimal strings, with UTC times.

The adapter:

- maps each label to its facing from the retailer's label-to-location table;
- checks that the label is linked to the item the planogram puts on that facing;
- writes each report as a price check: a ShelfObservation with `tagPrice`, `systemPrice`, a `price_mismatch` flag when they differ, and no `status`, since a label can't see the shelf.

A label only knows what it shows. A paper sale sign left up over a correct label is a price mismatch the label system never reports; the robot finds it. The two vendors are complementary, which is the case for a retailer combining them.

## Loss prevention alerts

Vendor B watches the front end and sends an alert when it sees a possible non-scan, bottom-of-basket, ticket switch or sweethearting. Its feed looks like a typical vendor export: its own store code (`DG0001`), its own register codes (`R01` to `R08`, `SCO01` to `SCO06`), its own camera names, EAN-13 item codes, UTC epoch milliseconds and a 0 to 100 score.

The adapter:

- maps the vendor's store, register and camera codes to ids in the retailer's StoreLayout, from a mapping table the retailer keeps (`demo001Config`);
- converts times to store time with the store's UTC offset, across daylight saving time;
- writes items as 14-digit GTINs and checks every check digit;
- turns the score into a 0 to 1 confidence and the vendor's alert code into an OISS incident type, with a severity from the value at the register's prices;
- writes each clip as a restricted Evidence record: people blurred, kept 90 days, viewable by asset protection and the store manager;
- writes every Incident as open. An Incident is a signal for a person to review, not an accusation;
- rejects what it can't map, with a reason, instead of guessing.

Linking an Incident to an anonymous ShopperPath is left to a consumer that can see both, such as the loss prevention agent in M4.

## Run the tests

```sh
npm test -w adapters
```
