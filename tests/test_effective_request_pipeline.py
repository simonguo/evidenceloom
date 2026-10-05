"""Exercise real completion/export and PM boundaries with offline fictional inputs."""

from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from cli.main import save_report_to_disk
from frontend.server import run_analysis as runner
from tests.test_desktop_stream import bridge, payload  # noqa: F401
from tests.test_graph_runtime import TRADE_DATE, ScriptedModel, _graph, offline  # noqa: F401
from tests.test_research_readiness import fictional_bundle
from tests.test_effective_request_identity import marked_scenario
from tradingagents.agents.utils.rating import extract_rating
from tradingagents.graph.conditional_logic import ConditionalLogic
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.memory.schema import hash_value, make_component
from tradingagents.research.effective_request_identity import (
    POLICY_SHA256,
    EffectiveRequestIdentityError,
    validate_effective_request_identity,
)
from tradingagents.research.readiness import assess_readiness, validate_readiness
from tradingagents.research.numeric_review import REPORT_SECTION_KEYS, NumericReviewError


def _saved_completion(*, marked=True):
    name = (
        "effective_request_identity_marked_v1.json"
        if marked
        else "effective_request_identity_v1.json"
    )
    fixture = json.loads((Path(__file__).parent / "fixtures" / name).read_bytes())
    return {
        **deepcopy(fixture["snapshot"]["report_sections"]),
        "evidence_bundle": fixture["evidence"],
        "report_text_snapshot": fixture["snapshot"],
        "effective_request_identity": fixture["assessment"],
    }


@pytest.mark.parametrize(
    "parameters",
    [{"symbol": "OTHER"}, {"symbol": "FICT", "ticker": "OTHER"}, {}, {"symbol": "FICT+"}],
)
def test_real_pm_gate_does_not_turn_ready_but_unsafe_requests_into_a_call(
    tmp_path, monkeypatch, parameters
):
    from tradingagents.graph import setup

    evidence, policy = fictional_bundle(tmp_path)
    # Preserve the complete verified market input. A second saved tool record
    # can carry unsafe request parameters while Readiness v1 still permits PM.
    wrong_record = deepcopy(evidence["records"][0])
    wrong_record.update(
        id="ev-ffffffffffffffffffffffffffffffff", tool="get_stock_data", parameters=parameters
    )
    old_output = evidence["artifacts"][wrong_record["output_sha256"]]
    new_output = {
        "kind": "tool_text",
        "payload": old_output["payload"].replace(evidence["records"][0]["id"], wrong_record["id"]),
    }
    wrong_record["output_sha256"] = hash_value(new_output)
    evidence["artifacts"][wrong_record["output_sha256"]] = new_output
    evidence["records"].append(wrong_record)
    evidence = make_component(evidence, "bundle_sha256")
    prior = assess_readiness(evidence, policy)
    assert prior["recommendation_allowed"] is True
    calls = []

    def manager(state):
        calls.append(True)
        return {"final_rating": "Buy", "final_trade_decision": "Rating: Buy"}

    monkeypatch.setattr(setup, "create_portfolio_manager", lambda model: manager)
    model = ScriptedModel(structured=True)
    workflow = setup.GraphSetup(model, model, {}, ConditionalLogic()).setup_graph(["market"])
    result = workflow.nodes["Portfolio Manager"].runnable.invoke(
        {"evidence_bundle": evidence, "research_readiness_policy": policy, "risk_debate_state": {}}
    )
    assert calls == []
    assert result["final_rating"] == extract_rating(result["final_trade_decision"]) == "REVIEW"
    assert result["research_readiness"] == prior
    assert wrong_record["id"] in result["final_trade_decision"]
    validate_readiness(prior, evidence, rating="REVIEW", final_text=result["final_trade_decision"])


def test_offline_graph_freezes_request_assessment_and_cli_exports_same_body(
    tmp_path,
    monkeypatch,
    offline,  # noqa: F811
):
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(structured=True))
    state, _ = graph.propagate("NVDA", TRADE_DATE)
    assert (
        state["evidence_bundle"]["manifest"]["effective_request_identity_policy_sha256"]
        == POLICY_SHA256
    )
    assessment = validate_effective_request_identity(
        state["effective_request_identity"], state["evidence_bundle"], state["report_text_snapshot"]
    )
    assert assessment["reviewed_at"] >= state["report_text_snapshot"]["captured_at"]
    saved = next((tmp_path / "cache").rglob("effective_request_identity.json"))
    assert json.loads(saved.read_bytes()) == assessment
    graph.record_decision("NVDA", TRADE_DATE, state)
    assert state["effective_request_identity"] == assessment
    retry = deepcopy(state)
    retry.pop("effective_request_identity")
    graph.record_decision("NVDA", TRADE_DATE, retry)
    assert retry["effective_request_identity"] == assessment
    log = json.loads(next((tmp_path / "results").rglob("full_states_log_*.json")).read_bytes())
    assert log["effective_request_identity"] == assessment
    export = tmp_path / "export"
    save_report_to_disk(state, "NVDA", export)
    assert json.loads((export / "effective_request_identity.json").read_bytes()) == assessment
    assert (
        json.loads((export / "report_text_snapshot.json").read_bytes())
        == state["report_text_snapshot"]
    )
    poisoned = deepcopy(state)
    poisoned["effective_request_identity"]["records"] = []
    poisoned["effective_request_identity"] = make_component(
        poisoned["effective_request_identity"], "assessment_sha256"
    )
    with pytest.raises(EffectiveRequestIdentityError):
        save_report_to_disk(poisoned, "NVDA", tmp_path / "poisoned-export")
    assert not (tmp_path / "poisoned-export").exists()


