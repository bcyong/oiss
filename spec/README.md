# OISS specification, v0.1 draft

The Open Intelligent Store Specification (OISS) is a draft open interchange standard for store-intelligence data. Its goal is to let a retailer combine data from several vendors with complementary services and its own in-house systems to run its stores better. Shelf-scanning robots and cameras, people-counting and shopper analytics, loss-prevention vision and space planning systems each publish what they saw as OISS records, so any consumer, including an AI agent, reads one record set for the whole store.

It is written for retail technology leaders and their integration teams: what each record means for store operations, and what a vendor or in-house system has to send.

| Document | What it defines |
| --- | --- |
| [envelope.md](envelope.md) | How every record maps onto a CloudEvents 1.0 event, and the fields all records share |
| [store-layout.md](store-layout.md) | The floor plan, the store → zone → fixture → shelf → facing hierarchy, the planogram, and camera placement |
| [record-types.md](record-types.md) | The seven record types and what each one says |
| [vocabularies.md](vocabularies.md) | Controlled values: shelf conditions, zone and fixture types, incident types, task types and states, privacy classes |
| [identifiers.md](identifiers.md) | Store numbers, GTINs, GLNs, OISS ids, and synthetic identifiers that can't collide with real items |

The machine-readable form is in [`schemas/v0.1`](../schemas/v0.1), with examples in [`examples`](../examples) and a validator in [`validator`](../validator).

## Status

Draft v0.1, not stable. Field names and values may still change. Versioning rules, the transport binding (MQTT and HTTP), the query API and conformance levels come in later milestones.

The key words MUST, MUST NOT, SHOULD and MAY are used as described in RFC 2119.

## License

The spec text in this folder is licensed under [CC BY 4.0](LICENSE.md). Schemas, examples and code elsewhere in the repository are under Apache 2.0.
