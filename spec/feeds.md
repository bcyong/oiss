# Feed manifests

A store's OISS data comes from many systems and is read by many more. Before a retailer can retire a version or turn on a new one, it needs to know who writes and reads what. A **feed manifest** answers that: one small JSON document per connected system, saying which record types it writes or reads and in which OISS versions. It isn't a record and isn't sent with every event; a retailer keeps one per system in its integration registry, and the system's owner updates it at each upgrade. Schema: [`feed-manifest.schema.json`](../schemas/v0.2/feed-manifest.schema.json), new in v0.2.

| Field | Required | Meaning |
| --- | --- | --- |
| `oissversion` | yes | The OISS version the manifest itself follows. |
| `system` | yes | The system's name, as its records give it in `provenance.system`. |
| `vendor` | no | The company that runs it, as in `provenance.vendor`. |
| `source` | no | The CloudEvents `source` its records carry, or a prefix of it. |
| `stores` | no | The store ids it serves. Left out means every store. |
| `produces` | one of these | Each record type it writes, with the one version it writes now and the extension namespaces it adds. |
| `reads` | one of these | Each record type it reads, with every version it can read and the extension namespaces it understands. |
| `contact` | no | The team or role to ask about its upgrades. |

## Example

A loss prevention vendor that hasn't upgraded yet still writes v0.1:

```json
{
  "oissversion": "0.2",
  "system": "Mock loss prevention",
  "vendor": "Vendor B",
  "source": "urn:oiss:demo-001:mock-vendor-b:lp-alerts",
  "produces": [
    { "type": "oiss.Incident", "versions": ["0.1"] },
    { "type": "oiss.Evidence", "versions": ["0.1"] }
  ]
}
```

More are in [`examples/feeds`](../examples/feeds), including an agent platform that reads both versions.

## How a retailer uses them

- **Before a reader upgrades:** check that every version listed under any `produces` is one it can read.
- **Before a version is retired:** check that no manifest still lists it under `produces`.
- **When a record arrives in a version its producer's manifest doesn't list:** treat it as a sign the producer upgraded without notice, and follow it up.

Manifests follow the same idea as ONVIF's conformance claims, where a device states which profile it meets, but OISS keeps them lighter: a manifest is a statement from the system's owner, not a certification.
