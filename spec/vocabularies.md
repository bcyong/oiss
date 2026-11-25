# Vocabularies

The controlled values used by OISS v0.1, in standard retail terms. Schema: [`vocab.schema.json`](../schemas/v0.1/vocab.schema.json).

## Privacy classes

From least to most sensitive. A reader is cleared up to a class and sees nothing above it.

| Class | Holds | Default access |
| --- | --- | --- |
| `operational` | Store layout, shelf conditions, prices, tasks. Nothing about people. | Store teams and agents |
| `aggregate` | Counts and averages about shoppers in a zone over an interval. | Store teams and agents |
| `anonymous_path` | One shopper's anonymous path. | Off unless a policy turns it on |
| `restricted` | Incidents and media evidence. | Named roles only, such as asset protection |

## Shelf conditions

On-shelf availability (`status`): `in_stock`, `low_stock`, `out_of_stock`, `unknown`.

Conditions (`flags`, any number): `misplaced_item`, `price_mismatch`, `missing_tag`, `facing_count_mismatch`, `needs_recovery`, `damaged_item`, `planogram_noncompliant`.

## Zone and fixture types

Zones: `aisle`, `endcap`, `front_end`, `self_checkout`, `entrance`, `exit`, `produce`, `deli`, `bakery`, `meat_and_seafood`, `dairy`, `frozen`, `pharmacy`, `service_counter`, `backroom`, `other`.

Fixtures: `gondola`, `endcap`, `wall_section`, `cooler`, `freezer`, `display`, `pallet_display`, `bin`, `service_counter` (a staffed counter such as the deli), `checkout_lane`, `self_checkout`, `other`.

## Object classes

`Human`, `Vehicle`, `Bicycle` and `Animal` use the names in ONVIF's analytics object types, so camera metadata from ONVIF Profile M devices maps across directly. `Cart`, `Basket`, `Bag` and `Item` are OISS additions for retail. ONVIF also defines face and license-plate types; OISS leaves them out on purpose.

## Incidents

Types: `non_scan`, `ticket_switching`, `bottom_of_basket`, `sweethearting`, `push_out`, `shelf_sweep`, `safety_hazard`, `other`.

Status: `open`, `under_review`, `confirmed`, `dismissed`. Severity: `low`, `medium`, `high`.

## Tasks

Types: `replenish`, `recover`, `fix_shelf_tag`, `go_back`, `open_lane`, `review_exception`, `cleanup`, `other`.

Status: `open` → `assigned` → `in_progress` → `done` → `verified`, with `cancelled` possible at any point. A task that needs verification closes only at `verified`.

## Evidence redaction

`none`, `people_blurred`, `people_masked`, `cropped_to_shelf`.
