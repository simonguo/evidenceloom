"""Offline evidence mutations must not invent completed provider inputs."""

from copy import deepcopy
import json
from unittest.mock import patch

import pandas as pd
import pytest

from tests.test_research_readiness import FETCHED, OBSERVED, fictional_bundle
from tradingagents.dataflows import market_data_validator as verifier
from tradingagents.evidence import EvidenceLedger, analyst_evidence
from tradingagents.memory.schema import hash_value, make_component
from tradingagents.research.market_inputs import ERROR, validate_market_observations


def _quality(evidence):
    record = evidence["records"][0]
    for source in record["sources"]:
        artifact = evidence["artifacts"][source["data_sha256"]]
        value = json.loads(artifact["payload"])
        if value.get("kind") == "market_verification_quality":
            return value, record
    raise AssertionError("fixture must include actual verifier quality")


def _replace_provider_data(evidence, mutate):
    evidence = deepcopy(evidence)
    for record in evidence["records"]:
        for source in record["sources"]:
            if source["provider"] != "yfinance":
                continue
            old = source["data_sha256"]
            payload = json.loads(evidence["artifacts"][old]["payload"])
            mutate(payload)
            artifact = {
                "kind": "normalized_data",
                "payload": json.dumps(payload, sort_keys=True, separators=(",", ":")),
            }
            digest = hash_value(artifact)
            evidence["artifacts"].pop(old, None)
            evidence["artifacts"][digest] = artifact
            source["data_sha256"] = digest
    return make_component(evidence, "bundle_sha256")


def _real_quality(tmp_path, frame, *, date="2026-01-09", observed=OBSERVED):
    with patch("tradingagents.evidence.ledger._utc_now", return_value=FETCHED):
        ledger = EvidenceLedger("FICT", date, {}, tmp_path)
        with (
            ledger.bind(),
            analyst_evidence("market"),
            patch.object(verifier, "load_ohlcv", return_value=frame),
        ):
            ledger.capture(
                "get_verified_market_snapshot",
                {"symbol": "FICT", "curr_date": date},
                lambda: verifier.build_verified_market_snapshot("FICT", date, observed_at=observed),
            )
    return ledger.bundle()


def _frame(count=250, *, zone="America/New_York", last="2026-01-08"):
    close = [100.12345678901235 + i / 10 for i in range(count)]
    frame = pd.DataFrame(
        {
            "Date": pd.date_range(end=last, periods=count, tz=zone),
            "Open": close,
            "High": [value + 2 for value in close],
            "Low": [value - 2 for value in close],
            "Close": close,
            "Volume": 10000,
        }
    )
    frame.attrs.update(source="yfinance", price_basis="auto_adjusted_ohlcv")
    return frame


def test_actual_saved_verifier_inputs_prove_quality_offline(tmp_path):
    evidence, _ = fictional_bundle(tmp_path)
    quality, record = _quality(evidence)
    before = deepcopy(evidence)
    assert validate_market_observations(quality, record, evidence) is None
    assert evidence == before
    assert quality["indicator_assessments"]["close_10_ema"]["value"] != round(
        quality["indicator_assessments"]["close_10_ema"]["value"], 2
    )


@pytest.mark.parametrize(
    "mutate",
    [
        lambda q: q.update(completion_status="unknown"),
        lambda q: q.update(timezone_origin="symbol_market_convention"),
        lambda q: q.update(source_timezone="Not_A_Real_Timezone"),
        lambda q: q["rows"].update(in_window=0),
        lambda q: q["rows"].update(
            latest_received_date="2026-01-09", latest_usable_date="2026-01-09"
        ),
        lambda q: q["requested_window"].update(end="2026-01-01"),
        lambda q: q["rows"].update(valid=200, usable_complete=200),
    ],
)
def test_quality_claims_cannot_override_saved_facts(tmp_path, mutate):
    evidence, _ = fictional_bundle(tmp_path)
    quality, record = _quality(evidence)
    mutate(quality)
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)


