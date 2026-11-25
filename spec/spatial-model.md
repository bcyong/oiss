# Spatial model

All OISS records place things in one store model, so outputs from different vendors line up. The model is published as a StoreMap record ([`store-map.schema.json`](../schemas/v0.1/store-map.schema.json)).

## Floor-plan frame

- Units are meters.
- The origin is the southwest corner of the floor plan as drawn: x points east (right on the plan), y points north (up on the plan) and z points up from the floor.
- `store.floor.width` and `store.floor.depth` bound the plan. Zone polygons and fixture footprints MUST lie inside it.
- "East" and "north" describe the plan, not the compass. A store MAY rotate its plan however it likes as long as every producer uses the same StoreMap.

## Hierarchy

```
store
└── zone        an area: an aisle, endcap, checkout, entrance, department
    └── fixture a physical unit: shelving run, cooler, display, checkout lane
        └── shelf   one level of a fixture, 0 at the bottom
            └── facing  one product slot on a shelf, ordered left to right as a shopper faces it
```

Every element has an id that is unique within the store (see [identifiers.md](identifiers.md)). Children point to their parent by id: a fixture names its `zone`, a shelf its `fixture`, a facing its `shelf`. The validator checks that each parent exists.

A facing MAY carry the planogram assignment: the `gtin` that belongs there, its `capacity` and the intended shelf `price`. `planogramVersion` names the planogram the map reflects.

## Locations in other records

Other records point into the map through `data.location`, from coarse to fine: `zone`, `fixture`, `shelf`, `facing`, plus `camera` for the camera that saw it and an optional `point` in the floor-plan frame. A record gives as much as it knows. A ShelfObservation's `subject` is its facing id and a ZoneMetric's is its zone id, and the location MUST repeat it.

## Cameras

A camera has a `position` in the floor-plan frame (with `z` for mounting height), a `yaw` in degrees counterclockwise from +x, a `pitch` in degrees (negative looks down), horizontal and vertical fields of view (`hfov`, `vfov`), a useful `range` in meters and the zones it `covers`. This is enough to draw coverage on the plan and to project detections onto the floor. Full calibration (intrinsics and distortion) is out of scope for v0.1.
