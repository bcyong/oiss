# Versioning

OISS changes over time, and retailers, vendors and agent platforms each upgrade on their own schedule. These rules say what a version number promises, so a team can tell from the number alone whether an upgrade needs work on their side.

## The version number

OISS versions are `MAJOR.MINOR`, such as `0.1` or `1.2`. Every record states the version it follows in its `oissversion` attribute (see [envelope.md](envelope.md#oiss-extension-attributes)), and its schemas live under `schemas/vMAJOR.MINOR/`.

- A **minor** version (`1.1` → `1.2`) only adds. A record that was valid under `1.1` is still valid under `1.2`, and a reader built for `1.1` can read `1.2` records by ignoring what it doesn't know.
- A **major** version (`1.x` → `2.0`) may change or remove things. It comes with a migration note listing every change and how to map old records to new ones.

There is no patch number. Fixes to the spec text that change no rule, such as wording, examples or typos, are made in place and listed in the changelog.

## What counts as compatible

These are **minor** changes:

- a new record type
- a new optional field on an existing record type
- a new value in a controlled vocabulary, such as a new shelf condition flag or task type
- a new optional CloudEvents extension attribute
- relaxing a rule, such as making a required field optional or raising a limit

These are **major** changes:

- removing or renaming a field, record type or vocabulary value
- making an optional field required
- changing what a field means, its unit or its type
- tightening a rule so that some valid records stop being valid
- changing an identifier format

## Rules for producers and readers

- A producer (a vendor system, adapter or in-house system) MUST set `oissversion` to the version whose schemas it validated the record against.
- A reader MUST ignore fields it doesn't know, and SHOULD treat a vocabulary value it doesn't know as `unknown` or "other" rather than rejecting the record. This is what lets a minor version roll out one vendor at a time.
- A reader MAY reject a record whose major version it doesn't support, and SHOULD say so in its logs.
- An adapter that maps between versions MUST record itself in the record's `provenance.adapter`.

## Deprecation

A field, record type or value that will be removed in the next major version is first marked deprecated in a minor version, with its replacement named in the spec text and the schema's `deprecated` keyword. Producers SHOULD stop sending it; readers MUST keep accepting it until the next major version. A deprecated item stays for at least one minor version before the major version that removes it.

## Drafts before 1.0

Versions `0.x` are drafts. Any `0.x` release MAY make major changes, so early adopters should pin a minor version and read its changelog before moving up. The compatibility rules above take full effect at `1.0`.

## Schema locations

Each version's schemas are published at a fixed path and never change once that version is released:

```
schemas/v0.1/envelope.schema.json
schemas/v0.1/shelf-observation.schema.json
...
```

A record's optional `dataschema` attribute, when present, points to the schema at its version's path.
