"""Offline full-graph evidence, citation and checkpoint acceptance coverage."""

from __future__ import annotations

import copy
import hashlib
import json
import re
from concurrent.futures import ThreadPoolExecutor

import pytest
from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from pydantic import Field

from tests.test_graph_runtime import TRADE_DATE, ScriptedModel, _graph
from tests.test_graph_runtime import offline as offline
from tradingagents.agents.analysts import sentiment_analyst
from tradingagents.agents.utils import agent_utils
from tradingagents.evidence import (
    EvidencePersistenceError,
    capture_evidence,
    current_ledger,
    merge_evidence_bundles,
    observe_attempt,
    observe_source,
    validate_evidence_bundle,
)
from tradingagents.dataflows import interface as router
from tradingagents.graph import trading_graph

MISSING_ID = "ev-" + "f" * 32


class CitingModel(ScriptedModel):
    """Cite visible tool artifacts while retaining the full scripted workflow."""

    source_inputs: list = Field(default_factory=list)
    prompts: list = Field(default_factory=list)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.prompts.append("\n".join(str(message.content) for message in messages))
        for message in messages:
            if isinstance(message, ToolMessage):
                self.source_inputs.append((message.name, str(message.content)))
        result = super()._generate(messages, stop, run_manager, **kwargs)
        response = result.generations[0].message
        if not response.tool_calls:
            ids = re.findall(
                r"\[E:(ev-[a-f0-9]{32})\]", "\n".join(str(m.content) for m in messages)
            )
            # A resolved citation can accompany an unsupported statement.
            # Resolution must not be labelled verification of that statement.
            response.content += (
                "\nUnsupported statement [E:" + ids[-1] + "]." if ids else ""
            ) + f"\nMissing source [E:{MISSING_ID}]."
        return result


def _capture_social(monkeypatch, counters):
    """Instrument offline direct prefetches exactly as the public sources do."""
    for tool_name, provider in (
        ("fetch_stocktwits_messages", "stocktwits"),
        ("fetch_reddit_posts", "reddit"),
    ):

        def source(ticker, *, _tool=tool_name, _provider=provider, **kwargs):
            parameters = {"ticker": ticker, **kwargs}

            def operation():
                counters.append(_tool)
                observe_attempt(_provider, "available")
                observe_source(_provider, normalized_data={"text": "frozen social post"})
                return "frozen social post"

            return capture_evidence(_tool, parameters, operation)

        monkeypatch.setattr(sentiment_analyst, tool_name, source)


@pytest.mark.unit
def test_concurrent_private_graphs_project_sources_and_final_audit(tmp_path, monkeypatch, offline):
    model = CitingModel()
    graph = _graph(tmp_path, monkeypatch, model, analyst_concurrency_limit=4)
    initial = graph.create_run_state("NVDA", TRADE_DATE)
    partials, final = [], None
    for _, state, agent in graph.stream_run(
        initial, include_agent=True, **graph.propagator.get_graph_args()
    ):
        assert current_ledger() is None  # generator never leaks its bound context
        if state and agent and state.get("evidence_bundle"):
            partials.append((agent, state))
        if state and state.get("final_trade_decision"):
            final = state

    assert len(partials) == 4
    scopes = {
        "Market Analyst": "market",
        "Sentiment Analyst": "social",
        "News Analyst": "news",
        "Fundamentals Analyst": "fundamentals",
    }
    for agent, state in partials:
        bundle = validate_evidence_bundle(state["evidence_bundle"])
        assert {record["analyst"] for record in bundle["records"]} <= {scopes[agent]}
        referenced_artifacts = {record["output_sha256"] for record in bundle["records"]} | {
            source["data_sha256"]
            for record in bundle["records"]
            for source in record["sources"]
            if source["data_sha256"]
        }
        assert set(bundle["artifacts"]) == referenced_artifacts

    valid_id = initial["evidence_bundle"]["records"][0]["id"]
    final["fundamentals_report"] = f"An unsupported numeric claim: revenue is 999 [E:{valid_id}]."
    graph.record_decision("NVDA", TRADE_DATE, final)
    bundle = validate_evidence_bundle(final["evidence_bundle"])
    assert {r["analyst"] for r in bundle["records"]} == {
        "identity",
        "market",
        "social",
        "news",
        "fundamentals",
    }
    artifacts = {a["payload"] for a in bundle["artifacts"].values() if a["kind"] == "tool_text"}
    assert model.source_inputs and all(text in artifacts for _, text in model.source_inputs)
    assert all("cite each source-backed factual or numeric claim" in p for p in model.prompts)
    audit = bundle["citation_audit"]["market_report"]
    assert audit["status"] == "unresolved" and MISSING_ID in audit["unresolved_ids"]
    assert set(audit) == {"referenced_ids", "unresolved_ids", "status"}
    resolved = bundle["citation_audit"]["fundamentals_report"]
    assert resolved == {"referenced_ids": [valid_id], "unresolved_ids": [], "status": "resolved"}
    log = json.loads(next((tmp_path / "results").rglob("full_states_log_*.json")).read_text())
    assert log["evidence_bundle"] == bundle
    assert log["run_settings"] == bundle["manifest"]


