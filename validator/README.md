# oiss-validate

Checks OISS records against the JSON Schemas of each record's own OISS version (every version in [`schemas/versions.json`](../schemas/versions.json)) and against the rules JSON Schema can't express:

| Rule | Check |
| --- | --- |
| `schema` | The envelope and the record type's `data` schema, including GTIN and GLN check digits and RFC 3339 timestamps with offsets |
| `window-order` | `window.start` is not after `window.end` |
| `synthetic-gtin` | Records marked `synthetic` only use GS1 restricted-circulation numbers (prefixes 20–29) |
| `subject-matches-location` | A ShelfObservation's subject is its facing, a ZoneMetric's is its zone |
| `store-id`, `unique-ids`, `map-references`, `on-floor` | A StoreLayout's ids are unique, every parent it names exists, and shapes sit on the floor plan |
| `path-order`, `path-window`, `path-id-rotation` | ShopperPath points are in time order, inside the window, and before the path id expires |
| `unsupported-version` | The record's `oissversion` is one the validator has schemas for |
| `no-personal-data` | No extension or vendor record type field is named like biometric or personal data (in reader mode, no field at all) |

## Use

From the repository root:

```sh
pip install -e "validator[test]"
oiss-validate examples/valid
oiss-validate records.jsonl         # one record per line
cat record.json | oiss-validate -   # stdin
oiss-validate --reader feed.jsonl   # as a reader: unknown fields and values pass
```

Records of different versions can sit in one file or folder; each is checked against its own version, and the summary counts records by version.

**Producer mode** (the default) is the check a vendor or adapter runs before sending: a field or vocabulary value the record's version doesn't define fails. **Reader mode** (`--reader`) is the check a consumer runs on what it receives: unknown fields and open-vocabulary values pass, required fields still don't, and from 1.0 up a record of a newer minor version is checked against the newest minor version the validator knows. See [`spec/versioning.md`](../spec/versioning.md).

A file may hold one record, a JSON array of records, or (with a `.jsonl` suffix) one record per line. A directory is searched for `.json` and `.jsonl` files. The command exits 1 if any record fails.

From Python:

```python
from oiss_validate import Validator, effective_privacy

validator = Validator()                  # or Validator(mode="reader")
for problem in validator.problems(record):
    print(problem)

effective_privacy(record)                # the class to apply: unknown classes and types are restricted
```

The validator reads the schemas from this repository, so install it from a checkout (`pip install -e`).
