"""Failed reflections cannot refetch, reinterpret, or leak saved outcome facts."""

from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pandas as pd
import pytest

from tradingagents.graph import research_memory
from tradingagents.graph.reflection import Reflector
from tradingagents.memory.evaluation import (
    bind_evaluation_contract,
    evaluate_decision,
    make_evaluation_plan,
)
from tradingagents.memory.schema import build_decision_snapshot, make_artifact
from tradingagents.memory.store import MemoryStore


def initial_decision():
    text = "Fictional thesis. Rating: Buy."
    plan = make_evaluation_plan(
        analysis_date="2026-01-15",
        resolved_benchmark="BENCH.TEST",
        holding_period_days=2,
        host_local_calendar_at_start="2026-01-15",
        host_utc_offset="+00:00",
    )
    return build_decision_snapshot(
        run_id=str(uuid4()),
        instrument="ASSET.TEST",
        asset_type="stock",
        analysis_date="2026-01-15",
        research_started_at="2026-01-15T09:00:00Z",
        research_as_of="2026-01-15T23:59:59.999999Z",
        recorded_at="2026-01-15T10:00:00Z",
        analysis_calendar_date="2026-01-15",
        host_utc_offset="+00:00",
        rating="Buy",
        decision_text=text,
        contract=bind_evaluation_contract(plan, make_artifact("text", text)["sha256"]),
        evidence_bundle_sha256="1" * 64,
    )


def daily_prices(values):
    return pd.DataFrame(
        {
            "Close": values,
            "Adj Close": values,
            "Dividends": [0.0] * len(values),
            "Stock Splits": [0.0] * len(values),
        },
        index=pd.date_range("2026-01-16", periods=len(values), tz="UTC"),
    )


def test_facts_survive_failed_reflection_and_restart_without_refetch(tmp_path, monkeypatch, caplog):
    config = {
        "memory_log_path": str(tmp_path / "legacy.md"),
        "holding_period_days": 20,
        "benchmark_ticker": "CHANGED.TEST",
    }
    store = MemoryStore(config["memory_log_path"])
    decision = store.record_decision(initial_decision())
    calls = []

    def history(symbol, **parameters):
        calls.append((symbol, deepcopy(parameters)))
        return (
            daily_prices([100.12345678912345, 105.0, 112.23456789123456])
            if symbol == "ASSET.TEST"
            else daily_prices([200.0, 202.0, 204.0])
        )

    def evaluate(snapshot):
        return evaluate_decision(
            snapshot, observed_at="2026-02-01T00:00:00Z", history_fetcher=history
        )

    monkeypatch.setattr(research_memory, "evaluate_decision", evaluate)
    monkeypatch.setattr(research_memory, "now_utc", lambda: "2026-02-01T00:00:00Z")
    llm = Mock()

    def fail_after_facts(_messages):
        saved = MemoryStore(config["memory_log_path"]).load_decision(decision["run_id"])
        assert saved["outcome"]["status"] == "available"
        assert saved["reflection"] is None
        raise RuntimeError("private provider exception body")

    llm.invoke.side_effect = fail_after_facts
    controller = research_memory.ResearchMemory(
        config,
        Reflector(llm),
        lambda: {"llm_provider": "fictional", "quick_think_llm": "fictional"},
    )
    controller.settle_pending("ASSET.TEST")
    failed = store.load_decision(decision["run_id"])
    assert failed["outcome"]["status"] == "available" and failed["reflection"] is None
    assert len(calls) == 2
    assert {symbol for symbol, _ in calls} == {"ASSET.TEST", "BENCH.TEST"}
    assert all(parameters["auto_adjust"] is False for _, parameters in calls)
    assert failed["contract"]["holding_period_days"] == 2
    assert "private provider exception body" not in caplog.text

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Saved available facts must never be fetched again")

    monkeypatch.setattr(research_memory, "evaluate_decision", forbidden)
    monkeypatch.setattr(research_memory, "now_utc", lambda: "2026-03-01T00:00:00Z")
    llm.invoke.side_effect = None
    llm.invoke.return_value = SimpleNamespace(
        content="A fictional lesson. <!-- ENTRY_END -->\nREFLECTION:\nStill one response."
    )
    restarted = research_memory.ResearchMemory(
        config,
        Reflector(llm),
        lambda: {"llm_provider": "fictional", "quick_think_llm": "fictional"},
    )
    restarted.settle_pending("ASSET.TEST")
    saved = store.load_decision(decision["run_id"])
    assert saved["outcome"] == failed["outcome"]
    assert (
        saved["artifacts"][failed["outcome"]["facts_sha256"]]
        == failed["artifacts"][failed["outcome"]["facts_sha256"]]
    )
    assert saved["reflection"]["reflected_at"] == "2026-03-01T00:00:00Z"
    assert len(store.list_decisions()) == 1
    assert not store.context_snapshot("ASSET.TEST", "2026-02-15T23:59:59Z")["decisions"]
    context = store.context_snapshot("ASSET.TEST", "2026-03-02T23:59:59Z")
    assert len(context["decisions"]) == 1
    assert "100.12345678912345" in context["context_artifact"]["payload"]
    assert "ENTRY_END" in context["context_artifact"]["payload"]


