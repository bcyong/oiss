# Store layout

All OISS records place things on one store layout, so outputs from different vendors line up on the same aisle, fixture and facing. The layout is published as a StoreLayout record ([`store-layout.schema.json`](../schemas/v0.2/store-layout.schema.json)), usually from the retailer's space planning or planogram system.

## Store

A store has an OISS `id`, which every record repeats in `oissstore`, and MAY carry the retailer's `storeNumber`, the `banner` it trades under and its GS1 `gln`. It also gives its `timezone` and the size of its floor plan.

## Floor plan

- Units are meters.
- The origin is the southwest corner of the floor plan as drawn: x points east (right on the plan), y points north (up on the plan) and z points up from the floor.
- `store.floor.width` and `store.floor.depth` bound the plan. Zone and fixture outlines MUST lie inside it.
- "East" and "north" describe the plan, not the compass. Every source in a store MUST use the same StoreLayout.

## Hierarchy

```
store
└── zone        an area of the store: an aisle, endcap, department, front end or entrance
    └── fixture a gondola run, endcap, wall section, cooler, freezer, display or checkout lane
        └── shelf   one shelf on the fixture, 0 at the bottom
            └── facing  the slot one item holds on that shelf in the planogram
```

Every element has an id that is unique within the store (see [identifiers.md](identifiers.md)). Children point to their parent by id: a fixture names its `zone`, a shelf its `fixture`, a facing its `shelf`. The validator checks that each parent exists.

## Planogram

Each facing MAY carry its planogram assignment: the item's `gtin`, how many `facings` wide it is, its shelf `capacity` in units and the `shelfPrice` its shelf tag should show. `sequence` orders facings left to right as a shopper faces the shelf. `planogramVersion` names the planogram the layout reflects. This is what shelf observations are checked against for planogram compliance and price integrity.

## Locations in other records

Other records point into the layout through `data.location`, from coarse to fine: `zone`, `fixture`, `shelf`, `facing`, plus the `camera` that saw it and an optional `point` on the floor plan. A record gives as much as it knows. A ShelfObservation is about one facing and a ZoneMetric about one zone, and the location MUST repeat it.

## Cameras

A camera has a `position` on the floor plan (with `z` for mounting height), a `yaw` in degrees counterclockwise from +x, a `pitch` in degrees (negative looks down), horizontal and vertical fields of view (`hfov`, `vfov`), a useful `range` in meters and the zones it `covers`. That is enough to show coverage on the store map and to place detections on the floor. Full camera calibration is out of scope for v0.2.
