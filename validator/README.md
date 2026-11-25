# oiss-validate

Checks OISS records against the JSON Schemas in [`schemas/v0.1`](../schemas/v0.1) and against the rules JSON Schema can't express:

| Rule | Check |
| --- | --- |
| `schema` | The envelope and the record type's `data` schema, including GTIN and GLN check digits and RFC 3339 timestamps with offsets |
| `window-order` | `window.start` is not after `window.end` |
| `synthetic-gtin` | Records marked `synthetic` only use GS1 restricted-circulation GTINs (prefixes 20–29) |
| `subject-matches-location` | A ShelfObservation's subject is its facing, a ZoneMetric's is its zone |
| `store-id`, `unique-ids`, `map-references`, `on-floor` | A StoreMap's ids are unique, every parent it names exists, and shapes sit on the floor plan |
| `trajectory-order`, `trajectory-window`, `track-rotation` | Trajectory points are in time order, inside the window, and before the track id expires |

## Use

From the repository root:

```sh
pip install -e "validator[test]"
oiss-validate examples/valid
oiss-validate records.jsonl         # one record per line
cat record.json | oiss-validate -   # stdin
```

A file may hold one record, a JSON array of records, or (with a `.jsonl` suffix) one record per line. A directory is searched for `.json` and `.jsonl` files. The command exits 1 if any record fails.

From Python:

```python
from oiss_validate import Validator

validator = Validator()
for problem in validator.problems(record):
    print(problem)
```

The validator reads the schemas from this repository, so install it from a checkout (`pip install -e`).
