# OISS: Open Intelligent Store Specification

OISS is a draft open interchange standard for store-intelligence data. Its goal is to let a retailer combine data from several vendors with complementary services, such as shelf scanning, shopper analytics and loss prevention, with its own in-house systems, and use the result to run its stores better.

Each source publishes what it saw as OISS records, so any consumer, from a store operations dashboard to an AI agent, reads one record set for the whole store. OISS also includes a blueprint for using that data with agent platforms: a reference app where agents read OISS records and raise store tasks, so the value shows right away.

> **Status:** v0.1 draft, milestone M0 (spec skeleton). Nothing here is stable yet. The goal is a live web demo of a synthetic grocery store running on OISS records, with agents that act on them.

## Why a retailer would adopt it

- **One view across vendors.** On-shelf availability from a shelf-scanning robot, traffic and queue data from a people-counting system, and exceptions from loss-prevention vision line up on one store layout and one item master, so they can be joined. Today each sits in its own vendor dashboard.
- **Use cases no single vendor covers.** Replenish the out-of-stocks with the most shopper traffic first, close a task only when the next shelf scan shows it fixed, and tie a front-end exception to the missing high-shrink item.
- **No lock-in.** Change or add vendors without rewiring every downstream report, task tool or agent.
- **Agent-ready.** A query API and an MCP server let any agent platform read the data and write tasks back, with every answer traceable to its source and model.

## What adoption takes

- **No rip and replace.** Vendors keep their own systems. An adapter maps each vendor's existing export to OISS, usually one small service per feed.
- **Start with one record type.** A store layout plus shelf observations is enough for on-shelf availability; traffic, front-end and loss-prevention data can follow.
- **Existing identifiers.** Items are keyed by GTIN (the UPC or EAN already in the item master) and stores by the retailer's own store number, with an optional GS1 GLN.
- **Existing standards underneath.** A CloudEvents envelope, GS1 identifiers and ONVIF-compatible object classes, so integration teams work with tools they already know.
- **Privacy built in.** No faces or biometrics, aggregates by default, and a privacy class, retention date and access roles on every record that needs them.

## Record types

| Record | What it says |
| --- | --- |
| StoreLayout | Zones, fixtures, shelves and facings, with the planogram and camera placement |
| ShelfObservation | On-shelf availability, planogram compliance and price integrity at one facing |
| ZoneMetric | Traffic, dwell, queue length, wait time and open lanes for one zone over one interval |
| ShopperPath | An anonymous shopper path on the floor plan; off by default |
| Incident | A loss-prevention exception or safety incident, with a confidence, for a person to review |
| Evidence | A clip or image reference with time range, camera, retention and access roles |
| Task | A store task, such as replenish or fix a shelf tag, and its status |

## What's here

| Folder | Contents | Milestone |
| --- | --- | --- |
| [`spec`](spec) | The specification text: envelope, store layout model, record types, vocabularies, identifiers | M0 |
| [`schemas/v0.1`](schemas/v0.1) | JSON Schemas (draft 2020-12) for the envelope and the seven record types | M0 |
| [`examples`](examples) | One valid and one invalid record per type | M0 |
| [`validator`](validator) | `oiss-validate`, a Python validator for vendors and integration teams | M0 |
| [`sim`](sim) | Synthetic store simulator | M1 |
| [`web`](web) | The demo web app | M2 |
| [`adapters`](adapters) | Mock vendor exports and adapters into OISS | M3 |
| [`server`](server) | Ingest, storage and the query API | M3–M4 |
| [`mcp`](mcp) | MCP server and the Store Operations Assistant | M4 |
| [`docs`](docs) | Guides and design notes | ongoing |

## Validate records

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e "validator[test]"
oiss-validate examples/valid      # all pass
oiss-validate examples/invalid    # all fail, each for one stated reason
pytest validator/tests
```

## License

The specification text in [`spec`](spec) is under [CC BY 4.0](spec/LICENSE.md). Schemas, examples and code are under the [Apache License 2.0](LICENSE).
