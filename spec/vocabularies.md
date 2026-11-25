# Vocabularies

The controlled values used by OISS v0.1. Schema: [`vocab.schema.json`](../schemas/v0.1/vocab.schema.json).

## Privacy classes

From least to most sensitive. Readers are cleared up to a class and see nothing above it.

| Class | Holds | Default access |
| --- | --- | --- |
| `operational` | Store layout, shelves, prices, tasks. Nothing about people. | Store staff and agents |
| `aggregate` | Counts and averages about people in a zone over an interval. | Store staff and agents |
| `anonymous_track` | One person's or object's anonymous path. | Off unless a policy turns it on |
| `restricted` | Incidents and media evidence. | Named roles only, with review |

## Shelf status and flags

`status`: `in_stock`, `low`, `out_of_stock`, `unknown`.

`flags` (any number): `misplaced`, `mispriced`, `label_missing`, `wrong_facing_count`, `damaged`, `planogram_mismatch`.

## Zone and fixture kinds

Zones: `aisle`, `endcap`, `checkout`, `self_checkout`, `entrance`, `exit`, `produce`, `deli`, `bakery`, `service`, `backroom`, `other`.

Fixtures: `shelving`, `endcap`, `cooler`, `freezer`, `display`, `bin`, `checkout_lane`, `self_checkout_station`, `other`.

## Object classes

`Human`, `Vehicle`, `Bicycle` and `Animal` use the names in ONVIF's analytics object types, so ONVIF Profile M metadata maps across directly. `Cart`, `Basket`, `Bag` and `Product` are OISS additions for retail. ONVIF also defines face and license-plate types; OISS leaves them out on purpose.

## Incidents

Types: `missed_scan`, `ticket_switch`, `bottom_of_basket`, `unpaid_exit`, `high_shrink_removal`, `spill_or_hazard`, `other`.

Status: `open`, `under_review`, `confirmed`, `dismissed`. Severity: `low`, `medium`, `high`.

## Tasks

Kinds: `restock`, `face_up`, `fix_price_label`, `relocate_item`, `open_lane`, `review_incident`, `clean_hazard`, `other`.

States: `open` → `assigned` → `in_progress` → `done` → `verified`, with `cancelled` possible from any state. A task that needs verification closes only at `verified`.

## Evidence redaction

`none`, `people_blurred`, `people_masked`, `cropped_to_shelf`.
