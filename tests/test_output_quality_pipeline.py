"""Output-format records survive parallel work, checkpoints and desktop export."""

import json

import pytest

from frontend.server import run_analysis as runner
from tests.test_desktop_stream import bridge, payload  # noqa: F401
from tests.test_graph_runtime import ScriptedModel, TRADE_DATE, _graph, offline  # noqa: F401
from tradingagents.agents.utils.output_quality import (
    OUTPUT_SCHEMAS,
    merge_output_quality,
    sanitize_output_quality,
)
from tradingagents.dataflows.config import run_config


def validated(agent):
    return {"status": "validated_schema", "schema": OUTPUT_SCHEMAS[agent], "source": "structured"}


@pytest.mark.parametrize("structured", [False, True])
def test_full_graph_logs_each_agent_format_status(tmp_path, monkeypatch, request, structured):
    request.getfixturevalue("offline")
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(structured=structured))
    state, rating = graph.propagate("NVDA", TRADE_DATE)

    assert rating == "Overweight"
    quality = state["output_quality"]
    assert set(quality) == set(OUTPUT_SCHEMAS)
    for agent, record in quality.items():
        assert record["schema"] == OUTPUT_SCHEMAS[agent]
        if structured:
            assert record == validated(agent)
        else:
            assert record["status"] == "unvalidated_text"
            assert record["reason"] == "structured_unavailable"
    log_path = (
        tmp_path
        / "results"
        / "NVDA"
        / "TradingAgentsStrategy_logs"
        / f"full_states_log_{TRADE_DATE}.json"
    )
    assert json.loads(log_path.read_text())["output_quality"] == quality


def test_other_parallel_analysts_cannot_restore_stale_sentiment_quality(
    tmp_path, monkeypatch, request
):
    request.getfixturevalue("offline")
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(structured=True))
    initial = graph.create_run_state("NVDA", TRADE_DATE)
    initial["output_quality"] = {
        "sentiment": {
            "status": "unvalidated_text",
            "schema": "SentimentReport",
            "source": "plain_generation",
            "reason": "structured_unavailable",
        }
    }
    with run_config(graph.config):
        state = graph.graph.invoke(initial, **graph.propagator.get_graph_args())

    assert state["output_quality"] == {agent: validated(agent) for agent in OUTPUT_SCHEMAS}


def test_checkpoint_keeps_validated_records_without_repeating_finished_agents(
    tmp_path, monkeypatch, request
):
    request.getfixturevalue("offline")
    model = ScriptedModel(structured=True, fail_at=12)
    graph = _graph(tmp_path, monkeypatch, model, checkpoint_enabled=True)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        graph.propagate("NVDA", TRADE_DATE)
    calls_before = len(model.calls)

    with graph.checkpoint_scope("NVDA", TRADE_DATE) as tid:
        saved = graph.graph.get_state({"configurable": {"thread_id": tid}}).values
        assert saved["output_quality"] == {
            agent: validated(agent) for agent in ("sentiment", "research_manager", "trader")
        }

    state, _ = graph.propagate("NVDA", TRADE_DATE)
    assert state["output_quality"] == {agent: validated(agent) for agent in OUTPUT_SCHEMAS}
    assert len(model.calls) - calls_before < calls_before
    assert graph._checkpointer_ctx is None


def test_desktop_events_keep_earlier_records_and_completed_snapshot_agrees(request):
    _, events, _ = request.getfixturevalue("bridge")
    runner.run(payload(analysts=["market", "social", "news", "fundamentals"]))
    completed = next(event for event in events if event["type"] == "completed")
    quality = {agent: validated(agent) for agent in OUTPUT_SCHEMAS}
    assert completed["outputQuality"] == completed["finalState"]["output_quality"] == quality
    previous = {}
    for event in events:
        if "outputQuality" not in event:
            continue
        current = event["outputQuality"]
        assert previous.items() <= current.items()
        previous = current
    assert previous == quality


def test_desktop_resume_exposes_saved_quality_before_new_decision(request):
    model, events, _ = request.getfixturevalue("bridge")
    model.fail_at = 12
    inputs = payload(analysts=["market", "social", "news", "fundamentals"], checkpointEnabled=True)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        runner.run(inputs)
    events.clear()
    calls_before = len(model.calls)
    runner.run(inputs)
    progress = next(event for event in events if event.get("outputQuality"))
    assert progress["type"] == "progress"
    assert progress["outputQuality"] == {
        agent: validated(agent) for agent in ("sentiment", "research_manager", "trader")
    }
    assert events[-1]["outputQuality"]["portfolio_manager"] == validated("portfolio_manager")
    assert len(model.calls) - calls_before < calls_before


def test_desktop_does_not_invent_a_quality_record_for_an_unselected_analyst(request):
    _, events, _ = request.getfixturevalue("bridge")
    runner.run(payload())
    assert events[-1]["outputQuality"] == {
        agent: validated(agent) for agent in ("research_manager", "trader", "portfolio_manager")
    }


@pytest.mark.parametrize("hostile", [None, [], "provider secret", {"unexpected": "secret"}])
def test_non_records_do_not_reach_the_safe_snapshot(hostile):
    assert sanitize_output_quality(hostile) == {}
    assert runner.compact_final_state({"output_quality": hostile}) == {"output_quality": {}}


def test_safe_records_drop_secrets_and_reject_contradictory_shapes():
    safe = validated("trader")
    candidate = {
        "trader": {**safe, "api_key": "private", "endpoint": "https://private.invalid"},
        "sentiment": {**validated("sentiment"), "source": "plain_generation"},
        "research_manager": {
            "status": "unvalidated_text",
            "schema": "ResearchPlan",
            "source": "raw_response",
            "reason": {"message": "provider secret"},
        },
        "portfolio_manager": {**validated("portfolio_manager"), "schema": "TraderProposal"},
    }
    result = sanitize_output_quality(candidate)
    assert result == {"trader": safe}
    result["trader"]["schema"] = "modified"
    assert candidate["trader"]["schema"] == "TraderProposal"
    assert merge_output_quality(candidate, {"sentiment": validated("sentiment")}) == {
        "trader": safe,
        "sentiment": validated("sentiment"),
    }
