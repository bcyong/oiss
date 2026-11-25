# Envelope

Every OISS record is a [CloudEvents 1.0](https://github.com/cloudevents/spec) event in structured JSON mode, so any CloudEvents tooling can route, filter and store it. Schema: [`envelope.schema.json`](../schemas/v0.1/envelope.schema.json).

## CloudEvents attributes

| Attribute | Required | OISS meaning |
| --- | --- | --- |
| `specversion` | yes | Always `"1.0"`. |
| `id` | yes | Unique per `source`. A record that updates another (such as a task's new state) gets a new `id` and keeps the same `subject`. |
| `source` | yes | The producing system or device, as a URI reference. A URN such as `urn:oiss:<store>:<vendor>:<device>` works. |
| `type` | yes | The record type: `oiss.StoreMap`, `oiss.ShelfObservation`, `oiss.ZoneMetric`, `oiss.Trajectory`, `oiss.Incident`, `oiss.Evidence` or `oiss.Task`. |
| `time` | yes | When the observed thing happened, or when the record's state took effect. RFC 3339 with an offset. |
| `subject` | yes | The id of the thing the record is about: a facing, zone, track, incident, evidence item, task or store. |
| `dataschema` | no | The URL of the record type's schema. |
| `datacontenttype` | yes | Always `"application/json"`. |
| `data` | yes | The record body, described by the record type's schema. |

## OISS extension attributes

CloudEvents extension values must be simple strings, so OISS puts only the fields that brokers and gateways route on at the top level:

| Attribute | Required | Meaning |
| --- | --- | --- |
| `oissversion` | yes | The OISS version the record follows. `"0.1"` for now. |
| `oissstore` | yes | The store id, as defined by the store's StoreMap. |
| `oissprivacy` | yes | The record's privacy class (see [vocabularies.md](vocabularies.md#privacy-classes)). A reader MUST NOT see a record above the class it's cleared for. |

Each record type has a privacy floor: StoreMap is `operational`, ZoneMetric at least `aggregate`, Trajectory at least `anonymous_track`, and Incident and Evidence are always `restricted`.

## Shared data fields

Structured fields that every record may carry sit inside `data`:

| Field | Meaning |
| --- | --- |
| `provenance` | Required. The producing `system`, and optionally its `vendor`, `model` (name and version), the `adapter` that mapped it into OISS, and `synthetic: true` for simulated data. |
| `window` | The time span the observation covers (`start`, `end`). `start` MUST NOT be after `end`. |
| `location` | Where the record applies, as StoreMap ids (`zone`, `fixture`, `shelf`, `facing`, `camera`) and an optional floor-plan `point`. |
| `confidence` | From 0 to 1: how sure the producer is. |
| `evidence` | Ids of Evidence records that back this one. |

Each record type says which of these it requires. Records MUST NOT carry fields their schema doesn't define, so a producer can't slip biometric or personal data into a record.

## Example

```json
{
  "specversion": "1.0",
  "id": "so-0001",
  "source": "urn:oiss:demo-001:mock-vendor-a:scanner-1",
  "type": "oiss.ShelfObservation",
  "time": "2026-11-25T09:14:00-08:00",
  "subject": "A07-L-S3-F05",
  "datacontenttype": "application/json",
  "oissversion": "0.1",
  "oissstore": "demo-001",
  "oissprivacy": "operational",
  "data": {
    "provenance": { "system": "Mock shelf scanner", "synthetic": true },
    "window": { "start": "2026-11-25T09:13:40-08:00", "end": "2026-11-25T09:14:00-08:00" },
    "location": { "zone": "aisle-07", "facing": "A07-L-S3-F05" },
    "status": "low",
    "confidence": 0.91
  }
}
```

The full version is [`examples/valid/shelf-observation.json`](../examples/valid/shelf-observation.json).
