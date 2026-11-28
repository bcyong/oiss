# Invalid examples

Each file breaks one rule. The validator must reject every one of them.

| File | What's wrong |
| --- | --- |
| `store-layout-dangling-shelf.json` | shelf points at a fixture that isn't in the map (map-references) |
| `shelf-observation-bad-check-digit.json` | GTIN check digit is wrong (schema format gtin) |
| `shelf-observation-no-status-or-price.json` | reports neither on-shelf availability nor a tag price (schema anyOf) |
| `zone-metric-window-reversed.json` | window starts after it ends (window-order) |
| `shopper-path-face-field.json` | carries a biometric field, which OISS doesn't allow (schema unevaluatedProperties) |
| `incident-wrong-privacy.json` | an Incident must be privacy class restricted (schema) |
| `evidence-no-retention.json` | evidence has no retention date (schema required) |
| `task-verified-without-proof.json` | a verified task must name the record that showed the fix (schema) |
| `extension-face-field.json` | an extension carries a face embedding, which OISS doesn't allow anywhere (no-personal-data) |
| `extension-reserved-namespace.json` | an extension uses the oiss. namespace, which is reserved for the spec (schema) |
| `shelf-observation-unknown-version.json` | names OISS 0.3, which doesn't exist yet (unsupported-version) |
| `vendor-record-type-phone-number.json` | a vendor record type carries a phone number (no-personal-data) |