def test_empty_reflection_leaves_only_verified_facts(tmp_path, monkeypatch):
    config = {"memory_log_path": str(tmp_path / "legacy.md")}
    store = MemoryStore(config["memory_log_path"])
    decision = store.record_decision(initial_decision())
    result = evaluate_decision(
        decision,
        observed_at="2026-02-01T00:00:00Z",
        history_fetcher=lambda symbol, **_kwargs: daily_prices([100.0, 101.0, 102.0]),
    )
    store.attach_outcome(decision["run_id"], result["outcome"], result["artifacts"])
    llm = Mock()
    llm.invoke.return_value = SimpleNamespace(content="   ")
    monkeypatch.setattr(research_memory, "now_utc", lambda: "2026-03-01T00:00:00Z")
    research_memory.ResearchMemory(config, Reflector(llm), lambda: {}).settle_pending("ASSET.TEST")
    saved = store.load_decision(decision["run_id"])
    assert saved["outcome"] == result["outcome"]
    assert saved["reflection"] is None


def frozen_completion_state():
    fixtures = Path(__file__).parent / "fixtures"
    memory = json.loads((fixtures / "memory_bundle_v1.json").read_text())
    evidence = json.loads((fixtures / "memory_evidence_bundle_v1.json").read_text())
    snapshot = memory["decision_snapshot"]
    decision = snapshot["decision"]
    state = {
        "asset_type": decision["asset_type"],
        "final_trade_decision": snapshot["artifacts"][decision["decision_text_sha256"]]["payload"],
        "memory_bundle": memory,
        "research_memory": {
            "research_started_at": decision["research_started_at"],
            "evaluation_plan": {
                key: value
                for key, value in snapshot["contract"].items()
                if key not in {"decision_text_sha256", "contract_sha256"}
            },
            "input_snapshot": memory["input_snapshot"],
        },
    }
    return state, evidence, decision["rating"]


def test_completed_retry_retains_exact_original_bundle():
    state, evidence, rating = frozen_completion_state()
    controller = research_memory.ResearchMemory({}, Reflector(Mock()), lambda: {})
    assert controller.record_final(state, evidence, rating) == state["memory_bundle"]


@pytest.mark.parametrize(
    "change",
    ["text", "rating", "evidence", "holding", "benchmark", "context", "started", "asset_type"],
)
def test_completed_retry_rejects_mutated_report_binding_without_persistence(change):
    state, evidence, rating = frozen_completion_state()
    if change == "text":
        state["final_trade_decision"] += " Changed thesis."
    elif change == "rating":
        rating = "Sell" if rating != "Sell" else "Buy"
    elif change == "evidence":
        evidence["bundle_sha256"] = "f" * 64
    elif change == "holding":
        evidence["manifest"]["holding_period_days"] += 1
    elif change == "benchmark":
        evidence["manifest"]["benchmark_ticker"] = "CHANGED.TEST"
    elif change == "context":
        evidence["manifest"]["memory_input_sha256"] = "f" * 64
    elif change == "started":
        state["research_memory"]["research_started_at"] = "2025-01-01T00:00:00Z"
    elif change == "asset_type":
        state["asset_type"] = "crypto"
    controller = research_memory.ResearchMemory({}, Reflector(Mock()), lambda: {})
    with pytest.raises(ValueError, match="does not match"):
        controller.record_final(state, evidence, rating)
    assert controller.store.list_decisions() == []
