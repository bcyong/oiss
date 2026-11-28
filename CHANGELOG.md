# Changelog

Every OISS version, newest first. Each entry states how it relates to the version before it, so a team can tell whether an upgrade needs work on their side. The rules behind these statements are in [spec/versioning.md](spec/versioning.md), and every version's schemas are listed in [schemas/versions.json](schemas/versions.json).

## 0.2

Released November 26, 2026. Schemas: [`schemas/v0.2`](schemas/v0.2), tag `v0.2`.

**Compatibility with 0.1:** additive. Every 0.1 record's `data` is also valid under 0.2; only `oissversion` and `dataschema` change. A 0.1 record stays valid as a 0.1 record, and a store may hold both. Readers that ignore unknown fields can read 0.2 records, apart from extensions and vendor record types, which they skip.

- **Extensions:** any record's `data` may carry `extensions`, keyed by the owner's reverse-domain namespace, with data in any shape and an optional schema address. See [spec/extensions.md](spec/extensions.md).
- **Vendor record types:** an organization may define a record type in its own namespace, such as `com.example.FloorHazard`, with the shared fields and `provenance` required.
- **No personal data in extensions:** the rule that records carry no biometric or personal data now covers extensions and vendor record types, with a name check in the validator (`no-personal-data`).
- **Feed manifests:** a new document, [`feed-manifest.schema.json`](schemas/v0.2/feed-manifest.schema.json), in which each connected system states which record types and versions it writes and reads. See [spec/feeds.md](spec/feeds.md).
- **Closed vocabularies:** privacy classes and record types are marked closed. A reader treats a privacy class or record type it doesn't know as `restricted`. Every other vocabulary is open.
- **Versioning rules:** records of several versions in one store, producer and reader checks, how a version is added, and how one is deprecated and retired. See [spec/versioning.md](spec/versioning.md).
- **Schema addresses:** each version's schemas are published at an address that includes its git tag, so they never change once released.

## 0.1

Released November 25, 2026. Schemas: [`schemas/v0.1`](schemas/v0.1), tag `v0.1`.

The first draft: the envelope, the seven record types (StoreLayout, ShelfObservation, ZoneMetric, ShopperPath, Incident, Evidence, Task), the vocabularies and privacy classes. On November 26, 2026 its schemas' `$id` moved from the `main` branch to the `v0.1` tag; nothing else in them changed.
