"""Offline request alignment, full coverage and before-delivery regressions."""

from copy import deepcopy
import json
from pathlib import Path

import pytest

from tradingagents.evidence import (
    EvidenceLedger,
    EvidencePersistenceError,
    EvidenceSourceError,
    analyst_evidence,
    capture_evidence,
    current_ledger,
    observe_attempt,
    observe_source,
)
from tradingagents.memory.schema import make_component
from tradingagents.research.effective_request_identity import (
    EFFECTIVE_REQUEST_IDENTITY_POLICY,
    POLICY_SHA256,
    EffectiveRequestIdentityError,
    assess_effective_request_identity,
    assess_selector,
    unsafe_effective_request_ids,
    validate_effective_request_identity,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures/effective_request_identity_v1.json"
FIXTURE = json.loads(FIXTURE_PATH.read_bytes())


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_shared_selector_cases(case):
    request = case["input"]
    assert (
        assess_selector(request["run_instrument"], request["tool"], request["parameters"])
        == case["expected"]
    )


def test_policy_and_shared_attachment_rederive_without_provider_resolution():
    policy = json.loads(
        (
            FIXTURE_PATH.parents[2] / "docs/contracts/effective_request_identity_policy_v1.json"
        ).read_bytes()
    )
    assert policy == EFFECTIVE_REQUEST_IDENTITY_POLICY == FIXTURE["policy"]
    assert POLICY_SHA256 == FIXTURE["policy_sha256"]
    evidence, snapshot, assessment = (
        FIXTURE[key] for key in ("evidence", "snapshot", "assessment")
    )
    derived = assess_effective_request_identity(
        evidence, snapshot, reviewed_at=assessment["reviewed_at"]
    )
    assert derived == assessment
    assert validate_effective_request_identity(assessment, evidence, snapshot) == assessment
    assert unsafe_effective_request_ids(evidence) == assessment["summary"]["unsafe_record_ids"]
    assert derived["records"][0]["sources"][1]["provider"] == "yfinance"
    assert derived["records"][0]["sources"][2]["data_sha256"] is None
    assert all(
        source["provider_request"] == source["provider_entity"] == "unknown"
        for record in derived["records"]
        for source in record["sources"]
    )


def _change(candidate, attack):
    if attack == "omit_conflict":
        candidate["records"].pop(1)
    elif attack == "omit_non_head_source":
        candidate["records"][0]["sources"].pop(1)
    elif attack == "reorder":
        candidate["records"].reverse()
    elif attack == "duplicate_record":
        candidate["records"].append(deepcopy(candidate["records"][0]))
    elif attack == "false_match":
        candidate["records"][1].update(
            canonical_alignment="consistent",
            canonical_reason="effective_request_aligned",
            record_alignment="consistent",
            record_reason="effective_request_aligned",
        )
    elif attack == "false_provider_entity":
        candidate["records"][0]["sources"][1]["provider_entity"] = "confirmed"
    elif attack == "false_provider":
        candidate["records"][0]["sources"][1]["provider"] = "tencent"
    elif attack == "false_data_sha":
        candidate["records"][0]["sources"][2]["data_sha256"] = candidate["records"][0]["sources"][
            0
        ]["data_sha256"]
    elif attack == "summary":
        candidate["summary"].update(conflict_count=0, unsafe_record_ids=[])
    elif attack == "early":
        candidate["reviewed_at"] = "2026-01-09T10:59:59.999999Z"
    elif attack == "short_clock":
        candidate["reviewed_at"] = "2026-01-09T12:00:00Z"
    elif attack == "unicode_clock":
        candidate["reviewed_at"] = "２０２６-01-09T12:00:00.000000Z"
    elif attack == "offset_clock":
        candidate["reviewed_at"] = "2026-01-09T12:00:00.000000+00:00"
    elif attack == "cross_run":
        candidate["run_id"] = "5c042f1b-67ff-4d37-8690-7d38afca64fe"
    elif attack == "cross_snapshot":
        candidate["report_snapshot_sha256"] = "0" * 64
    elif attack == "false_policy":
        candidate["policy_sha256"] = "0" * 64
    elif attack == "unknown_key":
        candidate["extra"] = "unreviewed"
    elif attack == "boolean_count":
        candidate["summary"]["consistent_count"] = True
    else:
        raise AssertionError(attack)


@pytest.mark.parametrize(
    "attack",
    [
        "omit_conflict",
        "omit_non_head_source",
        "reorder",
        "duplicate_record",
        "false_match",
        "false_provider_entity",
        "false_provider",
        "false_data_sha",
        "summary",
        "early",
        "short_clock",
        "unicode_clock",
        "offset_clock",
        "cross_run",
        "cross_snapshot",
        "false_policy",
        "unknown_key",
        "boolean_count",
    ],
)
def test_rehashed_corruption_and_false_alignment_rejected(attack):
    candidate = deepcopy(FIXTURE["assessment"])
    _change(candidate, attack)
    candidate = make_component(candidate, "assessment_sha256")
    with pytest.raises(EffectiveRequestIdentityError, match="Invalid or conflicting"):
        validate_effective_request_identity(candidate, FIXTURE["evidence"], FIXTURE["snapshot"])


def test_outputs_do_not_alias_inputs_or_other_operations():
    first = validate_effective_request_identity(
        FIXTURE["assessment"], FIXTURE["evidence"], FIXTURE["snapshot"]
    )
    first["records"][0]["sources"][0]["provider"] = "unknown"
    first["summary"]["unsafe_record_ids"].clear()
    again = assess_effective_request_identity(
        FIXTURE["evidence"], FIXTURE["snapshot"], reviewed_at=FIXTURE["assessment"]["reviewed_at"]
    )
    assert again == FIXTURE["assessment"]


@pytest.mark.parametrize("clock", ["2026-01-09T10:00:00Z", "2026-01-09T10:00:00.1Z"])
def test_inherited_evidence_timestamp_precision_unchanged(clock):
    from tradingagents.evidence import audit_citations
    from tradingagents.research.numeric_review import make_report_text_snapshot

    evidence = deepcopy(FIXTURE["evidence"])
    evidence["created_at"] = clock
    for record in evidence["records"]:
        record["fetched_at"] = clock
    evidence = make_component(evidence, "bundle_sha256")
    sections = FIXTURE["snapshot"]["report_sections"]
    evidence = audit_citations(evidence, sections)
    snapshot = make_report_text_snapshot(
        evidence, sections, captured_at=FIXTURE["snapshot"]["captured_at"]
    )
    assert (
        assess_effective_request_identity(evidence, snapshot)["summary"]
        == FIXTURE["assessment"]["summary"]
    )


def new_ledger(tmp_path, instrument="FICT"):
    return EvidenceLedger(instrument, "2026-01-09", {"analysts": ["market"]}, tmp_path)


def test_conflict_saved_before_provider_or_model_delivery(tmp_path):
    ledger = new_ledger(tmp_path)
    calls = []
    with (
        ledger.bind(),
        pytest.raises(EvidenceSourceError, match="Effective outer request conflicts"),
    ):
        capture_evidence("get_stock_data", {"symbol": "OTHER"}, lambda: calls.append("provider"))
    assert calls == []
    bundle = ledger.bundle()
    record = bundle["records"][0]
    assert record["status"] == "withheld"
    assert record["sources"] == record["attempts"] == []
    assert record["parameters"] == {"symbol": "OTHER"}
    text = bundle["artifacts"][record["output_sha256"]]["payload"]
    assert (
        text
        == f"[E:{record['id']}]\nREQUEST_WITHHELD: effective outer request conflicts with this research run; no source values were supplied."
    )
    assert unsafe_effective_request_ids(bundle) == [record["id"]]
    saved = json.loads((tmp_path / bundle["run_id"] / "bundle.json").read_bytes())
    assert saved == bundle


def test_unsafe_restored_replay_never_delivers_old_body(tmp_path):
    # The fixture includes a valid legacy record with mismatched effective params.
    committed = deepcopy(FIXTURE["evidence"])
    directory = tmp_path / committed["run_id"]
    directory.mkdir()
    (directory / "bundle.json").write_bytes(
        json.dumps(committed, ensure_ascii=False).encode("utf-8")
    )
    checkpoint = make_component(
        dict(committed, records=[], artifacts={}, citation_audit={}), "bundle_sha256"
    )
    ledger = EvidenceLedger.restore(checkpoint, tmp_path)
    record = next(row for row in committed["records"] if row["tool"] == "get_indicators")
    key = ledger._call_key(record["analyst"], record["tool"], record["parameters"])
    assert ledger._replay[key] == [record["id"]]
    calls = []
    with ledger.bind(), analyst_evidence(record["analyst"]), pytest.raises(EvidenceSourceError):
        capture_evidence("get_indicators", record["parameters"], lambda: calls.append("provider"))
    assert calls == []
    assert ledger._replay[key] == [record["id"]]
    assert ledger.bundle()["records"][-1]["status"] == "withheld"


@pytest.mark.parametrize(
    "instrument,selector,alignment",
    [
        ("FICT", "fict", "consistent"),
        ("000001", "000001", "consistent"),
        ("600519.SH", "600519.SS", "consistent"),
        ("700.HK", "0700.HK", "consistent"),
        ("000001", "000001.SZ", "unknown"),
        ("GOLD", "GC=F", "proxy"),
    ],
)
def test_nonconflict_capture_stays_observable_and_pm_guard_rederives(
    tmp_path, instrument, selector, alignment
):
    ledger = new_ledger(tmp_path, instrument)
    calls = []

    def operation():
        calls.append("provider")
        observe_attempt("yfinance", "available")
        observe_source("yfinance", normalized_data={"Close": 1.005})
        return "Fictional observed price"

    with ledger.bind():
        result = capture_evidence("get_stock_data", {"symbol": selector}, operation)
    assert calls == ["provider"] and result.endswith("Fictional observed price")
    record = ledger.bundle()["records"][0]
    unsafe = unsafe_effective_request_ids(ledger.bundle())
    assert unsafe == ([] if alignment == "consistent" else [record["id"]])


def test_request_conflict_persistence_failure_stops_without_call(tmp_path, monkeypatch):
    ledger = new_ledger(tmp_path)

    def failure(_):
        raise EvidencePersistenceError("fixed safe persistence failure")

    monkeypatch.setattr(ledger, "_persist", failure)
    with ledger.bind(), pytest.raises(EvidencePersistenceError):
        capture_evidence(
            "get_stock_data", {"symbol": "OTHER"}, lambda: pytest.fail("provider called")
        )


def test_no_ledger_public_return_contract_unchanged():
    assert current_ledger() is None
    sentinel = object()
    assert capture_evidence("get_stock_data", {"symbol": "OTHER"}, lambda: sentinel) is sentinel


@pytest.mark.parametrize("case", [None, {}, {"schema_version": 1}, [], True])
def test_malformed_assessment_has_fixed_error(case):
    with pytest.raises(EffectiveRequestIdentityError) as error:
        validate_effective_request_identity(case, FIXTURE["evidence"], FIXTURE["snapshot"])
    assert str(error.value) == "Invalid or conflicting effective outer-request assessment"


def marked_scenario(final_text, *, marker=POLICY_SHA256):
    from tradingagents.evidence import audit_citations
    from tradingagents.memory.schema import hash_value
    from tradingagents.research.numeric_review import make_report_text_snapshot

    evidence = deepcopy(FIXTURE["evidence"])
    evidence["manifest"]["effective_request_identity_policy_sha256"] = marker
    evidence["manifest_sha256"] = hash_value(evidence["manifest"])
    evidence = make_component(evidence, "bundle_sha256")
    sections = deepcopy(FIXTURE["snapshot"]["report_sections"])
    sections["final_trade_decision"] = final_text
    evidence = audit_citations(evidence, sections)
    snapshot = make_report_text_snapshot(
        evidence, sections, captured_at=FIXTURE["snapshot"]["captured_at"]
    )
    return evidence, snapshot


def test_marked_unsafe_completion_requires_authoritative_review_rating():
    evidence, snapshot = marked_scenario("Rating: REVIEW\nUnsafe saved request evidence")
    result = assess_effective_request_identity(evidence, snapshot)
    assert (
        result["summary"]["unsafe_record_ids"]
        == FIXTURE["assessment"]["summary"]["unsafe_record_ids"]
    )
    assert validate_effective_request_identity(result, evidence, snapshot) == result


@pytest.mark.parametrize(
    "final_text",
    [
        None,
        "Rating: Buy",
        "Rating: Hold",
        "Rating: REVIEW or Buy",
        "Unrecognized heading\rRating: Buy\nRating: REVIEW",
    ],
)
def test_marked_conflict_cannot_keep_or_hide_directional_decision(final_text):
    evidence, snapshot = marked_scenario(final_text)
    with pytest.raises(EffectiveRequestIdentityError):
        assess_effective_request_identity(evidence, snapshot)


def test_unmarked_archive_keeps_original_directional_prose():
    from tradingagents.evidence import audit_citations
    from tradingagents.research.numeric_review import make_report_text_snapshot

    sections = deepcopy(FIXTURE["snapshot"]["report_sections"])
    sections["final_trade_decision"] = "Rating: Buy"
    evidence = audit_citations(FIXTURE["evidence"], sections)
    snapshot = make_report_text_snapshot(
        evidence, sections, captured_at=FIXTURE["snapshot"]["captured_at"]
    )
    result = assess_effective_request_identity(evidence, snapshot)
    assert result["summary"]["conflict_count"] == 1
    assert snapshot["report_sections"]["final_trade_decision"] == "Rating: Buy"


def test_wrong_optional_policy_marker_not_reinterpreted_by_current_engine():
    evidence, snapshot = marked_scenario("Rating: REVIEW", marker="0" * 64)
    with pytest.raises(EffectiveRequestIdentityError):
        assess_effective_request_identity(evidence, snapshot)
    with pytest.raises(EffectiveRequestIdentityError):
        unsafe_effective_request_ids(evidence)
