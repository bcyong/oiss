# OISS: Open Intelligent Store Specification

OISS is a draft open interchange standard for store-intelligence data. Its goal is to let a retailer combine data from several vendors with complementary services, such as shelf scanning, shopper analytics and loss prevention, with its own in-house systems, and use the result to run its stores better.

Each source publishes what it saw as OISS records, so any consumer, from a dashboard to an AI agent, reads one record set for the whole store. OISS also includes a blueprint for using that data with agent platforms: a reference app where agents read OISS records and act on them, so the value shows right away.

OISS composes existing standards rather than replacing them: a [CloudEvents](https://cloudevents.io/) envelope, GS1 identifiers (GTIN for products, GLN for stores), and object classes that line up with ONVIF Profile M.

> **Status:** v0.1 draft, milestone M0 (spec skeleton). Nothing here is stable yet. The goal is a live web demo of a synthetic grocery store running on OISS records, with agents that act on them.

## What's here

| Folder | Contents | Milestone |
| --- | --- | --- |
| [`spec`](spec) | The specification text: envelope, spatial model, record types, vocabularies, identifiers | M0 |
| [`schemas/v0.1`](schemas/v0.1) | JSON Schemas (draft 2020-12) for the envelope and the seven record types | M0 |
| [`examples`](examples) | One valid and one invalid record per type | M0 |
| [`validator`](validator) | `oiss-validate`, a Python validator for producers and adapters | M0 |
| [`sim`](sim) | Synthetic store simulator | M1 |
| [`web`](web) | The demo web app | M2 |
| [`adapters`](adapters) | Mock vendor formats and adapters into OISS | M3 |
| [`server`](server) | Ingest, storage and the query API | M3–M4 |
| [`mcp`](mcp) | MCP server and the Store Operations Assistant | M4 |
| [`docs`](docs) | Guides and design notes | ongoing |

## Record types

| Record | What it says |
| --- | --- |
| StoreMap | Zones, fixtures, shelves, facings, cameras and planogram |
| ShelfObservation | A facing is in stock, low, out, misplaced or mispriced, with its GTIN |
| ZoneMetric | Counts, dwell, queue length and wait per zone per interval |
| Trajectory | An anonymous path on the floor plan; off by default |
| Incident | A checkout or loss-prevention exception, with confidence |
| Evidence | A clip or image reference with time range, camera, retention and access policy |
| Task | A recommended action and its status |

## Validate records

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e "validator[test]"
oiss-validate examples/valid      # all pass
oiss-validate examples/invalid    # all fail, each for one stated reason
pytest validator/tests
```

## Privacy

Store sensing watches shoppers and staff, so OISS keeps identity out of the data: no faces or biometrics, rotating anonymous track ids, aggregates by default, and a privacy class and retention on every record that needs one.

## License

The specification text in [`spec`](spec) is under [CC BY 4.0](spec/LICENSE.md). Schemas, examples and code are under the [Apache License 2.0](LICENSE).
