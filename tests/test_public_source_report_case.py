"""Independent report owners, original BLS literals, and offline CLI boundaries."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from tradingagents.evaluation.public_source_reports import (
    EXPERT,
    MAX_CASE_BYTES,
    MAX_REPORT_BYTES,
    MAX_SOURCE_BYTES,
    PublicSourceReportError,
    evaluate_report_case,
    validate_report_case,
    validate_report_case_result,
)
from tradingagents.memory.schema import canonical_json, make_component

ROOT = Path(__file__).parents[1]
SOURCE = ROOT / "tests/fixtures/public_sources/bls-cpi-2023-2024"
FIXTURE = ROOT / "tests/fixtures/public_source_reports/bls-current-snapshot"
CLI = ROOT / "scripts/verify_public_source_report_case.py"
DIAGNOSTIC = "Invalid public-source report case"


def inputs():
    return (
        json.loads((FIXTURE / "case_v1.json").read_bytes()),
        (FIXTURE / "report_v1.json").read_bytes(),
        json.loads((SOURCE / "manifest_v1.json").read_bytes()),
        (SOURCE / "raw.json").read_bytes(),
    )


def rehash(case):
    for claim in case["claims"]:
        claim.update(make_component(claim, "claim_sha256"))
    case.update(make_component(case, "case_sha256"))


def report_payload(report):
    report.update(make_component(report, "report_sha256"))
    return (json.dumps(report, ensure_ascii=False, indent=2) + "\n").replace("\n", "\r\n").encode()


def bind_report(case, report, payload):
    ref = {
        "report_id": report["report_id"],
        "version_id": report["version_id"],
        "report_raw_utf8_sha256": hashlib.sha256(payload).hexdigest(),
        "report_sha256": report["report_sha256"],
        "full_text_utf8_sha256": hashlib.sha256(report["full_text"].encode()).hexdigest(),
    }
    case["report_ref"] = ref
    for claim in case["claims"]:
        claim["report_target"] = deepcopy(ref)
    rehash(case)


def error(operation):
    with pytest.raises(PublicSourceReportError, match="^" + DIAGNOSTIC + "$"):
        operation()


def wrong_number_inputs():
    case, payload, manifest, raw = inputs()
    report = json.loads(payload)
    old = case["claims"][0]["span"]["text"]
    assert old == "308.148"
    report["full_text"] = report["full_text"].replace(old, "308.149", 1)
    report["version_id"] = "c8517c70-ce6d-45f1-b9d4-b5fcfeafc005"
    report["version_number"] += 1
    case["claims"][0]["span"]["text"] = "308.149"
    changed_payload = report_payload(report)
    bind_report(case, report, changed_payload)
    return case, changed_payload, manifest, raw


def test_complete_report_preserves_all_bytes_and_submitted_denominator_without_expert_approval():
    values = inputs()
    before = deepcopy(values)
    case, payload, manifest, raw = values
    assert b"\r\n" in payload
    report = json.loads(payload)
    assert "🧾" in report["full_text"] and "\r\n" in report["full_text"]
    assert report["authorship"]["author_identity"] is None
    assert report["authorship"]["production_run_id"] is None
    assert report["authorship"]["external_research_model_run_id"] is None
    assert validate_report_case(*values) == case
    result = evaluate_report_case(*values)
    assert values == before
    assert result["counts"] == {"submitted": 4, "match": 4, "mismatch": 0}
    assert [c["claim_id"] for c in result["claims"]] == [c["claim_id"] for c in case["claims"]]
    assert [c["source_literal"] for c in result["claims"]] == [
        "308.148",
        "308.741",
        "307.051",
        "306.746",
    ]
    assert result["report_ref"]["report_raw_utf8_sha256"] == hashlib.sha256(payload).hexdigest()
    assert result["source_ref"]["raw_sha256"] == hashlib.sha256(raw).hexdigest()
    assert result["observation_count"] == 48 and result["series_count"] == 2
    assert result["expert_review"] == EXPERT
    assert result["semantic_support"] == "NOT_EVALUATED"
    assert result["metadata_authority"] == "manifest_declarations_only"
    assert result["authority"] == report["authority"]
    assert result["historical_authority"] == "UNAVAILABLE"
    assert validate_report_case_result(result, *values) == result
    assert manifest["snapshot"]["historical_vintage"] == "unknown"


def test_legitimate_new_report_version_with_wrong_number_is_a_mismatch_not_invalid_input():
    values = wrong_number_inputs()
    assert validate_report_case(*values) == values[0]
    result = evaluate_report_case(*values)
    assert result["counts"] == {"submitted": 4, "match": 3, "mismatch": 1}
    assert result["claims"][0]["status"] == "MISMATCH"
    assert result["claims"][0]["reported_literal"] == "308.149"
    assert result["claims"][0]["source_literal"] == "308.148"
    assert result["expert_review"]["approved_claim_denominator"] == 0


@pytest.mark.parametrize(
    "field",
    ["report_id", "version_id", "report_raw_utf8_sha256", "report_sha256", "full_text_utf8_sha256"],
)
def test_coherently_rehashed_case_cannot_replace_its_independent_report_owner(field):
    case, payload, manifest, raw = inputs()
    replacement = "54e58aa2-8c64-4573-91bf-076478a84959" if field.endswith("id") else "a" * 64
    case["report_ref"][field] = replacement
    for claim in case["claims"]:
        claim["report_target"][field] = replacement
    rehash(case)
    error(lambda: evaluate_report_case(case, payload, manifest, raw))


@pytest.mark.parametrize("field", ["corpus_id", "manifest_sha256", "raw_sha256", "table_sha256"])
def test_coherently_rehashed_case_cannot_replace_its_independent_source_owner(field):
    case, payload, manifest, raw = inputs()
    replacement = "unrelated-corpus" if field == "corpus_id" else "a" * 64
    case["source_ref"][field] = replacement
    for claim in case["claims"]:
        claim["source_target"][field] = replacement
    rehash(case)
    error(lambda: evaluate_report_case(case, payload, manifest, raw))


@pytest.mark.parametrize(
    "field,value",
    [
        ("series_id", "CUUR0000SA0"),
        ("year", "2024"),
        ("period", "M12"),
        ("reference_period", "2023-12"),
        ("source_series_index", 1),
        ("source_observation_index", 12),
        ("source_series_index", True),
        ("value", "308.149"),
        ("units", {"kind": "percent", "base": "1982-84=100"}),
        ("units", {"kind": "USD", "base": "1982-84=100"}),
        ("adjustment", "not_seasonally_adjusted"),
        ("metadata_status", "provider_verified"),
    ],
)
def test_coherently_rehashed_wrong_cell_or_declared_metadata_is_rejected(field, value):
    case, payload, manifest, raw = inputs()
    case["claims"][0]["cell"][field] = value
    rehash(case)
    error(lambda: evaluate_report_case(case, payload, manifest, raw))


@pytest.mark.parametrize(
    "failure",
    [
        "char_offsets",
        "inside_unicode",
        "wrong_text",
        "partial_number",
        "wrong_context",
        "duplicate_span",
        "duplicate_claim",
        "extra_key",
    ],
)
def test_span_or_selection_impersonation_fails_even_after_component_rehash(failure):
    case, payload, manifest, raw = inputs()
    claim = case["claims"][0]
    section = json.loads(payload)["full_text"]
    if failure == "char_offsets":
        claim["span"]["start_byte"] = section.index(claim["span"]["text"])
        claim["span"]["end_byte"] = claim["span"]["start_byte"] + len(claim["span"]["text"])
    elif failure == "inside_unicode":
        offset = section.encode().index("🧾".encode()) + 1
        claim["span"] = {"start_byte": offset, "end_byte": offset + 1, "text": "3"}
    elif failure == "wrong_text":
        claim["span"]["text"] = "308.149"
    elif failure == "partial_number":
        claim["span"]["end_byte"] -= 4
        claim["span"]["text"] = "308"
    elif failure == "wrong_context":
        claim["context_spans"]["series_id"] = deepcopy(
            case["claims"][2]["context_spans"]["series_id"]
        )
    elif failure == "duplicate_span":
        case["claims"][1] = deepcopy(claim)
        case["claims"][1]["claim_id"] = "distinct-id-same-selection"
    elif failure == "duplicate_claim":
        case["claims"][1]["claim_id"] = claim["claim_id"]
    else:
        claim["unexpected"] = "value"
    rehash(case)
    error(lambda: evaluate_report_case(case, payload, manifest, raw))


def test_unicode_prefix_edit_and_legitimate_rebinding_preserve_original_byte_spans():
    case, payload, manifest, raw = inputs()
    report = json.loads(payload)
    prefix = "新增说明 🧾：仅作工程比较。\r\n"
    report["full_text"] = prefix + report["full_text"]
    report["version_id"] = "34da97b0-e869-4258-ac7c-0dd5b892abfe"
    report["version_number"] += 1
    delta = len(prefix.encode())
    assert delta != len(prefix)
    for claim in case["claims"]:
        for span in [claim["span"], *claim["context_spans"].values()]:
            span["start_byte"] += delta
            span["end_byte"] += delta
    payload = report_payload(report)
    bind_report(case, report, payload)
    result = evaluate_report_case(case, payload, manifest, raw)
    assert result["counts"]["match"] == 4
    assert result["semantic_support"] == "NOT_EVALUATED"


@pytest.mark.parametrize(
    "field,value",
    [
        ("provider_origin", "AUTHENTICATED"),
        ("historical_vintage", "2023_original"),
        ("publication_time", "2024-01-11T13:30:00Z"),
        ("first_public_availability", "2024-01-11T13:30:00Z"),
        ("first_public_availability_status", "known"),
    ],
)
def test_new_report_cannot_invent_source_or_historical_authority(field, value):
    case, payload, manifest, raw = inputs()
    report = json.loads(payload)
    report["authority"][field] = value
    payload = report_payload(report)
    bind_report(case, report, payload)
    error(lambda: evaluate_report_case(case, payload, manifest, raw))


@pytest.mark.parametrize(
    "failure",
    [
        "author",
        "production_run",
        "model_run",
        "expert_reviewer",
        "expert_count",
        "expert_bool",
        "expert_dimension",
    ],
)
def test_new_report_cannot_invent_author_research_run_or_expert_review(failure):
    case, payload, manifest, raw = inputs()
    report = json.loads(payload)
    authorship = report["authorship"]
    expert = report["expert_review"]
    if failure == "author":
        authorship["author_identity"] = "unproven-human"
    elif failure == "production_run":
        authorship["production_run_id"] = "54e58aa2-8c64-4573-91bf-076478a84959"
    elif failure == "model_run":
        authorship["external_research_model_run_id"] = "54e58aa2-8c64-4573-91bf-076478a84959"
    elif failure == "expert_reviewer":
        expert["reviewer"] = "unproven-expert"
    elif failure == "expert_count":
        expert["approved_claim_denominator"] = 4
    elif failure == "expert_bool":
        expert["approved_claim_denominator"] = False
    else:
        expert["dimensions"]["semantic_support"] = "APPROVED"
    payload = report_payload(report)
    bind_report(case, report, payload)
    error(lambda: evaluate_report_case(case, payload, manifest, raw))


def test_rehashed_result_cannot_replace_literal_mismatch_or_expert_denominator():
    values = wrong_number_inputs()
    result = evaluate_report_case(*values)
    result["claims"][0]["status"] = "MATCH"
    result["counts"] = {"submitted": 4, "match": 4, "mismatch": 0}
    result.update(make_component(result, "result_sha256"))
    error(lambda: validate_report_case_result(result, *values))


GUARD = r"""
import builtins, io, os, runpy, socket, sys
blocked = {"requests", "httpx", "dotenv", "numpy", "pandas", "yfinance", "akshare", "openai", "anthropic", "langchain", "langchain_core", "langchain_openai", "langchain_anthropic", "langchain_google_genai", "langgraph", "torch", "chromadb", "google"}
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name.split(".")[0] in blocked:
        raise RuntimeError("Forbidden runtime import")
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
    def guarded_open(path, mode="r", *args, _original=original_open, **kwargs):
        if any(c in mode for c in "wax+"):
            raise RuntimeError("Forbidden file write")
        if isinstance(path, (str, bytes, os.PathLike)):
            parts = os.fsdecode(path).replace("\\", "/").split("/")
            if any(part.startswith(".env") or part in {"profiles", "credentials", "credentials.json"} for part in parts):
                raise RuntimeError("Forbidden configuration read")
        return _original(path, mode, *args, **kwargs)
    namespace.open = guarded_open
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""