@pytest.mark.unit
def test_checkpoint_resume_freezes_sources_memory_and_identity(tmp_path, monkeypatch, offline):
    counts = []
    _capture_social(monkeypatch, counts)
    model = ScriptedModel(fail_at=1)
    first = _graph(
        tmp_path, monkeypatch, model, checkpoint_enabled=True, analyst_concurrency_limit=1
    )
    # Start with sentiment so failure occurs after all direct inputs are captured.
    first.selected_analysts = ("social",)
    first.workflow = first.graph_setup.setup_graph(first.selected_analysts)
    first.graph = first.workflow.compile()
    from pathlib import Path

    memory_fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "memory_bundle_v1.json").read_text()
    )
    first._research_memory().store.record_decision(memory_fixture["input_snapshot"]["decisions"][0])
    frozen_memory = {}
    create_state = first.create_run_state

    def capture_state(*args, **kwargs):
        state = create_state(*args, **kwargs)
        frozen_memory.update(copy.deepcopy(state["research_memory"]))
        return state

    monkeypatch.setattr(first, "create_run_state", capture_state)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        first.propagate("NVDA", TRADE_DATE)
    frozen = first._evidence_ledger.bundle()
    before = list(counts)
    assert before == ["fetch_stocktwits_messages", "fetch_reddit_posts"]

    resumed = _graph(
        tmp_path, monkeypatch, ScriptedModel(), checkpoint_enabled=True, analyst_concurrency_limit=1
    )
    resumed.selected_analysts = ("social",)
    resumed.workflow = resumed.graph_setup.setup_graph(resumed.selected_analysts)
    resumed.graph = resumed.workflow.compile()

    def forbidden(*args, **kwargs):
        raise AssertionError("resume changed a frozen input")

    monkeypatch.setattr(resumed, "_resolve_pending_entries", forbidden)
    monkeypatch.setattr(resumed._research_memory().store, "context_snapshot", forbidden)
    monkeypatch.setattr(trading_graph, "resolve_instrument_identity", forbidden)
    state, _ = resumed.propagate("NVDA", TRADE_DATE)
    assert counts == before
    assert state["past_context"] == frozen_memory["input_snapshot"]["context_artifact"]["payload"]
    assert state["past_context"]
    assert state["research_memory"] == frozen_memory
    assert state["memory_bundle"]["input_snapshot"] == frozen_memory["input_snapshot"]
    assert state["evidence_bundle"]["run_id"] == frozen["run_id"]
    assert state["evidence_bundle"]["records"] == frozen["records"]
    assert state["evidence_bundle"]["artifacts"] == frozen["artifacts"]
    assert state["run_settings"] == frozen["manifest"]


