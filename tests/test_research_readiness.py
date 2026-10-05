"""Fictional scientific inputs, immutable gating and offline replay."""

from copy import deepcopy
import json
from pathlib import Path
from unittest.mock import patch

import pandas as pd
import pytest

from tests.test_graph_runtime import offline  # noqa: F401

from tradingagents.dataflows import market_data_validator as verifier
from tradingagents.evidence import EvidenceLedger, analyst_evidence, capture_evidence
from tradingagents.memory.schema import make_component
from tradingagents.research.readiness import (
    assess_readiness,
    make_policy,
    validate_policy,
    validate_readiness,
    withheld_decision,
)
from tradingagents.agents.utils.rating import extract_rating

START = "2026-01-09T09:00:00.000000Z"
OBSERVED = "2026-01-09T09:30:00.000000Z"
FETCHED = "2026-01-09T10:00:00.000000Z"


def fictional_bundle(
    tmp_path, *, row_count=250, selected=("market",), historical=False, snapshot=True, invalid=False
):
    policy = make_policy(
        selected_analysts=selected,
        analysis_date="2026-01-09",
        research_started_at=START,
        research_calendar_date="2026-01-09",
        host_utc_offset="+00:00",
        max_tool_rounds=20,
    )
    if historical:
        policy["research_started_at"] = "2026-01-10T09:00:00.000000Z"
        policy["research_calendar_date"] = "2026-01-10"
        policy["temporal_mode"] = "historical_date_only"
        policy = make_component(policy, "policy_sha256")
    with patch("tradingagents.evidence.ledger._utc_now", return_value=FETCHED):
        ledger = EvidenceLedger(
            "FICT",
            "2026-01-09",
            {
                "analysts": list(selected),
                "max_tool_rounds": 20,
                "research_readiness_policy_sha256": policy["policy_sha256"],
            },
            tmp_path,
        )
        if snapshot:
            close = [100.12345678901235 + index / 10 for index in range(row_count)]
            frame = pd.DataFrame(
                {
                    "Date": pd.date_range(
                        end="2026-01-08", periods=row_count, tz="America/New_York"
                    ),
                    "Open": close,
                    "High": [item + 2 for item in close],
                    "Low": [item - 2 for item in close],
                    "Close": close,
                    "Volume": [10000] * row_count,
                }
            )
            frame.attrs.update(
                source="yfinance",
                source_timezone="America/New_York",
                price_basis="provider_raw_ohlcv_auto_adjust_false",
                requested_window={"start": None, "end": "2026-01-09"},
            )
            if invalid:
                frame.loc[0, "High"] = 1
            with (
                patch.object(verifier, "load_ohlcv", return_value=frame),
                ledger.bind(),
                analyst_evidence("market"),
            ):
                capture_evidence(
                    "get_verified_market_snapshot",
                    {"symbol": "FICT", "curr_date": "2026-01-09"},
                    lambda: verifier.build_verified_market_snapshot(
                        "FICT", "2026-01-09", observed_at=OBSERVED
                    ),
                )
    return ledger.bundle(), policy


def test_complete_inputs_ready_and_unknown_advisories_remain_visible(tmp_path):
    evidence, policy = fictional_bundle(tmp_path)
    assessment = assess_readiness(evidence, policy)
    assert assessment["status"] == "ready"
    assert assessment["recommendation_allowed"] is True
    assert assessment["checks"][-2]["status"] == assessment["checks"][-1]["status"] == "unknown"
    assert (
        validate_readiness(
            assessment, evidence, rating="Overweight", final_text="Rating: Overweight"
        )
        == assessment
    )


@pytest.mark.parametrize(
    "options,expected,reason",
    [
        ({"snapshot": False}, "insufficient_evidence", "missing_required_verification"),
        ({"row_count": 20}, "review_required", "insufficient_indicator_history"),
        ({"invalid": True}, "insufficient_evidence", "invalid_ohlcv"),
        ({"historical": True}, "review_required", "historical_availability_unknown"),
        ({"selected": ("market", "news")}, "insufficient_evidence", "missing_selected_source"),
    ],
)
def test_inputs_cannot_be_replaced_by_successful_model_prose(tmp_path, options, expected, reason):
    evidence, policy = fictional_bundle(tmp_path, **options)
    assessment = assess_readiness(evidence, policy)
    assert assessment["status"] == expected
    assert not assessment["recommendation_allowed"]
    assert reason in {reason for check in assessment["checks"] for reason in check["reason_codes"]}
    text = withheld_decision(assessment)
    assert extract_rating(text) == "REVIEW"
    validate_readiness(assessment, evidence, rating="REVIEW", final_text=text)
    with pytest.raises(ValueError):
        validate_readiness(assessment, evidence, rating="Hold", final_text="Rating: Hold")


def test_coherently_rehashed_passing_assessment_is_rejected(tmp_path):
    evidence, policy = fictional_bundle(tmp_path, row_count=2)
    bad = assess_readiness(evidence, policy)
    bad["status"], bad["recommendation_allowed"] = "ready", True
    for check in bad["checks"]:
        if check["required"]:
            check["status"], check["reason_codes"] = "passed", []
    bad = make_component(bad, "assessment_sha256")
    with pytest.raises(ValueError):
        validate_readiness(bad, evidence)


