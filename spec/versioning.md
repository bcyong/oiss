# Versioning

OISS changes over time, and retailers, vendors and agent platforms each upgrade on their own schedule. So one store's data will always hold records of more than one OISS version: a shelf-scanning vendor may move to a new version months before the loss prevention vendor does. These rules say what a version number promises, how a reader handles a mix of versions, and how a new version is added, so a team can tell from the number alone whether an upgrade needs work on their side.

## The version number

OISS versions are `MAJOR.MINOR`, such as `0.2` or `1.2`. Every record states the version it follows in its `oissversion` attribute (see [envelope.md](envelope.md#oiss-extension-attributes)), and that version's schemas live under `schemas/vMAJOR.MINOR/`.

- A **minor** version (`1.1` → `1.2`) only adds. The `data` of a record that was valid under `1.1` is also valid under `1.2`, and a reader built for `1.1` can read `1.2` records by ignoring what it doesn't know.
- A **major** version (`1.x` → `2.0`) may change or remove things. It comes with a migration note that lists every change and says how to turn an old record into a new one.

There is no patch number. Fixes to the spec text that change no rule, such as wording, examples or typos, are made in place and listed in the [changelog](../CHANGELOG.md).

Every release adds an entry to [`schemas/versions.json`](../schemas/versions.json), which lists each version, the git tag its schemas are frozen at, and where they are published. Readers and validators use that list to find the schemas for each record.

## What counts as compatible

These are **minor** changes:

- a new record type
- a new optional field on an existing record type
- a new value in an open vocabulary, such as a new shelf condition flag or task type
- a new optional CloudEvents extension attribute
- relaxing a rule, such as making a required field optional or raising a limit

These are **major** changes:

- removing or renaming a field, record type or vocabulary value
- making an optional field required
- changing what a field means, its unit or its type
- tightening a rule so that some valid records stop being valid
- changing an identifier format
- a new value in a closed vocabulary (privacy classes; see below)

## Records of several versions in one store

A store's records are not migrated when a new version comes out. Each record keeps the version its producer wrote, and readers handle the mix:

- A record is always checked against **its own** version's schemas, named by its `oissversion`, never against another version's. A `0.1` record checked against `0.2` schemas, or the other way round, proves nothing.
- A record's identity does not depend on its version. A store, facing, zone, task or incident keeps its id across versions, so a task first raised as a `1.3` record and updated as a `2.0` record is still one task.
- When records about the same subject carry different versions, the newest by `time` describes the subject's current state, whatever its version. A newer version never makes an older record wrong; it only describes it in a different shape.
- A reader that supports more than one version SHOULD convert every record it reads into the newest version it knows, one migration note at a time, and keep the record's original `oissversion` so it can still say where the record came from. Converting a minor version changes nothing, because a minor version only adds.
- An adapter that rewrites records from one version to another MUST record itself in the record's `provenance.adapter` and set `oissversion` to the version it wrote.

## Rules for producers

A producer is a vendor system, an adapter or an in-house system that writes OISS records.

- A producer MUST set `oissversion` to the version whose schemas it validated the record against, and MUST write only fields and values that version defines, or put its own data in [extensions](extensions.md).
- A producer SHOULD validate in **producer mode**, the strict check: a field or vocabulary value its version doesn't define fails. `oiss-validate` does this by default.
- A producer SHOULD publish a [feed manifest](feeds.md) that says which record types it writes and in which version, and update it when it upgrades.

## Rules for readers

A reader is any system that consumes OISS records: a retailer's data platform, an agent, a dashboard or another vendor.

- A reader MUST ignore fields it doesn't know, and SHOULD treat a value it doesn't know in an **open** vocabulary as `unknown` or "other" rather than rejecting the record. This is what lets a minor version roll out one vendor at a time. `oiss-validate --reader` checks records this way.
- A reader MUST treat a value it doesn't know in a **closed** vocabulary as the most cautious value. Two vocabularies are closed: a privacy class it doesn't know means `restricted`, and a record type it doesn't know is skipped and treated as `restricted`, whether it is an OISS type from a newer version or a [vendor-defined type](extensions.md#vendor-record-types) it wasn't built for. A newer version must never make a reader show more than it should.
- From `1.0` up, a reader MAY read a record of a newer minor version of a major version it knows, using the newest minor version it has: the record is still valid there, apart from what it ignores. Before `1.0`, any minor version may break, so a reader needs the record's exact version.
- A reader MAY reject a record whose major version it doesn't support, and SHOULD say so in its logs.
- A reader that ignores fields MUST still not keep a field whose name says it holds biometric or personal data (see [extensions.md](extensions.md#no-personal-data)).

## Adding a new version

1. Copy the current version's schema folder to `schemas/vMAJOR.MINOR/` and make the changes there. Never edit a released version's folder.
2. In the new folder, set every schema's `$id` to the new version's tagged address and the envelope's `oissversion` to the new version.
3. Add the version to `schemas/versions.json`, add a changelog entry that states its compatibility with the version before it, and for a major version write the migration note.
4. Mark anything that the next major version will remove as deprecated (below).
5. Merge, then tag the merge commit `vMAJOR.MINOR`. From then on the folder is frozen: CI fails if a released folder changes after its tag.
6. Move producers over one at a time. Readers keep reading the old version until no feed manifest in the store lists it.

## Deprecation

A field, record type or value that will be removed in the next major version is first marked deprecated in a minor version, with its replacement named in the spec text and the schema's `deprecated` keyword. Producers SHOULD stop sending it; readers MUST keep accepting it until the next major version. A deprecated item stays for at least one minor version before the major version that removes it.

A version stays supported while any feed manifest in a store still lists it. `schemas/versions.json` marks each version `current`, `supported` or `retired`, and a version is retired only in a major release, with notice in the changelog.

## Drafts before 1.0

Versions `0.x` are drafts. Any `0.x` release MAY make major changes, so early adopters should pin a version and read its changelog before moving up. The compatibility rules above take full effect at `1.0`. The rules for mixing versions in one store apply from `0.2`.

## Schema locations

Each version's schemas are published at an address that includes the version's git tag, so they never change once that version is released:

```
https://raw.githubusercontent.com/bcyong/oiss/v0.2/schemas/v0.2/envelope.schema.json
https://raw.githubusercontent.com/bcyong/oiss/v0.2/schemas/v0.2/shelf-observation.schema.json
...
```

Each schema's `$id` is that address. A record's optional `dataschema` attribute, when present, points to its record type's schema at its own version's address, so an incompatible change always means a different `dataschema`, as CloudEvents recommends. Before `1.0` the base address may move to a permanent OISS domain; `schemas/versions.json` always names the current one.
