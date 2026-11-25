# Record types (v0.1)

Each record type has its own schema for `data` in [`schemas/v0.1`](../schemas/v0.1), and a valid and an invalid example in [`examples`](../examples).

| Record | `subject` | What it says | Typical sources | Privacy floor |
| --- | --- | --- | --- | --- |
| StoreMap | store id | Zones, fixtures, shelves, facings, cameras and planogram | Retailer, planogram system, ESL and item-location platforms | operational |
| ShelfObservation | facing id | A facing is in stock, low, out or unknown, with flags such as misplaced or mispriced, and the GTIN seen | Shelf robots and cameras | operational |
| ZoneMetric | zone id | Entries, occupancy, dwell, queue length and wait for one zone over one interval | Shopper analytics, Metropolis pipelines | aggregate |
| Trajectory | track id | An anonymous path on the floor plan | Multi-camera tracking; off by default | anonymous_track |
| Incident | incident id | A checkout or loss-prevention exception, with a confidence, for a person to review | Loss-prevention vision | restricted |
| Evidence | evidence id | A reference to an image or clip, with redaction, retention date and who may see it | Any vendor | restricted |
| Task | task id | A recommended or assigned action and its state | Task tools, agents | operational |

## Rules worth calling out

- **ShelfObservation** needs `status`, `location` (with the facing), `confidence` and `window`. `gtin` is what was seen and `expectedGtin` what the planogram expects, so a misplaced item is visible in the data.
- **ZoneMetric** is aggregate only: counts and averages, never individuals.
- **Trajectory** carries an anonymous track id that rotates. `idValidUntil` says when the producer must switch to a new id, and every point must come before it. Points are in time order and inside the window. No appearance, face or other biometric field is allowed.
- **Incident** is a signal, not an accusation. Its `status` starts at `open` and only a person moves it to `confirmed` or `dismissed`.
- **Evidence** points to media in an evidence store. It MUST give a `redaction` level, a `retainUntil` date and the `accessRoles` that may view it.
- **Task** state changes are new records with the same `subject`. A task with `verification.required` closes at `verified`, and a `verified` task MUST name the record that showed the fix in `verification.verifiedBy`.