@pytest.mark.parametrize(
    "change",
    [
        "empty",
        "withheld",
        "missing_source_clock",
        "incoherent_high",
        "future_row",
        "negative_volume",
        "false_offset",
        "false_zone",
        "unknown_column",
    ],
)
def test_provider_rows_must_really_support_quality(tmp_path, change):
    evidence, _ = fictional_bundle(tmp_path)

    def mutate(payload):
        columns, rows = payload["columns"], payload["rows"]
        if change == "empty":
            rows.clear()
        elif change == "missing_source_clock":
            index = columns.index("SourceTimestamp")
            columns.pop(index)
            for row in rows:
                row.pop(index)
        elif change == "unknown_column":
            columns.append("raw_response")
            for row in rows:
                row.append("ignored envelope")
        else:
            column, value = {
                "incoherent_high": ("High", 1),
                "future_row": ("Date", "2026-01-10T00:00:00"),
                "negative_volume": ("Volume", -1),
                "false_offset": ("SourceUTCOffset", "+00:00"),
                "false_zone": ("SourceTimezone", "Asia/Shanghai"),
            }[change]
            rows[-1][columns.index(column)] = value

    if change == "withheld":
        for source in evidence["records"][0]["sources"]:
            if source["provider"] == "yfinance":
                source["historical_availability"] = "withheld"
    else:
        evidence = _replace_provider_data(evidence, mutate)
    quality, record = _quality(evidence)
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)


@pytest.mark.parametrize(
    "case",
    [
        "missing_close",
        "incoherent_high",
        "conflicting_duplicate",
        "identical_duplicate",
        "unknown_timezone",
        "convention_timezone",
        "provisional",
    ],
)
def test_honest_failed_or_provisional_assessments_remain_classifiable(tmp_path, case):
    frame = _frame()
    if case == "missing_close":
        frame.loc[0, "Close"] = None
    elif case == "incoherent_high":
        frame.loc[0, "High"] = 1
    elif case in {"conflicting_duplicate", "identical_duplicate"}:
        duplicate = frame.tail(1).copy()
        if case == "conflicting_duplicate":
            duplicate["Close"] += 1
        frame = pd.concat([frame, duplicate], ignore_index=True)
        frame.attrs.update(source="yfinance", price_basis="auto_adjusted_ohlcv")
    elif case == "unknown_timezone":
        frame["Date"] = frame["Date"].dt.tz_localize(None)
    elif case == "convention_timezone":
        frame["Date"] = frame["Date"].dt.tz_localize(None)
        frame.attrs.update(
            source_timezone="America/New_York", timezone_origin="symbol_market_convention"
        )
    elif case == "provisional":
        frame["Date"] += pd.Timedelta(days=1)
    evidence = _real_quality(tmp_path, frame)
    quality, record = _quality(evidence)
    validate_market_observations(quality, record, evidence)
    assert (
        quality["integrity_status"] != "valid"
        or quality["completion_status"] != "complete_provider_daily_rows"
        or case == "identical_duplicate"
    )


@pytest.mark.parametrize("zone", ["UTC", "UTC+08:00", "UTC-05:00"])
def test_canonical_fixed_offset_zones_are_observed_without_market_inference(tmp_path, zone):
    from datetime import timedelta, timezone

    minutes = 480 if zone == "UTC+08:00" else -300 if zone == "UTC-05:00" else 0
    frame = _frame(zone=timezone(timedelta(minutes=minutes)))
    evidence = _real_quality(tmp_path, frame)
    quality, record = _quality(evidence)
    validate_market_observations(quality, record, evidence)


@pytest.mark.parametrize("zone", ["UTC", "UTC+08:00", "UTC-05:00", "Etc/UTC"])
def test_declared_canonical_zone_uses_same_parser_as_producer(tmp_path, zone):
    frame = _frame(zone=None)
    frame.attrs["source_timezone"] = zone
    evidence = _real_quality(tmp_path, frame)
    quality, record = _quality(evidence)
    assert quality["timezone_origin"] == "provider_metadata"
    assert quality["completion_status"] == "complete_provider_daily_rows"
    validate_market_observations(quality, record, evidence)


