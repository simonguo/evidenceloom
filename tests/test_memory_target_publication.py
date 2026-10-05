"""Exercise actual completed/export boundaries with saved fictional Memory."""

from copy import deepcopy
import json
from pathlib import Path

import pytest

from cli.main import save_report_to_disk
from frontend.server.run_analysis import compact_final_state
from tradingagents.memory.publication import validate_completed_memory
from tradingagents.memory.schema import MemoryValidationError, hash_value, make_component
from tradingagents.research.numeric_review import (
    REPORT_SECTION_KEYS,
    NumericReviewError,
    make_report_text_snapshot,
)

FIXTURES = Path(__file__).parent / "fixtures"


def completion(version):
    if version == 2:
        fixture = json.loads((FIXTURES / "memory_target_binding_v2.json").read_bytes())
        evidence, memory = fixture["evidence"], fixture["bundle"]
    else:
        evidence = json.loads((FIXTURES / "memory_evidence_bundle_v1.json").read_bytes())
        memory = json.loads((FIXTURES / "memory_bundle_v1.json").read_bytes())
    snapshot = memory["decision_snapshot"]
    return {
        "evidence_bundle": evidence,
        "memory_bundle": memory,
        "final_trade_decision": snapshot["artifacts"][snapshot["decision"]["decision_text_sha256"]][
            "payload"
        ],
    }


def rebind(state):
    evidence = state["evidence_bundle"]
    evidence["manifest_sha256"] = hash_value(evidence["manifest"])
    evidence = make_component(evidence, "bundle_sha256")
    memory = state["memory_bundle"]
    memory["evidence_bundle_sha256"] = evidence["bundle_sha256"]
    snapshot = memory["decision_snapshot"]
    snapshot["decision"]["evidence_bundle_sha256"] = evidence["bundle_sha256"]
    snapshot["decision"] = make_component(snapshot["decision"], "decision_sha256")
    memory["decision_snapshot"] = make_component(snapshot, "snapshot_sha256")
    state["evidence_bundle"] = evidence
    state["memory_bundle"] = make_component(memory, "bundle_sha256")


@pytest.mark.parametrize("version", [1, 2])
def test_actual_packet_and_cli_preserve_complete_memory(version, tmp_path):
    state = completion(version)
    before = deepcopy(state)
    assert compact_final_state(state)["memory_bundle"] == before["memory_bundle"]
    output = save_report_to_disk(state, state["memory_bundle"]["instrument"], tmp_path / "export")
    assert output.is_file()
    assert (
        json.loads((output.parent / "memory_bundle.json").read_bytes()) == before["memory_bundle"]
    )
    assert (
        json.loads((output.parent / "evidence_bundle.json").read_bytes())
        == before["evidence_bundle"]
    )
    assert (
        "Arithmetic replay and current evaluation eligibility are not verified"
        in output.read_text()
    )
    assert state == before


@pytest.mark.parametrize("version", [1, 2])
def test_redaction_cannot_change_published_text_while_retaining_original_memory(version, tmp_path):
    state = completion(version)
    before = deepcopy(state)
    with pytest.raises(MemoryValidationError):
        save_report_to_disk(
            state,
            state["evidence_bundle"]["instrument"],
            tmp_path / "export",
            secrets=("Fictional",),
        )
    assert list(tmp_path.iterdir()) == []
    assert state == before


@pytest.mark.parametrize(
    "attack", ["no_memory", "null_memory", "no_marker", "wrong_marker", "v1_with_marker"]
)
def test_target_receipts_required_both_ways_before_actual_publication(attack, tmp_path):
    state = completion(1 if attack == "v1_with_marker" else 2)
    manifest = state["evidence_bundle"]["manifest"]
    if attack == "no_memory":
        del state["memory_bundle"]
    elif attack == "null_memory":
        state["memory_bundle"] = None
    elif attack == "no_marker":
        del manifest["memory_target_binding_sha256"]
        rebind(state)
    else:
        manifest["memory_target_binding_sha256"] = "a" * 64
        rebind(state)
    before = deepcopy(state)
    with pytest.raises(MemoryValidationError):
        compact_final_state(state)
    with pytest.raises(MemoryValidationError):
        save_report_to_disk(state, state["evidence_bundle"]["instrument"], tmp_path / "export")
    assert list(tmp_path.iterdir()) == []
    assert state == before


@pytest.mark.parametrize(
    "field,value",
    [
        ("benchmark_ticker", "OTHER.TEST"),
        ("holding_period_days", 19),
        ("memory_input_sha256", "a" * 64),
    ],
)
def test_coherently_rehashed_manifest_cannot_change_frozen_memory(field, value, tmp_path):
    state = completion(2)
    state["evidence_bundle"]["manifest"][field] = value
    rebind(state)
    with pytest.raises(MemoryValidationError):
        validate_completed_memory(state["memory_bundle"], state["evidence_bundle"])
    with pytest.raises(MemoryValidationError):
        compact_final_state(state)
    with pytest.raises(MemoryValidationError):
        save_report_to_disk(state, state["evidence_bundle"]["instrument"], tmp_path / "export")
    assert list(tmp_path.iterdir()) == []


def test_legacy_absence_stays_unknown_and_target_marker_cannot_manufacture_memory():
    assert validate_completed_memory(None, None) is None
    assert validate_completed_memory(None, {"manifest": {}}) is None
    for marker in (None, "a" * 64):
        with pytest.raises(MemoryValidationError):
            validate_completed_memory(None, {"manifest": {"memory_target_binding_sha256": marker}})


@pytest.mark.parametrize(
    "captured_at", ["2025-02-14T12:02:00.000000Z", "2025-02-14T12:05:00.000000Z"]
)
def test_actual_publication_snapshot_must_follow_durable_memory(captured_at, tmp_path):
    state = completion(2)
    sections = {key: state.get(key) for key in REPORT_SECTION_KEYS}
    state["report_text_snapshot"] = make_report_text_snapshot(
        state["evidence_bundle"], sections, captured_at=captured_at
    )
    before = deepcopy(state)
    if captured_at < state["memory_bundle"]["decision_snapshot"]["decision"]["recorded_at"]:
        with pytest.raises(NumericReviewError):
            compact_final_state(state)
        with pytest.raises(NumericReviewError):
            save_report_to_disk(state, state["evidence_bundle"]["instrument"], tmp_path / "export")
        assert list(tmp_path.iterdir()) == []
    else:
        assert compact_final_state(state)["report_text_snapshot"] == state["report_text_snapshot"]
        assert save_report_to_disk(
            state, state["evidence_bundle"]["instrument"], tmp_path / "export"
        ).is_file()
    assert state == before


@pytest.mark.parametrize("version", [1, 2])
@pytest.mark.parametrize("attack", ["text", "typed", "null_typed", "missing_text"])
def test_frozen_memory_binds_actual_published_decision_without_numeric_receipt(
    version, attack, tmp_path
):
    state = completion(version)
    if attack == "text":
        state["final_trade_decision"] = "Rating: REVIEW\nDifferent fictional report."
    elif attack == "missing_text":
        del state["final_trade_decision"]
    else:
        state["final_rating"] = None if attack == "null_typed" else "Buy"
    before = deepcopy(state)
    with pytest.raises(MemoryValidationError):
        compact_final_state(state)
    with pytest.raises(MemoryValidationError):
        save_report_to_disk(state, state["evidence_bundle"]["instrument"], tmp_path / "export")
    assert list(tmp_path.iterdir()) == []
    assert state == before