def cli(directory, paths):
    environment = {
        key: value
        for key, value in os.environ.items()
        if key
        in {
            "PATH",
            "SystemRoot",
            "SYSTEMROOT",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "COMSPEC",
            "PATHEXT",
        }
    }
    return subprocess.run(
        [sys.executable, "-B", "-I", "-c", GUARD, str(CLI), *map(str, paths)],
        cwd=directory,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )


def copied_inputs(directory, values=None):
    case, report, manifest, raw = values or inputs()
    paths = [directory / name for name in ("case.json", "report.json", "manifest.json", "raw.json")]
    for path, value in zip(
        paths, (canonical_json(case).encode(), report, canonical_json(manifest).encode(), raw)
    ):
        path.write_bytes(value)
    return paths


@pytest.mark.parametrize("mismatch", [False, True])
def test_isolated_readonly_cli_returns_only_hashes_counts_and_unknowns(tmp_path, mismatch):
    paths = copied_inputs(tmp_path, wrong_number_inputs() if mismatch else None)
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    completed = cli(tmp_path, paths)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert completed.stderr == ""
    summary = json.loads(completed.stdout)
    assert summary["counts"] == {
        "submitted": 4,
        "match": 3 if mismatch else 4,
        "mismatch": int(mismatch),
    }
    assert summary["expert"] == "PENDING" and summary["expert_approved_claim_denominator"] == 0
    assert summary["semantic_support"] == "NOT_EVALUATED"
    assert summary["provider_origin"] == "NOT_AUTHENTICATED"
    assert summary["historical_vintage"] == "unknown"
    assert summary["publication_time"] is None and summary["first_public_availability"] is None
    assert summary["historical_authority"] == "UNAVAILABLE"
    assert summary["observation_count"] == 48 and summary["series_count"] == 2
    assert "308.148" not in completed.stdout and "full_text" not in completed.stdout
    assert str(tmp_path) not in completed.stdout
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before