@pytest.mark.parametrize(
    "zone", ["america/new_york", "US/Eastern", "Europe/Warsaw", "UTC-00:00", "UTC+14:01"]
)
def test_unfamiliar_aliases_or_invalid_offsets_remain_unknown(tmp_path, zone):
    frame = _frame(zone=None)
    frame.attrs["source_timezone"] = zone
    evidence = _real_quality(tmp_path, frame)
    quality, record = _quality(evidence)
    assert quality["source_timezone"] is None
    assert quality["rows"]["usable_complete"] == 0
    validate_market_observations(quality, record, evidence)


def test_boolean_duplicate_cannot_collapse_into_numeric_zero(tmp_path):
    evidence, _ = fictional_bundle(tmp_path)
    quality, record = _quality(evidence)

    def mutate(payload):
        volume = payload["columns"].index("Volume")
        payload["rows"][-1][volume] = 0
        duplicate = list(payload["rows"][-1])
        duplicate[volume] = False
        payload["rows"].append(duplicate)

    evidence = _replace_provider_data(evidence, mutate)
    quality, record = _quality(evidence)
    quality["rows"].update(received=251, in_window=251, identical_duplicates_collapsed=1)
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)


def test_large_integer_open_cannot_round_into_a_coherent_high(tmp_path):
    evidence, _ = fictional_bundle(tmp_path)

    def mutate(payload):
        columns, last = payload["columns"], payload["rows"][-1]
        last[columns.index("Open")] = 9007199254740993
        last[columns.index("High")] = 9007199254740992

    evidence = _replace_provider_data(evidence, mutate)
    quality, record = _quality(evidence)
    assert quality["integrity_status"] == "valid"
    before = deepcopy(evidence)
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)
    assert evidence == before


def test_safe_numeric_boundary_remains_supported_without_changing_payload(tmp_path):
    frame = _frame(count=1)
    for field in ("Open", "High", "Low", "Close", "Volume"):
        frame[field] = 9007199254740991
    evidence = _real_quality(tmp_path, frame)
    quality, record = _quality(evidence)
    before = deepcopy(evidence)
    validate_market_observations(quality, record, evidence)
    assert evidence == before
    assert quality["rows"]["valid"] == 1


@pytest.mark.parametrize("field", ["Open", "High", "Low", "Close", "Volume"])
def test_coherent_out_of_range_numeric_fields_cannot_prove_valid_inputs(tmp_path, field):
    evidence, _ = fictional_bundle(tmp_path)

    def mutate(payload):
        columns, last = payload["columns"], payload["rows"][-1]
        # A mathematically coherent row still exceeds supported proof range.
        for price in ("Open", "High", "Low", "Close"):
            last[columns.index(price)] = 9007199254740991
        if field in {"Open", "Close", "High"}:
            last[columns.index("High")] = 9007199254740992
        elif field == "Low":
            for price in ("Open", "High", "Close"):
                last[columns.index(price)] = 9007199254740992
        last[columns.index(field)] = 9007199254740992

    evidence = _replace_provider_data(evidence, mutate)
    quality, record = _quality(evidence)
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)


def test_unsafe_huge_conflicting_duplicates_fail_before_invalid_classification(tmp_path):
    evidence, _ = fictional_bundle(tmp_path)

    def mutate(payload):
        volume = payload["columns"].index("Volume")
        payload["rows"][-1][volume] = 9007199254740992
        duplicate = list(payload["rows"][-1])
        duplicate[volume] = 9007199254740993
        payload["rows"].append(duplicate)

    evidence = _replace_provider_data(evidence, mutate)
    quality, record = _quality(evidence)
    quality["integrity_status"] = "invalid"
    quality["rows"].update(
        received=251,
        in_window=251,
        valid=249,
        invalid=2,
        usable_complete=249,
        latest_usable_date="2026-01-07",
        conflicting_duplicate_dates=["2026-01-08"],
    )
    # Even a matching invalid diagnosis cannot rely on integer comparisons
    # whose distinction is unavailable to the cross-language f64 consumers.
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)


def test_negative_zero_timestamp_offset_cannot_become_observed_utc(tmp_path):
    evidence, _ = fictional_bundle(tmp_path)

    def mutate(payload):
        columns = payload["columns"]
        for row in payload["rows"]:
            row[columns.index("SourceTimestamp")] = (
                row[columns.index("SourceTimestamp")][:19] + "-00:00"
            )
            row[columns.index("SourceTimezone")] = "UTC"
            row[columns.index("SourceUTCOffset")] = "+00:00"

    evidence = _replace_provider_data(evidence, mutate)
    quality, record = _quality(evidence)
    quality["source_timezone"] = "UTC"
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)


