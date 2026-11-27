import copy
import json
from pathlib import Path

import pytest

from oiss_validate import Validator, effective_privacy, gtin_check_digit_ok, known_versions
from oiss_validate.cli import main

ROOT = Path(__file__).resolve().parents[2]
VALID = sorted((ROOT / "examples" / "valid").glob("*.json"))
OLDER = sorted((ROOT / "examples" / "older").glob("*.json"))
INVALID = sorted((ROOT / "examples" / "invalid").glob("*.json"))

# What each invalid example must be rejected for.
EXPECTED = {
    "store-layout-dangling-shelf.json": ("map-references", "A08-L"),
    "shelf-observation-bad-check-digit.json": ("schema", "gtin"),
    "shelf-observation-no-status-or-price.json": ("schema", "not valid under any of the given schemas"),
    "zone-metric-window-reversed.json": ("window-order", "start is after end"),
    "shopper-path-face-field.json": ("schema", "faceEmbedding"),
    "incident-wrong-privacy.json": ("schema", "restricted"),
    "evidence-no-retention.json": ("schema", "retainUntil"),
    "task-verified-without-proof.json": ("schema", "verifiedBy"),
    "task-unknown-outcome.json": ("schema", "item_returned"),
    "extension-face-field.json": ("no-personal-data", "shopperFaceEmbedding"),
    "extension-reserved-namespace.json": ("schema", "oiss.shelfscan"),
    "shelf-observation-unknown-version.json": ("unsupported-version", "0.3"),
    "vendor-record-type-phone-number.json": ("no-personal-data", "PhoneNumber"),
}

RECORD_TYPES = {"StoreLayout", "ShelfObservation", "ZoneMetric", "ShopperPath", "Incident", "Evidence", "Task"}


@pytest.fixture(scope="module")
def validator():
    return Validator()


def load(path):
    return json.loads(Path(path).read_text())


def test_every_record_type_has_a_valid_and_an_invalid_example():
    oiss_types = lambda paths: {load(p)["type"].removeprefix("oiss.") for p in paths if load(p)["type"].startswith("oiss.")}
    valid_types, invalid_types = oiss_types(VALID), oiss_types(INVALID)
    assert valid_types == RECORD_TYPES
    assert invalid_types == RECORD_TYPES
    assert set(EXPECTED) == {p.name for p in INVALID}


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_valid_examples_pass(validator, path):
    assert validator.problems(load(path)) == []


@pytest.mark.parametrize("path", OLDER, ids=lambda p: p.name)
def test_older_version_examples_still_pass(validator, path):
    record = load(path)
    assert record["oissversion"] != known_versions()[-1]
    assert validator.problems(record) == []


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_invalid_examples_fail_for_the_stated_reason(validator, path):
    problems = validator.problems(load(path))
    rule, words = EXPECTED[path.name]
    assert any(p.rule == rule and words in str(p) for p in problems), problems


def test_gtin_check_digit():
    assert gtin_check_digit_ok("00012345678905")  # a GTIN-12 written as 14 digits
    assert gtin_check_digit_ok("4006381333931")  # a GTIN-13 / GLN
    assert not gtin_check_digit_ok("4006381333932")
    assert not gtin_check_digit_ok("abc")


def test_synthetic_records_need_restricted_circulation_gtins(validator):
    record = load(ROOT / "examples" / "valid" / "shelf-observation.json")
    real_looking = copy.deepcopy(record)
    real_looking["data"]["observedGtin"] = "04006381333931"
    assert any(p.rule == "synthetic-gtin" for p in validator.problems(real_looking))
    real_looking["data"]["provenance"]["synthetic"] = False
    real_looking["data"]["planogramGtin"] = "04006381333931"
    assert validator.problems(real_looking) == []


def test_shopper_path_points_must_be_in_time_order(validator):
    record = load(ROOT / "examples" / "valid" / "shopper-path.json")
    record["data"]["points"].reverse()
    assert any(p.rule == "path-order" for p in validator.problems(record))


def test_shelf_observation_subject_is_the_facing(validator):
    record = load(ROOT / "examples" / "valid" / "shelf-observation.json")
    record["subject"] = "A07-L-S3-F06"
    assert any(p.rule == "subject-matches-location" for p in validator.problems(record))


def test_timestamps_need_an_offset(validator):
    record = load(ROOT / "examples" / "valid" / "zone-metric.json")
    record["time"] = "2026-11-25T17:30:00"
    assert validator.problems(record)


def test_cli_exit_codes(capsys):
    assert main([str(ROOT / "examples" / "valid"), str(ROOT / "examples" / "older"), "-q"]) == 0
    assert main([str(ROOT / "examples" / "invalid"), "-q"]) == 1
    assert f"0 of {len(INVALID)} records valid" in capsys.readouterr().out
