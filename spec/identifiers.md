# Identifiers

## OISS ids

Stores, zones, fixtures, shelves, facings, cameras, tracks, incidents, evidence items and tasks have OISS ids: 1 to 128 characters of letters, digits and `. _ : -`, starting with a letter or digit. An id is unique within its store and kind. Ids are opaque, so consumers MUST NOT parse meaning out of them, even when a store chooses readable ones like `A07-L-S3-F05`.

Track ids MUST NOT encode anything about the person and MUST rotate (see `idValidUntil` on Trajectory).

## Products: GTIN

Products are identified by GS1 GTINs, always written as 14 digits with leading zeros (a GTIN-13 `4006381333931` is written `04006381333931`). The check digit MUST be valid; the validator checks it.

## Stores: GLN

A store MAY give its GS1 Global Location Number in `store.gln` (13 digits, valid check digit). The OISS store id stays the key that records use in `oissstore`.

## Synthetic identifiers

Demo and test data MUST set `provenance.synthetic: true` and MUST NOT use real product GTINs. Synthetic products use GS1 prefixes 20 to 29, which GS1 sets aside for restricted circulation numbers. Numbers with those prefixes are not GTINs and are not globally unique, so they can't be mistaken for a real product in the open supply chain. Written as 14 digits they start with `02`, for example `02000000001012`. The validator rejects a synthetic record whose GTINs fall outside that range.

Synthetic stores leave `store.gln` out rather than invent one.

Source: GS1, [Summary of GS1 MO prefixes 20–29](https://www.gs1.org/docs/barcodes/SummaryOfGS1MOPrefixes20-29.pdf) and [GSCN 23-006](https://www.gs1.org/docs/barcodes/GSCN-23-006-RCN.pdf).