def test_actual_desktop_completed_event_carries_one_frozen_assessment(bridge):  # noqa: F811
    _, events, _ = bridge
    runner.run(payload())
    completed = next(event for event in events if event["type"] == "completed")
    assessment = completed["effectiveRequestIdentity"]
    assert completed["finalState"]["effective_request_identity"] == assessment
    assert (
        validate_effective_request_identity(
            assessment, completed["evidenceBundle"], completed["reportTextSnapshot"]
        )
        == assessment
    )
    assert all(
        "effectiveRequestIdentity" not in event for event in events if event["type"] != "completed"
    )


@pytest.mark.parametrize("prose", ["Rating: Buy", "Ｒａｔｉｎｇ： Ｂｕｙ\nRating: REVIEW"])
def test_unsafe_typed_review_cannot_persist_directional_prose_to_memory(prose):
    evidence, snapshot = marked_scenario(prose)
    graph = TradingAgentsGraph.__new__(TradingAgentsGraph)
    graph._evidence_secrets = lambda: ()
    graph._ledger_for_state = lambda state: SimpleNamespace(bundle=lambda **kwargs: evidence)
    calls = []
    graph._research_memory = lambda: SimpleNamespace(record_final=lambda *args: calls.append(args))
    graph.curr_state = None
    state = {
        **snapshot["report_sections"],
        "final_rating": "REVIEW",
        "evidence_bundle": evidence,
        "run_settings": evidence["manifest"],
    }
    with pytest.raises(EffectiveRequestIdentityError):
        graph.record_decision("FICT", "2026-01-09", state)
    assert calls == []
    assert graph.curr_state is None


def test_new_marked_completion_cannot_export_or_emit_without_its_assessment(tmp_path):
    evidence, snapshot = marked_scenario("Rating: REVIEW")
    state = {
        **snapshot["report_sections"],
        "evidence_bundle": evidence,
        "report_text_snapshot": snapshot,
    }
    with pytest.raises(EffectiveRequestIdentityError):
        save_report_to_disk(state, "FICT", tmp_path / "missing")
    assert not (tmp_path / "missing").exists()
    with pytest.raises(EffectiveRequestIdentityError):
        runner.compact_final_state(state)


@pytest.mark.parametrize("ticker", ["OTHER", "fict", " FICT"])
def test_cli_export_title_cannot_change_frozen_requested_instrument(tmp_path, ticker):
    state = _saved_completion()
    original = deepcopy(state)
    destination = tmp_path / "export"
    with pytest.raises(NumericReviewError):
        save_report_to_disk(state, ticker, destination)
    assert list(tmp_path.iterdir()) == []
    assert state == original


@pytest.mark.parametrize("marked", [False, True])
@pytest.mark.parametrize("section", REPORT_SECTION_KEYS)
def test_compact_packet_cannot_replace_any_frozen_published_section(marked, section):
    state = _saved_completion(marked=marked)
    expected = deepcopy(state["report_text_snapshot"])
    assert runner.compact_final_state(state)["report_text_snapshot"] == expected
    state[section] = "Different unpublished bytes.\r\n😀"
    with pytest.raises(NumericReviewError):
        runner.compact_final_state(state)
    assert state["report_text_snapshot"] == expected


@pytest.mark.parametrize("rating", ["Buy", "Overweight", "Hold", "Underweight", "Sell"])
def test_marked_unsafe_typed_direction_cannot_export_or_enter_completed_packet(tmp_path, rating):
    state = _saved_completion()
    state["final_rating"] = rating
    assert extract_rating(state["final_trade_decision"]) == "REVIEW"
    with pytest.raises(EffectiveRequestIdentityError):
        save_report_to_disk(state, "FICT", tmp_path / "export")
    assert list(tmp_path.iterdir()) == []
    with pytest.raises(EffectiveRequestIdentityError):
        runner.compact_final_state(state)


@pytest.mark.parametrize("rating", [None, "unrecognized", True])
def test_cli_marked_unsafe_present_typed_rating_must_be_usable_review(tmp_path, rating):
    state = _saved_completion()
    state["final_rating"] = rating
    with pytest.raises(EffectiveRequestIdentityError):
        save_report_to_disk(state, "FICT", tmp_path / "export")
    assert list(tmp_path.iterdir()) == []


def test_marked_unsafe_missing_typed_rating_keeps_frozen_review_prose(tmp_path):
    state = _saved_completion()
    assert "final_rating" not in state
    packet = runner.compact_final_state(state)
    assert packet["report_text_snapshot"] == state["report_text_snapshot"]
    output = save_report_to_disk(state, "FICT", tmp_path / "export")
    assert output.read_bytes().startswith(b"# Trading Analysis Report: FICT\n")
    assert (
        json.loads((output.parent / "effective_request_identity.json").read_bytes())
        == state["effective_request_identity"]
    )


def test_compact_null_generation_marker_is_present_and_invalid():
    state = {
        "evidence_bundle": {"manifest": {"effective_request_identity_policy_sha256": None}},
        "final_trade_decision": "Rating: REVIEW",
    }
    with pytest.raises(EffectiveRequestIdentityError):
        runner.compact_final_state(state)