def rewrite_quality(evidence, mutate):
    evidence = deepcopy(evidence)
    for record in evidence["records"]:
        for source in record["sources"]:
            digest = source["data_sha256"]
            if not digest:
                continue
            artifact = evidence["artifacts"][digest]
            payload = json.loads(artifact["payload"])
            if isinstance(payload, dict) and payload.get("kind") == "market_verification_quality":
                mutate(payload)
                artifact["payload"] = json.dumps(
                    payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
                )
                from tradingagents.memory.schema import hash_value

                new_hash = hash_value(artifact)
                evidence["artifacts"][new_hash] = evidence["artifacts"].pop(digest)
                source["data_sha256"] = new_hash
    return make_component(evidence, "bundle_sha256")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value["indicator_assessments"]["close_200_sma"].update(required_rows=1),
        lambda value: value.update(observed_at="2026-01-08T09:00:00.000000Z"),
        lambda value: value.update(provider="reddit"),
        lambda value: value["rows"].update(usable_complete=1),
        lambda value: value.update(extra="not_a_contract_field"),
    ],
)
def test_malformed_or_unbound_quality_is_unknown_even_after_rehash(tmp_path, mutate):
    evidence, policy = fictional_bundle(tmp_path)
    assessment = assess_readiness(rewrite_quality(evidence, mutate), policy)
    assert assessment["status"] == "review_required"
    assert assessment["checks"][1]["status"] == "unknown"
    assert "verification_quality_unknown" in assessment["checks"][1]["reason_codes"]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value.update(host_utc_offset="-00:00"),
        lambda value: value.update(host_utc_offset="+14:01"),
        lambda value: value.update(required_indicators=["close_10_ema"]),
        lambda value: value.update(max_complete_row_age_days=10),
        lambda value: value.update(selected_analysts=["market", "market"]),
    ],
)
def test_policy_cannot_loosen_its_frozen_rules(tmp_path, mutate):
    _, policy = fictional_bundle(tmp_path)
    mutate(policy)
    with pytest.raises(ValueError):
        validate_policy(make_component(policy, "policy_sha256"))


def test_unselected_market_remains_explicit_not_selected(tmp_path):
    evidence, policy = fictional_bundle(tmp_path, selected=("news",), snapshot=False)
    assessment = assess_readiness(evidence, policy)
    assert [check["status"] for check in assessment["checks"][1:3]] == [
        "not_selected",
        "not_selected",
    ]
    assert assessment["checks"][3]["key"] == "selected_sources.news"


def test_first_authoritative_nfkc_rating_cannot_hide_behind_review(tmp_path):
    evidence, policy = fictional_bundle(tmp_path, row_count=2)
    assessment = assess_readiness(evidence, policy)
    with pytest.raises(ValueError):
        validate_readiness(
            assessment,
            evidence,
            rating="REVIEW",
            final_text="Ｒａｔｉｎｇ： Ｂｕｙ\nRating: REVIEW",
        )


def test_cross_language_fixture_replays_without_provider_or_model():
    fixtures = Path(__file__).parent / "fixtures"
    assessment = json.loads((fixtures / "research_readiness_v1.json").read_text())
    evidence = json.loads((fixtures / "research_readiness_evidence_v1.json").read_text())
    assert validate_readiness(assessment, evidence) == assessment


@pytest.mark.parametrize("row_count,expected,calls", [(250, "Hold", 1), (2, "REVIEW", 0)])
def test_real_portfolio_graph_gate_skips_model_when_inputs_are_thin(
    tmp_path, monkeypatch, row_count, expected, calls
):
    from tradingagents.graph import setup
    from tradingagents.graph.conditional_logic import ConditionalLogic
    from tests.test_graph_runtime import ScriptedModel

    evidence, policy = fictional_bundle(tmp_path, row_count=row_count)
    invoked = []

    def manager(state):
        invoked.append(True)
        return {"final_rating": "Hold", "final_trade_decision": "Rating: Hold"}

    monkeypatch.setattr(setup, "create_portfolio_manager", lambda model: manager)
    model = ScriptedModel(structured=True)
    workflow = setup.GraphSetup(model, model, {}, ConditionalLogic()).setup_graph(["market"])
    result = workflow.nodes["Portfolio Manager"].runnable.invoke(
        {
            "evidence_bundle": evidence,
            "research_readiness_policy": policy,
            "risk_debate_state": {},
        }
    )
    assert result["final_rating"] == expected
    assert len(invoked) == calls
    assert extract_rating(result["final_trade_decision"]) == expected
    validate_readiness(
        result["research_readiness"],
        evidence,
        rating=expected,
        final_text=result["final_trade_decision"],
    )


def test_new_frozen_policy_cannot_resume_without_its_original_memory_start(
    tmp_path, monkeypatch, request
):
    from tests.test_graph_runtime import ScriptedModel, _graph, TRADE_DATE

    request.getfixturevalue("offline")
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(structured=True))
    initial = graph.create_run_state("NVDA", TRADE_DATE)
    assert graph._validate_frozen_state(initial)
    missing = deepcopy(initial)
    missing.pop("research_memory")
    with pytest.raises(ValueError, match="original memory start"):
        graph._validate_frozen_state(missing)
