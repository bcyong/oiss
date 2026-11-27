# Extensions

No shared standard covers everything a vendor knows. A shelf-scanning vendor knows its mission id and image quality; a floor-care vendor detects spills, which no OISS record type describes. OISS gives that data two sanctioned places, so a vendor never has to break a record's schema or keep a side channel to send it. Both arrived in v0.2. Schema: [`defs.schema.json`](../schemas/v0.2/defs.schema.json) (`extensions`, `namespace`, `vendorRecordType`) and [`vendor-record.schema.json`](../schemas/v0.2/vendor-record.schema.json).

## Namespaces

Every extension and vendor-defined record type is owned by one organization and named by its **namespace**: its internet domain name reversed, in lowercase, such as `com.example` for example.com, or `com.example.shelfscan` for one of its products. The `oiss.` prefix is reserved for the spec. A namespace is how a reader knows whose data it is and where to find its documentation, and it keeps two vendors' fields from colliding.

## Extensions on a record

Any OISS record's `data` may carry an `extensions` object, keyed by namespace. Each entry holds the extension's own `data`, in any JSON shape, and optionally the URL of the `schema` it follows:

```json
"extensions": {
  "com.example.shelfscan": {
    "schema": "https://shelfscan.example.com/oiss/shelf-observation-ext-1.json",
    "data": { "missionId": "M-20261125-0914", "pass": 2, "imageQuality": 0.87 }
  }
}
```

A record may carry up to 16 extensions. The full example is [`examples/valid/shelf-observation-extension.json`](../examples/valid/shelf-observation-extension.json).

- An extension adds to a record; it never changes what the record's own fields mean. A reader that doesn't know an extension ignores it and reads the record as usual.
- An extension takes the record's privacy class. It can't lower it, and a reader cleared for the record's class may see its extensions.
- An extension's owner versions it on its own, by changing its `schema` address when it makes an incompatible change.
- When two or more vendors carry the same kind of extension, it SHOULD move into the core as an optional field in the next minor version, and the extension is then deprecated.

## Vendor record types

When data fits no OISS record type, an organization may define its own record type, named by its namespace, a dot and a PascalCase name, such as `com.example.FloorHazard` for a spill detected on the sales floor. A vendor record type uses the same envelope as every other record, carries the shared fields (`provenance` is required) and may name its `schema` in `data.schema`. The example is [`examples/valid/vendor-record-type.json`](../examples/valid/vendor-record-type.json).

- A reader that wasn't built for a vendor record type skips it and treats it as `restricted`. A record type it doesn't know is never shown by guesswork.
- A vendor record type takes whatever privacy class its producer sets. Producers SHOULD set the most cautious class that fits.
- A vendor record type that more than one vendor needs is a candidate for a new OISS record type in a minor version.

## No personal data

OISS records carry no biometric identifiers and no personal data: no faces or face embeddings, no fingerprints, voiceprints, gait or other body measurements used to recognize a person, no license plates, and no names, contact details, loyalty or payment numbers. This holds for extensions and vendor record types as much as for the core, and a vendor that sends an extension commits to it.

The core schemas enforce this by refusing any field they don't define. An extension's contents are open, so no schema can enforce it there. As a backstop, `oiss-validate` refuses any extension or vendor record field whose name says it holds such data, such as `faceEmbedding` or `phoneNumber` (rule `no-personal-data`), and in reader mode it applies the same check to every field it would otherwise ignore. A name check can't see what a value means, so it doesn't replace the commitment.