@pytest.mark.unit
def test_a_new_identical_tool_call_after_resume_gets_new_evidence(tmp_path, monkeypatch, offline):
    """Already checkpointed inputs must not be mistaken for failed-node replay."""
    counts = []
    for vendor in router.VENDOR_METHODS["get_stock_data"]:
        monkeypatch.setitem(
            router.VENDOR_METHODS["get_stock_data"],
            vendor,
            lambda *a, **k: counts.append(1) or "stock data",
        )
    first = _graph(
        tmp_path,
        monkeypatch,
        ScriptedModel(fail_at=2),
        checkpoint_enabled=True,
        analyst_concurrency_limit=1,
    )
    first.selected_analysts = ("market",)
    first.workflow = first.graph_setup.setup_graph(first.selected_analysts)
    first.graph = first.workflow.compile()
    with pytest.raises(RuntimeError, match="provider unavailable"):
        first.propagate("NVDA", TRADE_DATE)
    assert counts == [1]

    class RepeatAfterTools(ScriptedModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            prices = [
                m for m in messages if isinstance(m, ToolMessage) and m.name == "get_stock_data"
            ]
            if self.tools and len(prices) == 1:
                original = next(
                    call
                    for message in messages
                    for call in (getattr(message, "tool_calls", None) or [])
                    if call["name"] == "get_stock_data"
                )
                return ChatResult(
                    generations=[
                        ChatGeneration(
                            message=AIMessage(
                                content="", tool_calls=[{**original, "id": "repeat_stock"}]
                            )
                        )
                    ]
                )
            return super()._generate(messages, stop, run_manager, **kwargs)

    resumed = _graph(
        tmp_path,
        monkeypatch,
        RepeatAfterTools(),
        checkpoint_enabled=True,
        analyst_concurrency_limit=1,
    )
    resumed.selected_analysts = ("market",)
    resumed.workflow = resumed.graph_setup.setup_graph(resumed.selected_analysts)
    resumed.graph = resumed.workflow.compile()
    state, _ = resumed.propagate("NVDA", TRADE_DATE)
    assert counts == [1, 1]
    prices = [r for r in state["evidence_bundle"]["records"] if r["tool"] == "get_stock_data"]
    assert len(prices) == 2 and prices[0]["id"] != prices[1]["id"]
    assert prices[0]["parameters"] == prices[1]["parameters"]


@pytest.mark.unit
def test_two_simultaneous_runs_never_share_evidence(tmp_path, monkeypatch, offline):
    first = _graph(tmp_path / "one", monkeypatch, ScriptedModel(), analyst_concurrency_limit=2)
    second = _graph(tmp_path / "two", monkeypatch, ScriptedModel(), analyst_concurrency_limit=2)
    with ThreadPoolExecutor(max_workers=2) as pool:
        left, right = list(
            pool.map(lambda graph: graph.propagate("NVDA", TRADE_DATE)[0], (first, second))
        )
    one, two = left["evidence_bundle"], right["evidence_bundle"]
    assert one["run_id"] != two["run_id"]
    assert {r["id"] for r in one["records"]}.isdisjoint(r["id"] for r in two["records"])
    with pytest.raises(ValueError):
        merge_evidence_bundles(one, two)
    assert current_ledger() is None


@pytest.mark.unit
def test_failed_capture_persistence_stops_before_the_model_reads_sources(
    tmp_path, monkeypatch, offline
):
    model = CitingModel()
    graph = _graph(tmp_path, monkeypatch, model, analyst_concurrency_limit=1)
    graph.selected_analysts = ("market",)
    graph.workflow = graph.graph_setup.setup_graph(graph.selected_analysts)
    graph.graph = graph.workflow.compile()
    initial = graph.create_run_state("NVDA", TRADE_DATE)

    def failed_persistence(bundle):
        raise EvidencePersistenceError("simulated persistence failure")

    monkeypatch.setattr(graph._evidence_ledger, "_persist", failed_persistence)
    with pytest.raises(EvidencePersistenceError):
        list(graph.stream_run(initial, **graph.propagator.get_graph_args()))
    assert len(model.calls) == 1  # the initial request for tools, before any source return
    assert model.source_inputs == []
    assert graph._evidence_ledger.bundle()["records"] == initial["evidence_bundle"]["records"]
    assert current_ledger() is None


@pytest.mark.unit
@pytest.mark.parametrize("field", ["past_context", "instrument_context", "run_settings"])
def test_frozen_state_must_match_the_evidence_manifest(tmp_path, monkeypatch, offline, field):
    graph = _graph(tmp_path, monkeypatch, ScriptedModel())
    state = copy.deepcopy(graph.create_run_state("NVDA", TRADE_DATE))
    state[field] = {"changed": True} if field == "run_settings" else "changed context"
    with pytest.raises(ValueError, match="research evidence"):
        next(graph.stream_run(state, **graph.propagator.get_graph_args()))


@pytest.mark.unit
def test_current_identity_is_explicitly_not_historical_verification(tmp_path, monkeypatch, offline):
    graph = _graph(tmp_path, monkeypatch, ScriptedModel())
    state = graph.create_run_state("NVDA", "2020-01-02")
    identity = state["evidence_bundle"]["records"][0]
    assert identity["analyst"] == "identity"
    assert identity["sources"][0]["provider"] == "yfinance"
    assert identity["sources"][0]["historical_availability"] == "unknown"
    assert "current name" in state["instrument_context"]
    assert "not evidence" in state["instrument_context"]
    assert agent_utils.get_instrument_context_from_state(state).startswith(
        state["instrument_context"]
    )


@pytest.mark.unit
def test_sanitized_identity_context_hash_stays_valid_on_fresh_run_and_resume(
    tmp_path, monkeypatch, offline
):
    configured_secret = "synthetic_configured_credential_401"
    environment_secret = "synthetic_environment_credential_402"
    monkeypatch.setenv("EVIDENCE_TEST_API_KEY", environment_secret)
    company = (
        f"Research {configured_secret} {environment_secret} "
        "https://named-user:password@example.com/profile?token=private-query "
        "http://127.0.0.1/private /Users/researcher/private.txt"
    )
    monkeypatch.setattr(
        agent_utils.yf, "Ticker", lambda _: type("Ticker", (), {"info": {"longName": company}})()
    )
    agent_utils.resolve_instrument_identity.cache_clear()
    settings = {
        "checkpoint_enabled": True,
        "api_key": configured_secret,
        "holding_period_days": 9,
        "benchmark_ticker": "QQQ",
    }
    first = _graph(tmp_path, monkeypatch, ScriptedModel(fail_at=12), **settings)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        first.propagate("NVDA", TRADE_DATE)
    bundle = first._evidence_ledger.bundle()
    identity = next(record for record in bundle["records"] if record["analyst"] == "identity")
    context = bundle["artifacts"][identity["output_sha256"]]["payload"]
    plain_context = context.split("\n", 1)[1]
    digest = hashlib.sha256(
        json.dumps(plain_context, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    assert bundle["manifest"]["instrument_identity_context_sha256"] == digest
    assert bundle["manifest"]["holding_period_days"] == 9
    assert bundle["manifest"]["benchmark_ticker"] == "QQQ"
    assert "https://example.com/profile" in context
    serialized = json.dumps(bundle)
    for prohibited in (
        configured_secret,
        environment_secret,
        "named-user",
        "private-query",
        "127.0.0.1",
        "/Users/researcher",
    ):
        assert prohibited not in serialized

    resumed = _graph(tmp_path, monkeypatch, ScriptedModel(), **settings)

    def forbidden(*args, **kwargs):
        raise AssertionError("resume must retain its captured identity context")

    monkeypatch.setattr(trading_graph, "resolve_instrument_identity", forbidden)
    state, _ = resumed.propagate("NVDA", TRADE_DATE)
    assert state["instrument_context"] == context
    assert state["run_settings"] == bundle["manifest"]
    assert state["evidence_bundle"]["run_id"] == bundle["run_id"]
