"""Drive the desktop bridge with real graphs and offline scripted providers."""

import pytest

from cli.main import MessageBuffer, update_analyst_statuses
from frontend.server import run_analysis as runner
from tests.test_graph_runtime import ScriptedModel, _Client, offline  # noqa: F401
from tradingagents.graph import trading_graph


@pytest.fixture
def bridge(monkeypatch, request):
    request.getfixturevalue("offline")
    events, graphs = [], []
    model = ScriptedModel(structured=True)
    real_graph = trading_graph.TradingAgentsGraph
    monkeypatch.setattr(trading_graph, "create_llm_client", lambda **kwargs: _Client(model))

    def build_graph(*args, **kwargs):
        graph = real_graph(*args, **kwargs)
        graphs.append(graph)
        return graph

    monkeypatch.setattr(runner, "TradingAgentsGraph", build_graph)
    monkeypatch.setattr(runner, "emit", events.append)
    return model, events, graphs


def payload(**overrides):
    return {
        "ticker": "NVDA",
        "analysisDate": "2026-01-09",
        "analysts": ["market", "news", "fundamentals"],
        "analystConcurrencyLimit": 2,
        **overrides,
    }


def test_desktop_stream_preserves_parallel_progress_tools_rating_and_manifest(bridge):
    _, events, graphs = bridge
    runner.run(payload())

    result = next(event for event in events if event["type"] == "completed")
    assert result["decision"] == result["finalState"]["final_rating"] == "Overweight"
    assert result["runSettings"]["core_version"] == "0.2.5"
    assert result["runSettings"]["analyst_concurrency_limit"] == 2
    assert not {"backend_url", "api_key", "memory_log_path"}.intersection(result["runSettings"])
    assert result["reportSections"]["market_report"]
    assert result["stats"]["toolCalls"] > 0
    assert any(
        sum(
            status == "in_progress"
            for agent, status in event.get("agentStatuses", {}).items()
            if agent in ("Market Analyst", "News Analyst", "Fundamentals Analyst")
        )
        >= 2
        for event in events
    )
    tools = [event for event in events if event.get("messageType") == "Tool"]
    assert any(
        event["message"] == "get_verified_market_snapshot called"
        and event["agent"] == "Market Analyst"
        for event in tools
    )
    assert graphs[0]._checkpointer_ctx is None
    assert graphs[0].memory_log.load_entries()[0]["rating"] == "Overweight"


def test_desktop_crash_resumes_without_repeating_completed_steps(bridge):
    model, events, graphs = bridge
    model.fail_at = 12
    request = payload(checkpointEnabled=True)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        runner.run(request)
    assert graphs[-1]._checkpointer_ctx is None
    calls_before = len(model.calls)
    runner.run(request)
    assert len(model.calls) - calls_before < calls_before
    assert any(event.get("message") == "Resuming saved analysis" for event in events)
    assert events[-1]["type"] == "completed"
    assert graphs[-1]._checkpointer_ctx is None


def test_parallel_progress_does_not_reset_other_active_analysts():
    buffer = MessageBuffer()
    buffer.init_for_analysis(["market", "news"])
    update_analyst_statuses(buffer, {"analyst_started": "Market Analyst"})
    update_analyst_statuses(buffer, {"analyst_started": "News Analyst"})
    assert (
        buffer.agent_status["Market Analyst"]
        == buffer.agent_status["News Analyst"]
        == "in_progress"
    )
    update_analyst_statuses(buffer, {"market_report": "done"})
    assert buffer.agent_status["Market Analyst"] == "completed"
    assert buffer.agent_status["News Analyst"] == "in_progress"
    update_analyst_statuses(buffer, {"news_report": "done"})
    assert buffer.agent_status["Bull Researcher"] == "in_progress"


def test_risk_message_uses_latest_speaker_with_previous_responses_present():
    buffer = MessageBuffer()
    assert (
        runner.infer_chunk_agent(
            buffer,
            {
                "risk_debate_state": {
                    "latest_speaker": "Conservative",
                    "current_aggressive_response": "earlier response",
                    "current_conservative_response": "current response",
                }
            },
        )
        == "Conservative Analyst"
    )
