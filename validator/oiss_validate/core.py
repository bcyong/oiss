"""Schema and rule checks for OISS records.

A record passes when it validates against schemas/<version>/envelope.schema.json
and against the rules in this module that JSON Schema can't express (time
order, store-map references, synthetic GTINs).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_SCHEMA_DIR = REPO_ROOT / "schemas" / "v0.1"
ENVELOPE_FILE = "envelope.schema.json"

_URI = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$")
_URI_REFERENCE = re.compile(r"^[^\s]*$")


@dataclass(frozen=True)
class Problem:
    """One reason a record is invalid."""

    path: str
    message: str
    rule: str  # "schema" or the name of an OISS rule

    def __str__(self) -> str:
        where = self.path or "(record)"
        return f"{where}: {self.message} [{self.rule}]"


def gtin_check_digit_ok(digits: str) -> bool:
    """GS1 mod-10 check digit, for GTIN-8/12/13/14 and GLN."""
    if not digits.isdigit() or len(digits) < 2:
        return False
    body, check = digits[:-1], int(digits[-1])
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def parse_time(value: str) -> datetime:
    """RFC 3339 timestamp with a required offset ("Z" or +hh:mm)."""
    if not isinstance(value, str) or not re.search(r"(Z|[+-]\d{2}:\d{2})$", value) or "T" not in value:
        raise ValueError(f"not an RFC 3339 timestamp with an offset: {value!r}")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _format_checker() -> FormatChecker:
    checker = FormatChecker(formats=())

    @checker.checks("date-time", raises=ValueError)
    def _date_time(value: object) -> bool:
        if not isinstance(value, str):
            return True
        parse_time(value)
        return True

    @checker.checks("gtin")
    def _gtin(value: object) -> bool:
        return not isinstance(value, str) or gtin_check_digit_ok(value)

    @checker.checks("uri")
    def _uri(value: object) -> bool:
        return not isinstance(value, str) or bool(_URI.match(value))

    @checker.checks("uri-reference")
    def _uri_ref(value: object) -> bool:
        return not isinstance(value, str) or bool(_URI_REFERENCE.match(value))

    return checker


def _load_registry(schema_dir: Path) -> tuple[Registry, str]:
    resources = []
    envelope_id = None
    for path in sorted(schema_dir.glob("*.schema.json")):
        contents = json.loads(path.read_text())
        resources.append((contents["$id"], Resource.from_contents(contents)))
        if path.name == ENVELOPE_FILE:
            envelope_id = contents["$id"]
    if envelope_id is None:
        raise FileNotFoundError(f"no {ENVELOPE_FILE} in {schema_dir}")
    return Registry().with_resources(resources), envelope_id


def _json_path(parts: Iterable[Any]) -> str:
    out = ""
    for part in parts:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out.lstrip(".")


class Validator:
    """Validates OISS records. One instance can check many records."""

    def __init__(self, schema_dir: Path | str = DEFAULT_SCHEMA_DIR) -> None:
        registry, envelope_id = _load_registry(Path(schema_dir))
        envelope = registry.contents(envelope_id)
        self._schema = Draft202012Validator(envelope, registry=registry, format_checker=_format_checker())

    def problems(self, record: Any) -> list[Problem]:
        found = [
            Problem(_json_path(err.absolute_path), err.message, "schema")
            for err in sorted(self._schema.iter_errors(record), key=lambda e: list(map(str, e.absolute_path)))
        ]
        if found:
            # Rule checks assume a schema-valid record.
            return found
        return list(_rule_problems(record))

    def is_valid(self, record: Any) -> bool:
        return not self.problems(record)


# ---- OISS rules beyond JSON Schema ------------------------------------------------


def _rule_problems(record: dict) -> Iterator[Problem]:
    data = record["data"]
    rtype = record["type"]

    window = data.get("window")
    if window:
        start, end = parse_time(window["start"]), parse_time(window["end"])
        if start > end:
            yield Problem("data.window", "start is after end", "window-order")

    if data["provenance"].get("synthetic"):
        for path, gtin in _gtins(data):
            if not gtin.startswith("02"):
                yield Problem(
                    path,
                    f"synthetic GTIN {gtin} must use the GS1 restricted-circulation prefixes 20-29 (written 02... as 14 digits)",
                    "synthetic-gtin",
                )

    if rtype == "oiss.ShelfObservation":
        facing = data["location"].get("facing")
        if facing != record["subject"]:
            yield Problem("data.location.facing", "must be present and equal subject (the facing id)", "subject-matches-location")

    elif rtype == "oiss.ZoneMetric":
        zone = data["location"].get("zone")
        if zone != record["subject"]:
            yield Problem("data.location.zone", "must be present and equal subject (the zone id)", "subject-matches-location")

    elif rtype == "oiss.StoreMap":
        yield from _store_map_problems(record)

    elif rtype == "oiss.Trajectory":
        yield from _trajectory_problems(data)


def _gtins(data: dict) -> Iterator[tuple[str, str]]:
    for key in ("gtin", "expectedGtin"):
        if key in data:
            yield f"data.{key}", data[key]
    for i, gtin in enumerate(data.get("gtins", [])):
        yield f"data.gtins[{i}]", gtin
    for i, facing in enumerate(data.get("facings", [])):
        if "gtin" in facing:
            yield f"data.facings[{i}].gtin", facing["gtin"]


def _store_map_problems(record: dict) -> Iterator[Problem]:
    data = record["data"]
    if data["store"]["id"] != record["oissstore"] or record["subject"] != record["oissstore"]:
        yield Problem("data.store.id", "store id, subject and oissstore must all match", "store-id")

    seen: dict[str, str] = {}
    for kind in ("zones", "fixtures", "shelves", "facings", "cameras"):
        for i, item in enumerate(data.get(kind, [])):
            if item["id"] in seen:
                yield Problem(f"data.{kind}[{i}].id", f"id {item['id']} is already used by {seen[item['id']]}", "unique-ids")
            else:
                seen[item["id"]] = kind

    ids = {kind: {item["id"] for item in data.get(kind, [])} for kind in ("zones", "fixtures", "shelves")}
    parents = (("fixtures", "zone", "zones"), ("shelves", "fixture", "fixtures"), ("facings", "shelf", "shelves"))
    for kind, field, parent_kind in parents:
        for i, item in enumerate(data.get(kind, [])):
            if item[field] not in ids[parent_kind]:
                yield Problem(f"data.{kind}[{i}].{field}", f"{item[field]} is not in {parent_kind}", "map-references")
    for i, cam in enumerate(data.get("cameras", [])):
        for j, zone in enumerate(cam.get("covers", [])):
            if zone not in ids["zones"]:
                yield Problem(f"data.cameras[{i}].covers[{j}]", f"{zone} is not in zones", "map-references")

    floor = data["store"]["floor"]
    for kind, field in (("zones", "polygon"), ("fixtures", "footprint")):
        for i, item in enumerate(data.get(kind, [])):
            for j, p in enumerate(item[field]):
                if not (0 <= p["x"] <= floor["width"] and 0 <= p["y"] <= floor["depth"]):
                    yield Problem(f"data.{kind}[{i}].{field}[{j}]", "point is outside the floor plan", "on-floor")


def _trajectory_problems(data: dict) -> Iterator[Problem]:
    times = [parse_time(p["t"]) for p in data["points"]]
    if any(b < a for a, b in zip(times, times[1:])):
        yield Problem("data.points", "points must be in time order", "trajectory-order")
    start, end = parse_time(data["window"]["start"]), parse_time(data["window"]["end"])
    if times and (times[0] < start or times[-1] > end):
        yield Problem("data.points", "points must fall inside the window", "trajectory-window")
    if parse_time(data["idValidUntil"]) < times[-1]:
        yield Problem("data.idValidUntil", "track id expired before the last point; rotate the id", "track-rotation")