def test_raw_negative_zero_source_remains_unknown_in_captured_quality(tmp_path):
    frame = _frame()
    frame["Date"] = [value.strftime("%Y-%m-%dT00:00:00-00:00") for value in frame["Date"]]
    evidence = _real_quality(tmp_path, frame)
    quality, record = _quality(evidence)
    assert quality["source_timezone"] is None
    assert quality["timezone_origin"] == "unknown"
    assert quality["rows"]["usable_complete"] == 0
    for source in record["sources"]:
        if source["provider"] != "yfinance":
            continue
        payload = json.loads(evidence["artifacts"][source["data_sha256"]]["payload"])
        columns = payload["columns"]
        assert all(
            row[columns.index("SourceTimestamp")].endswith("-00:00") for row in payload["rows"]
        )
        assert all(row[columns.index("SourceTimezone")] is None for row in payload["rows"])
        assert all(row[columns.index("TimezoneOrigin")] == "unknown" for row in payload["rows"])


def test_original_zone_completion_remains_conservative_across_dst(tmp_path):
    frame = _frame(count=2, last="2025-11-02")
    evidence = _real_quality(
        tmp_path, frame, date="2025-11-02", observed="2025-11-03T04:30:00.000000Z"
    )
    quality, record = _quality(evidence)
    assert quality["rows"]["provisional"] == 1
    validate_market_observations(quality, record, evidence)


def test_metadata_dropped_invalid_dates_cannot_add_completed_rows(tmp_path):
    frame = _frame()
    frame.attrs["invalid_timestamp_rows"] = 2
    evidence = _real_quality(tmp_path, frame)
    quality, record = _quality(evidence)
    assert quality["rows"]["invalid"] == 2
    validate_market_observations(quality, record, evidence)
    quality["rows"]["invalid"] = 0
    quality["integrity_status"] = "valid"
    # Missing rejected rows cannot be proved good simply from metadata counts.
    # The check accepts conservative excess invalidity, not new valid rows.
    quality["rows"]["valid"] += 2
    quality["rows"]["usable_complete"] += 2
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)


def test_saved_history_window_and_price_basis_bind_when_present(tmp_path):
    frame = _frame()
    frame["HistoryRequestStart"] = "2021-01-09"
    frame["HistoryRequestEnd"] = "2026-01-10"
    frame["PriceBasis"] = "auto_adjusted_ohlcv"
    frame.attrs["requested_window"] = {"start": "2021-01-09", "end": "2026-01-09"}
    evidence = _real_quality(tmp_path, frame)
    quality, record = _quality(evidence)
    validate_market_observations(quality, record, evidence)
    quality["price_basis"]["value"] = "unadjusted"
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)
    quality["price_basis"]["value"] = "auto_adjusted_ohlcv"
    quality["requested_window"]["start"] = "2020-01-09"
    with pytest.raises(ValueError, match=f"^{ERROR}$"):
        validate_market_observations(quality, record, evidence)


def test_stdlib_proof_import_does_not_require_market_libraries(tmp_path):
    import os
    from pathlib import Path
    import subprocess
    import sys

    module = Path(__file__).parents[1] / "tradingagents/research/market_inputs.py"
    script = """
import importlib.abc, importlib.util, sys
class Block(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'pandas','numpy','yfinance','stockstats','langchain','langchain_core'}:
            raise AssertionError('market dependency imported')
sys.meta_path.insert(0,Block())
spec=importlib.util.spec_from_file_location('saved_market_proof',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.source_timezone_tzinfo('UTC+08:00').utcoffset(None).total_seconds()==28800
print('stdlib proof ready')
"""
    result = subprocess.run(
        [sys.executable, "-I", "-c", script, str(module)],
        cwd=tmp_path,
        env={"PATH": os.environ.get("PATH", "")},
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0 and result.stdout == "stdlib proof ready\n"
    assert not result.stderr
