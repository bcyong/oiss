# Record types (v0.1)

Each record type has its own schema for `data` in [`schemas/v0.1`](../schemas/v0.1), and a valid and an invalid example in [`examples`](../examples).

| Record | About (`subject`) | What it says | Typical sources | Privacy floor |
| --- | --- | --- | --- | --- |
| StoreLayout | the store | Zones, fixtures, shelves and facings, with the planogram and camera placement | Space planning and planogram systems, ESL and item-location platforms | operational |
| ShelfObservation | a facing | On-shelf availability (in stock, low stock, out of stock), planogram compliance and price integrity | Shelf-scanning robots, fixed shelf cameras, associate audits | operational |
| ZoneMetric | a zone | Traffic, dwell, queue length, wait time and open lanes over one interval | People counting, shopper analytics, video analytics | aggregate |
| ShopperPath | an anonymous path | One shopper's path on the floor plan | Multi-camera tracking; off by default | anonymous_path |
| Incident | an incident | A loss-prevention exception or safety incident, with a confidence | Loss-prevention and front-end vision, safety detection | restricted |
| Evidence | an evidence item | A clip or image reference, with redaction, retention date and access roles | Any vendor | restricted |
| Task | a task | A store task, such as replenish, recover or fix a shelf tag, and its status | Task management, agents | operational |

## Rules worth calling out

- **ShelfObservation** needs `status`, `location` (with the facing), `confidence` and the scan `window`. `observedGtin` is the item seen and `planogramGtin` the item the planogram assigns, so a misplaced item shows in the data. `tagPrice` is what the shelf tag or ESL shows and `systemPrice` what the price file or POS charges, so a price mismatch shows too.
- **ZoneMetric** is aggregate only: counts and averages, never individual shoppers.
- **ShopperPath** carries an anonymous path id that rotates. `idValidUntil` says when the producer must switch to a new id, and every point must come before it. Points are in time order and inside the window. No appearance, face or other biometric field is allowed.
- **Incident** is a signal, not an accusation. Its `status` starts at `open`, and only a person moves it to `confirmed` or `dismissed`.
- **Evidence** points to media held in an evidence store. It MUST give a `redaction` level, a `retainUntil` date and the `accessRoles` that may view it, such as asset protection or the store manager.
- **Task** status changes are new records with the same `subject`. A task with `verification.required` closes at `verified`, and a `verified` task MUST name the record that showed the fix in `verification.verifiedBy`, such as the next shelf scan.
