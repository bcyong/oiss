# Record types (v0.2)

Each record type has its own schema for `data` in [`schemas/v0.2`](../schemas/v0.2), and a valid and an invalid example in [`examples`](../examples). Organizations may also define their own record types for data none of these cover; see [extensions.md](extensions.md#vendor-record-types).

| Record | About (`subject`) | What it says | Typical sources | Privacy floor |
| --- | --- | --- | --- | --- |
| StoreLayout | the store | Zones, fixtures, shelves and facings, with the planogram and camera placement | Space planning and planogram systems, ESL and item-location platforms | operational |
| ShelfObservation | a facing | On-shelf availability (in stock, low stock, out of stock), planogram compliance and price integrity | Shelf-scanning robots, fixed shelf cameras, electronic shelf labels, associate audits | operational |
| ZoneMetric | a zone | Traffic, dwell, queue length, wait time and open lanes over one interval | People counting, shopper analytics, video analytics | aggregate |
| ShopperPath | an anonymous path | One shopper's path on the floor plan | Multi-camera tracking; off by default | anonymous_path |
| Incident | an incident | A loss-prevention exception or safety incident, with a confidence | Loss-prevention and front-end vision, safety detection | restricted |
| Evidence | an evidence item | A clip or image reference, with redaction, retention date and access roles | Any vendor | restricted |
| Task | a task | A store task, such as replenish, recover or fix a shelf tag, and its status | Task management, agents | operational |

## Rules worth calling out

- **ShelfObservation** needs `location` (with the facing), `confidence` and the scan `window`, and at least one of `status` and `tagPrice`. A source that sees the shelf reports `status`. A source that only knows the price, such as an electronic shelf label (ESL) system confirming the price a label shows, sends a price check with `tagPrice` and `systemPrice` and no `status`, and consumers MUST NOT read a missing `status` as a change in availability. `observedGtin` is the item seen and `planogramGtin` the item the planogram assigns, so a misplaced item shows in the data. `tagPrice` is what the shelf tag or ESL shows and `systemPrice` what the price file or POS charges, so a price mismatch shows too.
- **ZoneMetric** is aggregate only: counts and averages, never individual shoppers.
- **ShopperPath** carries an anonymous path id that rotates. `idValidUntil` says when the producer must switch to a new id, and every point must come before it. Points are in time order and inside the window. No appearance, face or other biometric field is allowed.
- **Incident** is a signal, not an accusation. Its `status` starts at `open`, and only a person moves it to `confirmed` or `dismissed`.
- **Evidence** points to media held in an evidence store. It MUST give a `redaction` level, a `retainUntil` date and the `accessRoles` that may view it, such as asset protection or the store manager.
- **Task** status changes are new records with the same `subject`. A task with `verification.required` closes at `verified`, and a `verified` task MUST name the record that showed the fix in `verification.verifiedBy`, such as the next shelf scan. A task MAY carry a `resolution` saying how it ended: an `outcome`, an optional `note`, who resolved it (`resolvedBy`) and when (`resolvedAt`). A cancelled task gives the reason, such as `no_backroom_stock`. A loss prevention review task gives the disposition, such as `confirmed_loss`, `customer_paid` or `false_alarm`. The vendor's Incident stays as the vendor sent it; a consumer reads the store's finding from the review task whose `basedOn` names the Incident.
