"""Schema and rule checks for OISS records.

A record passes when it validates against the envelope schema of its own OISS
version (schemas/v<oissversion>/envelope.schema.json, found through
schemas/versions.json) and against the rules in this module that JSON Schema
can't express (time order, store-layout references, synthetic GTINs, no
personal data in extensions).

Two modes, as spec/versioning.md describes:

- producer (the default): the strict check a producer runs before it sends a
  record. Fields and vocabulary values the record's version doesn't define fail.
- reader: the check a reader runs on what it receives. Unknown fields and
  vocabulary values pass, and a record from a newer minor version of a major
  version the reader knows is checked against the newest minor it knows.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Iterator, Literal

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMAS_DIR = REPO_ROOT / "schemas"
VERSIONS_FILE = SCHEMAS_DIR / "versions.json"
ENVELOPE_FILE = "envelope.schema.json"
#: Kept for callers that pin one version; the validator itself picks a version per record.
DEFAULT_SCHEMA_DIR = SCHEMAS_DIR / "v0.1"

Mode = Literal["producer", "reader"]

#: The record types this validator knows, and the privacy classes. Both vocabularies are
#: closed: a reader treats a type or class it doesn't know as restricted.
OISS_RECORD_TYPES = frozenset(
    f"oiss.{t}" for t in ("StoreLayout", "ShelfObservation", "ZoneMetric", "ShopperPath", "Incident", "Evidence", "Task")
)
PRIVACY_CLASSES = ("operational", "aggregate", "anonymous_path", "restricted")

_URI = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:[^\s]*$")
_URI_REFERENCE = re.compile(r"^[^\s]*$")
_VERSION = re.compile(r"^(\d+)\.(\d+)$")


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


def parse_version(value: Any) -> tuple[int, int] | None:
    """"1.2" -> (1, 2); anything else -> None."""
    m = _VERSION.match(value) if isinstance(value, str) else None
    return (int(m.group(1)), int(m.group(2))) if m else None


def effective_privacy(record: dict) -> str:
    """The privacy class a reader must apply: the record's own class when the reader knows
    both it and the record's type (OISS or a vendor type it was built for), else restricted."""
    privacy = record.get("oissprivacy")
    rtype = record.get("type")
    if privacy not in PRIVACY_CLASSES:
        return "restricted"
    if not isinstance(rtype, str) or (rtype.startswith("oiss.") and rtype not in OISS_RECORD_TYPES):
        return "restricted"
    return privacy


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