@pytest.mark.parametrize(
    "failure",
    [
        "missing",
        "extra_argv",
        "duplicate_case",
        "duplicate_report",
        "duplicate_manifest",
        "invalid_utf8",
        "utf16_report",
        "raw_hash",
        "case_bound",
        "report_bound",
        "manifest_bound",
        "raw_bound",
    ],
)
def test_cli_rejects_bounded_duplicate_or_invalid_input_without_echoing_paths(tmp_path, failure):
    paths = copied_inputs(tmp_path)
    if failure == "missing":
        paths[0] = tmp_path / "private-input-must-not-be-echoed.json"
    elif failure == "extra_argv":
        paths.append("private-argument-must-not-be-echoed")
    elif failure.startswith("duplicate_"):
        index = {"duplicate_case": 0, "duplicate_report": 1, "duplicate_manifest": 2}[failure]
        paths[index].write_bytes(b'{"schema_version":1,' + paths[index].read_bytes()[1:])
    elif failure == "invalid_utf8":
        paths[1].write_bytes(b"\xff")
    elif failure == "utf16_report":
        paths[1].write_bytes(paths[1].read_bytes().decode().encode("utf-16"))
    elif failure == "raw_hash":
        paths[3].write_bytes(paths[3].read_bytes() + b" ")
    else:
        index, limit = {
            "case_bound": (0, MAX_CASE_BYTES),
            "report_bound": (1, MAX_REPORT_BYTES),
            "manifest_bound": (2, MAX_SOURCE_BYTES),
            "raw_bound": (3, MAX_SOURCE_BYTES),
        }[failure]
        paths[index].write_bytes(b" " * (limit + 1))
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    completed = cli(tmp_path, paths)
    assert completed.returncode == 1
    assert completed.stdout == ""
    assert completed.stderr == DIAGNOSTIC + "\n"
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before
