# Invalid examples

Each file breaks one rule. The validator must reject every one of them.

| File | What's wrong |
| --- | --- |
| `store-layout-dangling-shelf.json` | shelf points at a fixture that isn't in the map (map-references) |
| `shelf-observation-bad-check-digit.json` | GTIN check digit is wrong (schema format gtin) |
| `zone-metric-window-reversed.json` | window starts after it ends (window-order) |
| `shopper-path-face-field.json` | carries a biometric field, which OISS doesn't allow (schema unevaluatedProperties) |
| `incident-wrong-privacy.json` | an Incident must be privacy class restricted (schema) |
| `evidence-no-retention.json` | evidence has no retention date (schema required) |
| `task-verified-without-proof.json` | a verified task must name the record that showed the fix (schema) |
