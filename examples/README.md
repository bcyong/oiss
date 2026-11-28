# Examples

- [`valid`](valid): one record per type that passes `oiss-validate`, all at the current version, plus a record with an extension and a vendor record type. They describe one synthetic store, `demo-001`, and reference each other (the shelf observation backs the replenishment task, the shopper path appears in the incident).
- [`older`](older): records of earlier versions that still pass, the way a store keeps them after an upgrade.
- [`feeds`](feeds): [feed manifests](../spec/feeds.md) for a vendor on the current version, a vendor still on v0.1, and an agent platform that reads both.
- [`invalid`](invalid): one record per type that breaks one rule; [`invalid/README.md`](invalid/README.md) lists what each one gets wrong.

All examples are synthetic and use GS1 restricted-circulation GTINs (see [`spec/identifiers.md`](../spec/identifiers.md)).
