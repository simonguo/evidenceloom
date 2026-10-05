"""Actual public-source bytes, lossless observations, and bounded authority gates."""

from calendar import monthrange
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from tradingagents.evaluation.public_sources import (
    PublicSourceCorpusError,
    derive_bls_table,
    validate_corpus,
    validate_pending_review,
)

ROOT = Path(__file__).parents[1]
FIXTURE = ROOT / "tests/fixtures/public_sources/bls-cpi-2023-2024"
CLI = ROOT / "scripts/verify_public_source_corpus.py"
DIAGNOSTIC = "Invalid public-source corpus"


def corpus_inputs():
    return json.loads((FIXTURE / "manifest_v1.json").read_bytes()), (
        FIXTURE / "raw.json"
    ).read_bytes()


def pending_review():
    return json.loads((FIXTURE / "pending_review_v1.json").read_bytes())


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def value_sha(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def raw_sha(payload):
    return hashlib.sha256(payload).hexdigest()


def raw_payload(value):
    return canonical(value).encode("utf-8")


def assert_corpus_error(operation):
    with pytest.raises(PublicSourceCorpusError, match="^" + DIAGNOSTIC + "$"):
        operation()


def component(value, own_hash):
    value[own_hash] = value_sha({key: item for key, item in value.items() if key != own_hash})
    return value


def set_path(value, path, replacement):
    target = value
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = replacement


def bind_raw(manifest, payload):
    manifest["capture"]["raw_sha256"] = raw_sha(payload)
    manifest["capture"]["raw_bytes"] = len(payload)
    return component(manifest, "manifest_sha256")


def bind_request(manifest, request):
    manifest["request"]["body_utf8"] = canonical(request)
    manifest["request"]["body_sha256"] = raw_sha(manifest["request"]["body_utf8"].encode("utf-8"))
    return component(manifest, "manifest_sha256")


def test_actual_public_bls_source_derives_every_original_decimal_observation():
    manifest, payload = corpus_inputs()
    original_manifest, original_payload = deepcopy(manifest), bytes(payload)
    captured = validate_corpus(manifest, payload)
    assert captured == original_manifest
    assert manifest == original_manifest
    assert payload == original_payload
    assert value_sha(captured) == value_sha(original_manifest)

    table = derive_bls_table(payload)
    assert set(table) == {
        "schema_version",
        "kind",
        "normalization_policy",
        "source_raw_sha256",
        "rows",
        "table_sha256",
    }
    assert table["schema_version"] == 1
    assert table["kind"] == "bls_monthly_decimal_table"
    assert table["normalization_policy"] == "bls-api-monthly-decimal-string-v1"
    assert table["source_raw_sha256"] == raw_sha(payload)
    assert table["table_sha256"] == value_sha(
        {key: value for key, value in table.items() if key != "table_sha256"}
    )
    raw = json.loads(payload)
    series = raw["Results"]["series"]
    assert len(series) == 2
    assert len(table["rows"]) == 48
    witnesses, reference_periods = set(), {}
    for row in table["rows"]:
        assert set(row) == {
            "series_id",
            "source_series_index",
            "source_observation_index",
            "year",
            "period",
            "period_name",
            "reference_period",
            "period_start",
            "period_end",
            "value",
            "footnotes",
        }
        original_series = series[row["source_series_index"]]
        original = original_series["data"][row["source_observation_index"]]
        assert row["series_id"] == original_series["seriesID"]
        for key in ("year", "period", "value"):
            assert type(row[key]) is str
            assert row[key] == original[key]
        assert row["period_name"] == original["periodName"]
        assert row["footnotes"] == original["footnotes"]
        year, month = int(original["year"]), int(original["period"][1:])
        assert original["period"] == f"M{month:02d}"
        assert row["reference_period"] == f"{year:04d}-{month:02d}"
        assert row["period_start"] == f"{year:04d}-{month:02d}-01"
        assert row["period_end"] == f"{year:04d}-{month:02d}-{monthrange(year, month)[1]:02d}"
        witness = row["source_series_index"], row["source_observation_index"]
        assert witness not in witnesses
        witnesses.add(witness)
        reference_periods.setdefault(row["series_id"], set()).add(row["reference_period"])
    assert len(witnesses) == sum(len(item["data"]) for item in series) == 48
    expected_periods = {f"{year}-{month:02d}" for year in (2023, 2024) for month in range(1, 13)}
    assert all(periods == expected_periods for periods in reference_periods.values())
    assert len(reference_periods) == 2
    assert [
        (row["source_series_index"], row["source_observation_index"]) for row in table["rows"]
    ] == [
        (series_index, observation_index)
        for series_index, item in enumerate(series)
        for observation_index in range(len(item["data"]))
    ]
    assert payload == original_payload


def test_public_table_selected_known_cells_and_months_are_index_points():
    _, payload = corpus_inputs()
    rows = derive_bls_table(payload)["rows"]
    indexed = {(row["series_id"], row["year"], row["period"]): row for row in rows}
    for series_id, period, expected in [
        ("CUSR0000SA0", "M12", "308.741"),
        ("CUSR0000SA0", "M11", "308.148"),
        ("CUUR0000SA0", "M12", "306.746"),
        ("CUUR0000SA0", "M11", "307.051"),
    ]:
        assert indexed[series_id, "2023", period]["value"] == expected
    assert indexed["CUSR0000SA0", "2024", "M02"]["period_end"] == "2024-02-29"
    assert indexed["CUUR0000SA0", "2023", "M02"]["period_end"] == "2023-02-28"
    assert all("Date" not in row and "Close" not in row for row in rows)


def test_corpus_and_pending_return_independent_copies_without_rewriting_any_input():
    manifest, payload = corpus_inputs()
    pending = pending_review()
    original_manifest, original_pending = deepcopy(manifest), deepcopy(pending)
    captured = validate_corpus(manifest, payload)
    captured_pending = validate_pending_review(pending, manifest, payload)
    captured["series"][0]["subject"]["item_name"] = "Changed returned copy"
    captured_pending["expert_review"]["instructions"].append("Changed returned copy")
    assert manifest == original_manifest
    assert pending == original_pending


@pytest.mark.parametrize("key", ["status", "seriesID", "value", "year"])
def test_duplicate_raw_json_keys_never_establish_observation_authority(key):
    _, payload = corpus_inputs()
    raw = json.loads(payload)
    if key == "status":
        value = raw["status"]
    elif key == "seriesID":
        value = raw["Results"]["series"][0][key]
    else:
        value = raw["Results"]["series"][0]["data"][0][key]
    literal = json.dumps(key) + ":" + json.dumps(value)
    malformed = canonical(raw).replace(literal, literal + "," + literal, 1).encode()
    assert malformed != raw_payload(raw)
    assert_corpus_error(lambda: derive_bls_table(malformed))


@pytest.mark.parametrize("value", [None, True, 1.5, "NaN", "Infinity", "1,000.0", "not-a-number"])
def test_source_observation_requires_original_supported_decimal_string(value):
    _, payload = corpus_inputs()
    raw = json.loads(payload)
    raw["Results"]["series"][0]["data"][0]["value"] = value
    assert_corpus_error(lambda: derive_bls_table(raw_payload(raw)))


@pytest.mark.parametrize("period", ["M00", "M13", "M1", "Q01", "M99", None, 1])
def test_nonmonthly_or_malformed_period_never_becomes_monthly_row(period):
    _, payload = corpus_inputs()
    raw = json.loads(payload)
    raw["Results"]["series"][0]["data"][0]["period"] = period
    assert_corpus_error(lambda: derive_bls_table(raw_payload(raw)))


@pytest.mark.parametrize("year", [None, 2023, True, "23", "2023.0", "0000"])
def test_malformed_source_year_cannot_supply_reference_period(year):
    _, payload = corpus_inputs()
    raw = json.loads(payload)
    raw["Results"]["series"][0]["data"][0]["year"] = year
    assert_corpus_error(lambda: derive_bls_table(raw_payload(raw)))


def test_duplicate_series_and_month_rows_fail_closed():
    _, payload = corpus_inputs()
    raw = json.loads(payload)
    duplicate_series = deepcopy(raw)
    duplicate_series["Results"]["series"].append(deepcopy(raw["Results"]["series"][0]))
    assert_corpus_error(lambda: derive_bls_table(raw_payload(duplicate_series)))
    duplicate_row = deepcopy(raw)
    duplicate_row["Results"]["series"][0]["data"].append(
        deepcopy(raw["Results"]["series"][0]["data"][0])
    )
    assert_corpus_error(lambda: derive_bls_table(raw_payload(duplicate_row)))


def test_failed_provider_response_is_not_an_empty_valid_corpus():
    _, payload = corpus_inputs()
    raw = json.loads(payload)
    raw["status"] = "REQUEST_FAILED"
    assert_corpus_error(lambda: derive_bls_table(raw_payload(raw)))


@pytest.mark.parametrize(
    "path,replacement",
    [
        (("provider",), "yfinance"),
        (("dataset",), "stock_price"),
        (("normalization_policy",), "daily-stock-price-v1"),
        (("request", "source_url"), "https://example.com/publicAPI/v1/timeseries/data/"),
        (("request", "method"), "GET"),
        (("request", "body_sha256"), "a" * 64),
        (("capture", "raw_sha256"), "a" * 64),
        (("capture", "raw_bytes"), 4394),
        (("capture", "http_status"), True),
        (("capture", "http_status"), 403),
        (("capture", "api_status"), "REQUEST_FAILED"),
        (("snapshot", "kind"), "historical_archive"),
        (("snapshot", "historical_vintage"), "verified"),
        (("snapshot", "publication_time"), "2024-01-11T13:30:00.000000Z"),
        (("snapshot", "first_public_availability"), "2024-01-11T13:30:00.000000Z"),
        (("snapshot", "first_public_availability_status"), "verified"),
        (("series", 0, "series_id"), "CUUR0000SA0"),
        (("series", 0, "subject", "area_code"), "1234"),
        (("series", 0, "subject", "item_name"), "All items less food and energy"),
        (("series", 0, "frequency"), "daily"),
        (("series", 0, "units", "kind"), "USD"),
        (("series", 0, "units", "base"), "2020=100"),
        (("series", 0, "adjustment"), "not_seasonally_adjusted"),
        (("series", 1, "adjustment"), "seasonally_adjusted"),
        (("series", 0, "metadata_basis", "status"), "independently_verified"),
        (("series", 0, "observed_coverage", "start"), "2023-02"),
        (("series", 0, "observed_coverage", "end"), "2024-11"),
        (("series", 0, "observed_coverage", "observation_count"), 23),
        (("rights", "status"), "legal_attestation"),
        (("rights", "scope"), "all_assets_and_agency_endorsement"),
        (("rights", "attribution"), "Source: Other provider"),
        (("rights", "retrieval_date"), "2026-10-03"),
        (("rights", "checked_date"), "2026-10-03"),
        (("historical_references", 0, "raw_sha256"), "a" * 64),
        (("historical_references", 0, "raw_bytes"), 100),
        (("historical_references", 0, "support_status"), "verified_numeric_authority"),
        (("historical_references", 0, "acquisition_status"), "raw_saved"),
        (("historical_references", 0, "units"), "index_points"),
        (("historical_references", 0, "reference_id"), "bls-cpi-release-20240213"),
        (("acquisition_failure", "http_status"), 200),
        (("acquisition_failure", "result"), "bypassed_capture_success"),
    ],
)
def test_coherently_rehashed_manifest_conflicts_do_not_become_source_or_historical_authority(
    path, replacement
):
    manifest, payload = corpus_inputs()
    set_path(manifest, path, replacement)
    component(manifest, "manifest_sha256")
    original = deepcopy(manifest)
    assert_corpus_error(lambda: validate_corpus(manifest, payload))
    assert manifest == original


@pytest.mark.parametrize(
    "started,completed",
    [
        ("2026-10-04T09:51:32.000000Z", "2026-10-04T09:51:31.000000Z"),
        ("2026-10-04T09:51:29", "2026-10-04T09:51:31.000000Z"),
        ("2026-10-04T09:51:29.000000+08:00", "2026-10-04T09:51:31.000000+08:00"),
        ("2022-10-04T09:51:29.000000Z", "2022-10-04T09:51:31.000000Z"),
    ],
)
def test_request_capture_chronology_cannot_place_requested_data_in_the_future(started, completed):
    manifest, payload = corpus_inputs()
    manifest["capture"].update(retrieval_started_at=started, retrieval_completed_at=completed)
    manifest["rights"].update(retrieval_date=completed[:10], checked_date=completed[:10])
    component(manifest, "manifest_sha256")
    assert_corpus_error(lambda: validate_corpus(manifest, payload))


@pytest.mark.parametrize(
    "field,value",
    [
        ("seriesid", ["CUSR0000SA0", "CUSR0000SA0"]),
        ("seriesid", ["CUSR0000SA0", "UNKNOWN_SERIES"]),
        ("seriesid", ["CUSR0000SA0"]),
        ("startyear", "2024"),
        ("startyear", "2025"),
        ("endyear", "2023"),
        ("endyear", "2025"),
        ("endyear", 2024),
    ],
)
def test_coherently_rehashed_request_still_requires_complete_exact_requested_coverage(field, value):
    manifest, payload = corpus_inputs()
    body = json.loads(manifest["request"]["body_utf8"])
    body[field] = value
    bind_request(manifest, body)
    assert_corpus_error(lambda: validate_corpus(manifest, payload))


def test_duplicate_request_json_keys_rejected_even_with_matching_literal_and_manifest_hash():
    manifest, payload = corpus_inputs()
    body = json.loads(manifest["request"]["body_utf8"])
    literal = '"startyear":"2023"'
    request = canonical(body).replace(literal, literal + "," + literal, 1)
    assert request != canonical(body)
    manifest["request"]["body_utf8"] = request
    manifest["request"]["body_sha256"] = raw_sha(request.encode())
    component(manifest, "manifest_sha256")
    assert_corpus_error(lambda: validate_corpus(manifest, payload))


@pytest.mark.parametrize("missing", ["observation", "series"])
def test_missing_month_or_series_rejected_after_all_capture_hashes_are_rebound(missing):
    manifest, payload = corpus_inputs()
    raw = json.loads(payload)
    if missing == "observation":
        raw["Results"]["series"][0]["data"].pop()
        manifest["series"][0]["observed_coverage"]["observation_count"] -= 1
    else:
        raw["Results"]["series"].pop()
    changed = raw_payload(raw)
    bind_raw(manifest, changed)
    assert_corpus_error(lambda: validate_corpus(manifest, changed))


def test_original_raw_byte_identity_is_distinct_from_semantically_equal_json():
    manifest, payload = corpus_inputs()
    changed = payload + b"\n"
    assert json.loads(changed) == json.loads(payload)
    original_table, changed_table = derive_bls_table(payload), derive_bls_table(changed)
    assert original_table["rows"] == changed_table["rows"]
    assert original_table["source_raw_sha256"] != changed_table["source_raw_sha256"]
    assert original_table["table_sha256"] != changed_table["table_sha256"]
    assert_corpus_error(lambda: validate_corpus(manifest, changed))
    bind_raw(manifest, changed)
    assert validate_corpus(manifest, changed) == manifest
    assert manifest["snapshot"]["historical_vintage"] == "unknown"
    assert manifest["snapshot"]["first_public_availability"] is None


def test_coherent_supplied_cell_edit_is_internal_consistency_and_never_expert_or_vintage_approval():
    manifest, payload = corpus_inputs()
    raw = json.loads(payload)
    raw["Results"]["series"][0]["data"][12]["value"] = "999.123"
    changed = raw_payload(raw)
    bind_raw(manifest, changed)
    captured = validate_corpus(manifest, changed)
    assert captured == manifest
    table = derive_bls_table(changed)
    assert table["rows"][12]["value"] == "999.123"
    assert captured["snapshot"]["publication_time"] is None
    assert captured["snapshot"]["historical_vintage"] == "unknown"
    # Original inspection labels are bound to their own manifest and raw bytes.
    assert_corpus_error(lambda: validate_pending_review(pending_review(), manifest, changed))


def test_historical_raw_missing_never_becomes_positive_numeric_authority():
    manifest, payload = corpus_inputs()
    captured = validate_corpus(manifest, payload)
    assert [entry["reported_value"] for entry in captured["historical_references"]] == [
        "0.3",
        "0.2",
    ]
    for entry in captured["historical_references"]:
        assert entry["raw_sha256"] is None
        assert entry["raw_bytes"] is None
        assert entry["support_status"] == "reference_metadata_only_no_numeric_authority"
    assert captured["snapshot"] == {
        "kind": "current_api_snapshot",
        "publication_time": None,
        "historical_vintage": "unknown",
        "first_public_availability": None,
        "first_public_availability_status": "unknown",
    }
    assert captured["acquisition_failure"]["http_status"] == 403
    assert captured["acquisition_failure"]["result"] == "automatic_capture_unavailable_no_bypass"


def test_pending_review_binds_real_cells_and_zero_approved_expert_denominator():
    manifest, payload = corpus_inputs()
    pending = pending_review()
    original = deepcopy(pending)
    captured = validate_pending_review(pending, manifest, payload)
    assert captured == original and pending == original
    assert captured["pending_review_sha256"] == value_sha(
        {key: value for key, value in captured.items() if key != "pending_review_sha256"}
    )
    expectations, expert = captured["engineering_expectations"], captured["expert_review"]
    assert expectations["provenance"] == "engineering"
    assert expectations["series_count"] == 2 and expectations["observation_count"] == 48
    assert expectations["historical_positive_numeric_case_count"] == 0
    assert expert["status"] == "PENDING"
    assert expert["reviewer"] is None and expert["reviewed_at"] is None
    assert expert["approved_claim_denominator"] == 0 and expert["labels"] == []
    assert expert["dimensions"] == {
        name: "PENDING"
        for name in (
            "semantic_support",
            "temporal_validity",
            "inference_classification",
            "abstention_appropriateness",
        )
    }
    raw = json.loads(payload)
    for cell in expectations["selected_cells"]:
        series = raw["Results"]["series"][cell["series_index"]]
        observation = series["data"][cell["observation_index"]]
        assert cell["series_id"] == series["seriesID"]
        assert all(cell[key] == observation[key] for key in ("year", "period", "value"))


@pytest.mark.parametrize(
    "path,replacement",
    [
        (("corpus_id",), "another-corpus"),
        (("manifest_sha256",), "a" * 64),
        (("raw_sha256",), "a" * 64),
        (("engineering_expectations", "provenance"), "independent_expert"),
        (("engineering_expectations", "observation_count"), 4),
        (("engineering_expectations", "values_remain_decimal_strings"), 1),
        (("engineering_expectations", "historical_positive_numeric_case_count"), 2),
        (("engineering_expectations", "historical_vintage"), "verified"),
        (("engineering_expectations", "selected_cells", 0, "value"), "0.3"),
        (("engineering_expectations", "selected_cells", 0, "value"), 308.741),
        (("engineering_expectations", "selected_cells", 0, "series_id"), "CUUR0000SA0"),
        (("engineering_expectations", "selected_cells", 0, "period"), "M11"),
        (("engineering_expectations", "selected_cells", 0, "observation_index"), 13),
        (("engineering_expectations", "selected_cells", 0, "series_index"), True),
        (("expert_review", "status"), "APPROVED"),
        (("expert_review", "reviewer"), "invented-reviewer"),
        (("expert_review", "reviewed_at"), "2026-10-04T12:00:00.000000Z"),
        (("expert_review", "approved_claim_denominator"), 48),
        (("expert_review", "approved_claim_denominator"), False),
        (("expert_review", "dimensions", "semantic_support"), "VERIFIED"),
        (("expert_review", "dimensions", "temporal_validity"), "VERIFIED"),
        (("expert_review", "dimensions", "inference_classification"), "VERIFIED"),
        (("expert_review", "dimensions", "abstention_appropriateness"), "VERIFIED"),
        (("expert_review", "labels"), [{"status": "MATCH"}]),
    ],
)
def test_coherently_rehashed_pending_review_cannot_invent_labels_or_approved_authority(
    path, replacement
):
    manifest, payload = corpus_inputs()
    pending = pending_review()
    set_path(pending, path, replacement)
    component(pending, "pending_review_sha256")
    before = deepcopy(pending)
    assert_corpus_error(lambda: validate_pending_review(pending, manifest, payload))
    assert pending == before


def test_duplicate_pending_selected_witness_rejected_but_empty_unfilled_selection_stays_pending():
    manifest, payload = corpus_inputs()
    pending = pending_review()
    selected = pending["engineering_expectations"]["selected_cells"]
    selected.append(deepcopy(selected[0]))
    component(pending, "pending_review_sha256")
    assert_corpus_error(lambda: validate_pending_review(pending, manifest, payload))
    pending["engineering_expectations"]["selected_cells"] = []
    component(pending, "pending_review_sha256")
    captured = validate_pending_review(pending, manifest, payload)
    assert captured == pending
    assert captured["expert_review"]["approved_claim_denominator"] == 0


@pytest.mark.parametrize(
    "payload",
    [b"", b"[", b"NaN", b" " * (8 * 1024 * 1024 + 1), "{}", bytearray(b"{}")],
    ids=[
        "empty",
        "incomplete-json",
        "nonfinite-json",
        "oversize-bytes",
        "string-type",
        "bytearray-type",
    ],
)
def test_raw_input_type_size_or_nonfinite_parse_failure_has_fixed_diagnostic(payload):
    assert_corpus_error(lambda: derive_bls_table(payload))


def isolated_environment():
    return {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR") if key in os.environ}


def run_source_cli(directory, manifest_path, raw_path, review_path=None, *, guarded=False):
    arguments = [str(CLI), str(manifest_path), str(raw_path)]
    if review_path is not None:
        arguments += ["--review-package", str(review_path)]
    if guarded:
        hook = r"""
import builtins, io, os, runpy, socket, sys
blocked = {"requests", "httpx", "dotenv", "numpy", "pandas", "yfinance", "akshare", "openai", "anthropic", "langchain", "langchain_core", "langchain_openai", "langchain_anthropic", "langchain_google_genai", "langgraph", "torch", "chromadb", "google"}
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name.split(".")[0] in blocked:
        raise RuntimeError("Forbidden runtime or configuration import")
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
def no_network(*args, **kwargs):
    raise RuntimeError("Forbidden network operation")
socket.getaddrinfo = no_network
socket.create_connection = no_network
socket.socket.connect = no_network
socket.socket.connect_ex = no_network
socket.socket.sendto = no_network
for namespace in (builtins, io):
    original_open = namespace.open
    def guarded_open(path, *args, _original=original_open, **kwargs):
        if isinstance(path, (str, bytes, os.PathLike)):
            parts = os.fsdecode(path).replace("\\", "/").split("/")
            if any(part.startswith(".env") or part in {"profiles", "credentials", "credentials.json"} for part in parts):
                raise RuntimeError("Forbidden configuration read")
        return _original(path, *args, **kwargs)
    namespace.open = guarded_open
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""
        command = [sys.executable, "-B", "-I", "-c", hook, *arguments]
    else:
        command = [sys.executable, "-B", "-I", *arguments]
    return subprocess.run(
        command,
        cwd=directory,
        env=isolated_environment(),
        capture_output=True,
        text=True,
        timeout=60,
    )


def copied_cli_inputs(directory):
    paths = [directory / name for name in ("manifest.json", "raw.json", "pending.json")]
    for path, source_name in zip(paths, ("manifest_v1.json", "raw.json", "pending_review_v1.json")):
        path.write_bytes((FIXTURE / source_name).read_bytes())
    return paths


@pytest.mark.parametrize("with_review", [False, True])
def test_readonly_public_cli_has_precise_safe_summary_and_no_runtime_or_configuration_access(
    tmp_path, with_review
):
    manifest_path, raw_path, review_path = copied_cli_inputs(tmp_path)
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    completed = run_source_cli(
        tmp_path, manifest_path, raw_path, review_path if with_review else None, guarded=True
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert completed.stderr == ""
    summary = json.loads(completed.stdout)
    manifest, payload = corpus_inputs()
    assert summary == {
        "corpus_id": manifest["corpus_id"],
        "manifest_sha256": manifest["manifest_sha256"],
        "raw_sha256": raw_sha(payload),
        "table_sha256": derive_bls_table(payload)["table_sha256"],
        "series_count": 2,
        "observation_count": 48,
        "historical_authority": "UNAVAILABLE",
        "expert": "NOT_EVALUATED",
    }
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before


@pytest.mark.parametrize(
    "failure",
    ["manifest_hash", "raw_missing", "review_approved", "duplicate_json", "fake_credential"],
)
def test_invalid_public_cli_emits_fixed_diagnostic_without_input_leak_or_new_files(
    tmp_path, failure
):
    manifest_path, raw_path, review_path = copied_cli_inputs(tmp_path)
    manifest, payload = corpus_inputs()
    canary = "owned-public-source-fake-credential-value"
    if failure == "manifest_hash":
        manifest["manifest_sha256"] = "a" * 64
        manifest_path.write_text(canonical(manifest), encoding="utf-8")
    elif failure == "raw_missing":
        raw_path = tmp_path / "must-not-exist.json"
    elif failure == "review_approved":
        pending = pending_review()
        pending["expert_review"]["status"] = "APPROVED"
        pending["expert_review"]["approved_claim_denominator"] = 48
        component(pending, "pending_review_sha256")
        review_path.write_text(canonical(pending), encoding="utf-8")
    elif failure == "duplicate_json":
        serialized = canonical(manifest)
        literal = '"schema_version":1'
        manifest_path.write_text(
            serialized.replace(literal, literal + "," + literal, 1), encoding="utf-8"
        )
    else:
        manifest["corpus_id"] = "api_key=" + canary
        component(manifest, "manifest_sha256")
        manifest_path.write_text(canonical(manifest), encoding="utf-8")
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    completed = run_source_cli(tmp_path, manifest_path, raw_path, review_path, guarded=True)
    assert completed.returncode == 1
    assert completed.stdout == ""
    assert completed.stderr == DIAGNOSTIC + "\n"
    assert canary not in completed.stdout + completed.stderr
    assert str(manifest_path) not in completed.stdout + completed.stderr
    assert str(raw_path) not in completed.stdout + completed.stderr
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before
    assert payload == (FIXTURE / "raw.json").read_bytes()


def test_complete_public_api_is_independent_of_available_nonenglish_time_locale(tmp_path):
    hook = r"""
import builtins, calendar, json, locale, os, socket, sys
from pathlib import Path
blocked = {"requests", "httpx", "dotenv", "numpy", "pandas", "yfinance", "akshare", "openai", "anthropic", "langchain", "langchain_core", "langgraph", "torch", "chromadb", "google"}
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name.split(".")[0] in blocked:
        raise RuntimeError("Forbidden runtime or configuration import")
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
def no_network(*args, **kwargs):
    raise RuntimeError("Forbidden network operation")
socket.create_connection = no_network
socket.socket.connect = no_network
os.environ["EVIDENCELOOM_BOOTSTRAP_ONLY"] = "1"
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
from tradingagents.evaluation.public_sources import derive_bls_table, validate_corpus, validate_pending_review
fixture = root / "tests/fixtures/public_sources/bls-cpi-2023-2024"
manifest = json.loads((fixture / "manifest_v1.json").read_bytes())
pending = json.loads((fixture / "pending_review_v1.json").read_bytes())
payload = (fixture / "raw.json").read_bytes()
expected = derive_bls_table(payload)
for candidate in ("fr_FR.UTF-8", "fr_FR", "de_DE.UTF-8", "de_DE", "zh_CN.UTF-8", "Chinese_China.936", "French_France.1252", "French_France"):
    try:
        selected = locale.setlocale(locale.LC_TIME, candidate)
    except locale.Error:
        continue
    if calendar.month_name[1] == "January":
        continue
    captured = validate_corpus(manifest, payload)
    assert captured == manifest
    assert derive_bls_table(payload) == expected
    assert validate_pending_review(pending, manifest, payload) == pending
    print(json.dumps({"status": "PASSED", "locale": selected, "localized_january": calendar.month_name[1], "table_sha256": expected["table_sha256"]}))
    break
else:
    print(json.dumps({"status": "UNAVAILABLE"}))
"""
    completed = subprocess.run(
        [sys.executable, "-B", "-I", "-c", hook, str(ROOT)],
        cwd=tmp_path,
        env=isolated_environment(),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    observed = json.loads(completed.stdout)
    if observed["status"] == "UNAVAILABLE":
        pytest.skip("Host exposes no usable non-English LC_TIME locale")
    assert observed["status"] == "PASSED"
    assert observed["localized_january"] != "January"
    assert observed["table_sha256"] == derive_bls_table(corpus_inputs()[1])["table_sha256"]


@pytest.mark.parametrize(
    "field,replacement",
    [
        ("reported_publication_utc", "1980-01-01T00:00:00.000000Z"),
        ("reported_publication_utc", "2024-02-13T13:30:00.000000Z"),
        ("reported_publication_literal", "8:30 a.m. (ET) Thursday, January 11, 1980"),
        ("reference_period", "2099-12"),
        ("release_id", "USDL-80-0019"),
        ("reported_value", "999.9"),
    ],
)
def test_coherent_historical_reference_metadata_contradiction_still_rejected(field, replacement):
    manifest, payload = corpus_inputs()
    manifest["historical_references"][0][field] = replacement
    component(manifest, "manifest_sha256")
    assert_corpus_error(lambda: validate_corpus(manifest, payload))
    assert all(entry["raw_sha256"] is None for entry in manifest["historical_references"])


@pytest.mark.parametrize(
    "failure", ["unknown_option", "missing_raw", "missing_review_option_value"]
)
def test_argument_parser_failures_do_not_echo_opaque_paths_or_invocation_values(tmp_path, failure):
    manifest_path, raw_path, _ = copied_cli_inputs(tmp_path)
    canary = "owned-argument-diagnostic-canary"
    opaque_path = "/Users/fictional-owner/" + canary + "/private-source-input.json"
    if failure == "unknown_option":
        arguments = [str(manifest_path), str(raw_path), "--unknown-private-option", opaque_path]
    elif failure == "missing_raw":
        arguments = [opaque_path]
    else:
        arguments = [opaque_path, str(raw_path), "--review-package"]
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    completed = subprocess.run(
        [sys.executable, "-B", "-I", str(CLI), *arguments],
        cwd=tmp_path,
        env=isolated_environment(),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 1
    assert completed.stdout == ""
    assert completed.stderr == DIAGNOSTIC + "\n"
    assert canary not in completed.stdout + completed.stderr
    assert opaque_path not in completed.stdout + completed.stderr
    assert {path.name: path.read_bytes() for path in tmp_path.iterdir()} == before
