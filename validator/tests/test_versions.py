"""Records of several OISS versions in one store, and how readers and producers treat them."""

import copy
import json
import shutil
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from oiss_validate import Validator, effective_privacy, known_versions, parse_version

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas"
LISTING = json.loads((SCHEMAS / "versions.json").read_text())


def load(*parts):
    return json.loads(ROOT.joinpath(*parts).read_text())


def test_versions_json_matches_the_schema_folders():
    folders = sorted(p.name.removeprefix("v") for p in SCHEMAS.glob("v*") if p.is_dir())
    assert sorted(known_versions()) == folders
    assert LISTING["current"] == known_versions()[-1]
    for entry in LISTING["versions"]:
        folder = SCHEMAS / f"v{entry['version']}"
        envelope = json.loads((folder / "envelope.schema.json").read_text())
        assert envelope["properties"]["oissversion"]["const"] == entry["version"]
        for path in folder.glob("*.schema.json"):
            schema = json.loads(path.read_text())
            # Every $id is the frozen, tagged address, never a branch.
            assert schema["$id"] == entry["base"] + path.name
            assert f"/{entry['tag']}/" in schema["$id"]


def test_one_store_holds_records_of_two_versions():
    validator = Validator()
    old = load("examples", "older", "shelf-observation-v0.1.json")
    new = load("examples", "valid", "shelf-observation.json")
    assert old["oissversion"] == "0.1" and new["oissversion"] == "0.2"
    assert old["subject"] == new["subject"]
    assert validator.problems(old) == [] and validator.problems(new) == []


def test_each_record_is_checked_against_its_own_version():
    validator = Validator()
    old = load("examples", "older", "shelf-observation-v0.1.json")
    # Extensions arrived in 0.2, so a record that says 0.1 can't carry them.
    old["data"]["extensions"] = {"com.example.shelfscan": {"data": {"pass": 2}}}
    assert any(p.rule == "schema" and "extensions" in p.message for p in validator.problems(old))
    old["oissversion"] = "0.2"
    assert validator.problems(old) == []


def test_producer_rejects_unknown_fields_and_values_reader_lets_them_through():
    record = load("examples", "valid", "task.json")
    record["data"]["laborMinutesEstimate"] = 12  # a field a later version might add
    producer, reader = Validator(), Validator(mode="reader")
    assert producer.problems(record)
    assert reader.problems(record) == []
    unknown_value = load("examples", "invalid", "task-unknown-outcome.json")
    assert producer.problems(unknown_value)
    assert reader.problems(unknown_value) == []


def test_reader_still_requires_what_the_version_requires():
    record = load("examples", "invalid", "evidence-no-retention.json")
    assert Validator(mode="reader").problems(record)


def test_reader_still_refuses_personal_data_in_unknown_fields():
    record = load("examples", "invalid", "shopper-path-face-field.json")
    problems = Validator(mode="reader").problems(record)
    assert any(p.rule == "no-personal-data" and "faceEmbedding" in p.path for p in problems)


def test_facing_is_not_mistaken_for_a_face():
    record = load("examples", "valid", "shelf-observation-extension.json")
    record["data"]["extensions"]["com.example.shelfscan"]["data"]["facingCount"] = 4
    record["data"]["extensions"]["com.example.shelfscan"]["data"]["surfaceGlare"] = 0.1
    assert Validator().problems(record) == []


def test_before_1_0_a_reader_needs_the_exact_version():
    record = load("examples", "invalid", "shelf-observation-unknown-version.json")
    assert [p.rule for p in Validator(mode="reader").problems(record)] == ["unsupported-version"]


def test_from_1_0_a_reader_reads_a_newer_minor_with_the_newest_it_knows(tmp_path):
    # Pretend 1.0 is out and a producer has moved to 1.1, which this reader doesn't have yet.
    base = "https://example.com/oiss/v1.0/"
    folder = tmp_path / "v1.0"
    shutil.copytree(SCHEMAS / "v0.2", folder)
    for path in folder.glob("*.schema.json"):
        schema = json.loads(path.read_text())
        schema["$id"] = base + path.name
        if path.name == "envelope.schema.json":
            schema["properties"]["oissversion"]["const"] = "1.0"
        path.write_text(json.dumps(schema))
    (tmp_path / "versions.json").write_text(json.dumps({"current": "1.0", "versions": [{"version": "1.0", "tag": "v1.0", "base": base}]}))

    record = load("examples", "valid", "zone-metric.json")
    record["oissversion"] = "1.1"
    record["data"]["dwellSecondsP90"] = 140  # new in 1.1
    reader = Validator(mode="reader", schemas_dir=tmp_path)
    assert reader.schema_version_for(record) == "1.0"
    assert reader.problems(record) == []
    assert Validator(schemas_dir=tmp_path).problems(record)[0].rule == "unsupported-version"
    record["oissversion"] = "2.0"
    assert reader.problems(record)[0].rule == "unsupported-version"


def test_unknown_privacy_classes_and_types_are_treated_as_restricted():
    record = load("examples", "valid", "zone-metric.json")
    assert effective_privacy(record) == "aggregate"
    future = copy.deepcopy(record)
    future["oissprivacy"] = "pseudonymous"
    assert effective_privacy(future) == "restricted"
    future = copy.deepcopy(record)
    future["type"] = "oiss.QueueEstimate"
    assert effective_privacy(future) == "restricted"
    # A vendor type keeps its own class; a reader that doesn't know the type skips it anyway.
    assert effective_privacy(load("examples", "valid", "vendor-record-type.json")) == "operational"


@pytest.mark.parametrize("path", sorted((ROOT / "examples" / "feeds").glob("*.json")), ids=lambda p: p.name)
def test_feed_manifests_are_valid(path):
    from referencing import Registry, Resource

    folder = SCHEMAS / f"v{LISTING['current']}"
    resources = [(s["$id"], Resource.from_contents(s)) for s in (json.loads(p.read_text()) for p in folder.glob("*.schema.json"))]
    schema = json.loads((folder / "feed-manifest.schema.json").read_text())
    validator = Draft202012Validator(schema, registry=Registry().with_resources(resources))
    manifest = json.loads(path.read_text())
    assert list(validator.iter_errors(manifest)) == []
    for use in manifest.get("produces", []) + manifest.get("reads", []):
        assert all(v in known_versions() for v in use["versions"])


def test_versions_parse():
    assert parse_version("1.12") == (1, 12)
    assert parse_version("1") is None and parse_version(1.2) is None
