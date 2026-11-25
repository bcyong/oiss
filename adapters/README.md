# Adapters

An adapter turns one vendor's export, in the vendor's own format, into OISS records. It is the work a retailer's team or a vendor does once per feed, so it is the part of adopting OISS worth seeing up close.

Each adapter here is plain TypeScript with no Node-only code, so the same source runs in the simulator, in tests and in the demo's browser. Every vendor in this folder is invented and labeled as mock.

| Adapter | Vendor feed | OISS records | Status |
| --- | --- | --- | --- |
| [`mock-lp-alerts`](src/mock-lp-alerts.ts) | Mock vendor B's loss prevention exception alerts, newline-delimited JSON | Incident, Evidence | Done in M3 |
| Shelf-scan report | Mock vendor A's robot export | ShelfObservation | Planned in M3 |
| Traffic file | Mock vendor C's people-counting CSV | ZoneMetric | Planned in M3 |
| ESL price feed | A mock electronic shelf label system | ShelfObservation price checks | Planned in M3 |

## Loss prevention alerts

Mock vendor B watches the front end and sends an alert when it sees a possible non-scan, bottom-of-basket, ticket switch or sweethearting. Its feed looks like a typical vendor export: its own store code (`DG0001`), its own register codes (`R01` to `R08`, `SCO01` to `SCO06`), its own camera names, EAN-13 item codes, UTC epoch milliseconds and a 0 to 100 score.

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