def _lenient(node: Any, *, top: bool = True) -> Any:
    """A reader's copy of a schema: unknown fields and vocabulary values allowed, and the
    envelope's oissversion left open so a newer minor version can be read."""
    if isinstance(node, list):
        return [_lenient(n, top=False) for n in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for key, value in node.items():
        if key in ("additionalProperties", "unevaluatedProperties") and value is False:
            continue
        if key == "enum":
            continue
        out[key] = _lenient(value, top=False)
    if top and "oissversion" in out.get("properties", {}):
        out["properties"]["oissversion"] = {"type": "string", "pattern": _VERSION.pattern}
    return out


def _load_registry(schema_dir: Path, lenient: bool = False) -> tuple[Registry, str]:
    resources = []
    envelope_id = None
    for path in sorted(schema_dir.glob("*.schema.json")):
        contents = json.loads(path.read_text())
        if lenient:
            contents = _lenient(contents)
        resources.append((contents["$id"], Resource.from_contents(contents)))
        if path.name == ENVELOPE_FILE:
            envelope_id = contents["$id"]
    if envelope_id is None:
        raise FileNotFoundError(f"no {ENVELOPE_FILE} in {schema_dir}")
    return Registry().with_resources(resources), envelope_id


def _envelope_validator(schema_dir: Path, lenient: bool) -> Draft202012Validator:
    registry, envelope_id = _load_registry(schema_dir, lenient)
    return Draft202012Validator(registry.contents(envelope_id), registry=registry, format_checker=_format_checker())


def known_versions(schemas_dir: Path = SCHEMAS_DIR) -> list[str]:
    """The versions listed in schemas/versions.json, oldest first."""
    listing = json.loads((schemas_dir / "versions.json").read_text())
    return sorted((v["version"] for v in listing["versions"]), key=lambda v: parse_version(v) or (0, 0))


def _json_path(parts: Iterable[Any]) -> str:
    out = ""
    for part in parts:
        out += f"[{part}]" if isinstance(part, int) else f".{part}"
    return out.lstrip(".")


class Validator:
    """Validates OISS records of every version in schemas/versions.json. One instance can check
    many records, of mixed versions.

    Pass schema_dir to pin a single version's schema folder instead; every record is then
    checked against it whatever its oissversion says.
    """

    def __init__(self, schema_dir: Path | str | None = None, *, mode: Mode = "producer", schemas_dir: Path | str = SCHEMAS_DIR) -> None:
        if mode not in ("producer", "reader"):
            raise ValueError(f"mode must be producer or reader, not {mode!r}")
        self.mode = mode
        lenient = mode == "reader"
        if schema_dir is not None:
            self._pinned: Draft202012Validator | None = _envelope_validator(Path(schema_dir), lenient)
            self._by_version: dict[str, Draft202012Validator] = {}
        else:
            self._pinned = None
            root = Path(schemas_dir)
            self._by_version = {v: _envelope_validator(root / f"v{v}", lenient) for v in known_versions(root)}

    @property
    def versions(self) -> list[str]:
        """The OISS versions this validator checks records against."""
        return list(self._by_version)

    def schema_version_for(self, record: Any) -> str | None:
        """Which known version a record is checked against, or None when none fits.

        A producer's record must name a version this validator knows. A reader also accepts a
        newer minor version of a major version from 1 up, checked against the newest minor of
        that major it knows; before 1.0 every minor version may break, so it must be known."""
        declared = record.get("oissversion") if isinstance(record, dict) else None
        if declared in self._by_version:
            return declared
        if self.mode != "reader":
            return None
        parsed = parse_version(declared)
        if parsed is None or parsed[0] < 1:
            return None
        same_major = [v for v in self._by_version if (pv := parse_version(v)) and pv[0] == parsed[0] and pv[1] < parsed[1]]
        return max(same_major, key=lambda v: parse_version(v) or (0, 0)) if same_major else None

    def problems(self, record: Any) -> list[Problem]:
        if self._pinned is not None:
            schema = self._pinned
        else:
            version = self.schema_version_for(record)
            if version is None:
                declared = record.get("oissversion") if isinstance(record, dict) else None
                known = ", ".join(self._by_version)
                return [Problem("oissversion", f"version {declared!r} isn't one this validator can check (it knows {known})", "unsupported-version")]
            schema = self._by_version[version]
        found = [
            Problem(_json_path(err.absolute_path), err.message, "schema")
            for err in sorted(schema.iter_errors(record), key=lambda e: list(map(str, e.absolute_path)))
        ]
        if found:
            # Rule checks assume a schema-valid record.
            return found
        rules = list(_rule_problems(record))
        if self.mode == "reader":
            # A reader lets unknown fields through, so it looks at every field's name for
            # personal data, not only at extensions.
            covered = {p.path for p in rules}
            rules += [p for p in _personal_data_keys(record["data"], "data") if p.path not in covered]
        return rules

    def is_valid(self, record: Any) -> bool:
        return not self.problems(record)


# ---- OISS rules beyond JSON Schema ------------------------------------------------


def _rule_problems(record: dict) -> Iterator[Problem]:
    data = record["data"]
    rtype = record["type"]

    for name, ext in (data.get("extensions") or {}).items():
        if isinstance(ext, dict):
            yield from _personal_data_keys(ext.get("data"), f"data.extensions.{name}.data")
    if not rtype.startswith("oiss."):
        yield from _personal_data_keys({k: v for k, v in data.items() if k not in ("provenance", "extensions")}, "data")

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

    elif rtype == "oiss.StoreLayout":
        yield from _store_layout_problems(record)

    elif rtype == "oiss.ShopperPath":
        yield from _shopper_path_problems(data)


def _gtins(data: dict) -> Iterator[tuple[str, str]]:
    for key in ("observedGtin", "planogramGtin"):
        if key in data:
            yield f"data.{key}", data[key]
    for i, gtin in enumerate(data.get("gtins", [])):
        yield f"data.gtins[{i}]", gtin
    for i, facing in enumerate(data.get("facings", [])):
        if "gtin" in facing:
            yield f"data.facings[{i}].gtin", facing["gtin"]


def _store_layout_problems(record: dict) -> Iterator[Problem]:
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


def _shopper_path_problems(data: dict) -> Iterator[Problem]:
    times = [parse_time(p["t"]) for p in data["points"]]
    if any(b < a for a, b in zip(times, times[1:])):
        yield Problem("data.points", "points must be in time order", "path-order")
    start, end = parse_time(data["window"]["start"]), parse_time(data["window"]["end"])
    if times and (times[0] < start or times[-1] > end):
        yield Problem("data.points", "points must fall inside the window", "path-window")
    if parse_time(data["idValidUntil"]) < times[-1]:
        yield Problem("data.idValidUntil", "path id expired before the last point; rotate the id", "path-id-rotation")


# ---- No personal data in extensions or vendor record types ------------------------

# Field names that say a field holds a person's identity. This is a backstop for the rule in
# spec/extensions.md, not a guarantee: OISS can't see what a value means, only what it's called.
_PERSONAL_WORDS = frozenset({"face", "faces", "biometric", "biometrics", "fingerprint", "voiceprint", "iris", "gait", "ssn", "passport", "email", "phone", "dob"})
_PERSONAL_COMPOUNDS = frozenset(
    {"faceid", "faceembedding", "faceprint", "facialrecognition", "personembedding", "bodyembedding", "reid", "licenseplate", "socialsecurity",
     "dateofbirth", "birthdate", "homeaddress", "loyaltynumber", "loyaltyid", "cardnumber", "customername", "shoppername", "phonenumber"}
)


def _words(key: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", key)
    return [w for w in re.split(r"[^A-Za-z0-9]+", spaced.lower()) if w]


def _looks_personal(key: str) -> bool:
    words = _words(key)
    if any(w in _PERSONAL_WORDS for w in words):
        return True
    for n in (2, 3):
        for i in range(len(words) - n + 1):
            if "".join(words[i : i + n]) in _PERSONAL_COMPOUNDS:
                return True
    return "".join(words) in _PERSONAL_COMPOUNDS


def _personal_data_keys(node: Any, path: str) -> Iterator[Problem]:
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}"
            if isinstance(key, str) and _looks_personal(key):
                yield Problem(here, f"{key} looks like biometric or personal data, which OISS records must not carry", "no-personal-data")
            yield from _personal_data_keys(value, here)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from _personal_data_keys(value, f"{path}[{i}]")
