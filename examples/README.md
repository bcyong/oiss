# Examples

- [`valid`](valid): one record per type that passes `oiss-validate`. They describe one synthetic store, `demo-001`, and reference each other (the shelf observation backs the replenishment task, the shopper path appears in the incident).
- [`invalid`](invalid): one record per type that breaks one rule; [`invalid/README.md`](invalid/README.md) lists what each one gets wrong.

All examples are synthetic and use GS1 restricted-circulation GTINs (see [`spec/identifiers.md`](../spec/identifiers.md)).
