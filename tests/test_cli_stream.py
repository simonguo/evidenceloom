"""Exercise the real CLI stream, including a failed checkpoint and its resume."""

from contextlib import contextmanager, nullcontext
import copy
import json
import sqlite3
from unittest.mock import MagicMock

import pytest

from cli import main as cli
from cli.models import AnalystType
from tests.test_graph_runtime import ScriptedModel, TRADE_DATE, _Client
from tests.test_graph_runtime import offline  # noqa: F401 - pytest fixture
from tradingagents.graph import trading_graph
from tradingagents.graph.checkpointer import checkpoint_step


@pytest.mark.unit
def test_cli_stream_reports_parallel_starts_and_resumes_a_typed_decision(
    tmp_path, monkeypatch, request
):
    tool_calls = request.getfixturevalue("offline")
    selections = {
        "ticker": "NVDA",
        "analysis_date": TRADE_DATE,
        "asset_type": "stock",
        "analysts": list(AnalystType),
        "research_depth": 1,
        "shallow_thinker": "offline-quick",
        "deep_thinker": "offline-deep",
        "llm_provider": "openai",
        "backend_url": None,
        "output_language": "English",
    }
    config = copy.deepcopy(cli.DEFAULT_CONFIG)
    config.update(
        results_dir=str(tmp_path / "results"),
        data_cache_dir=str(tmp_path / "cache"),
        memory_log_path=str(tmp_path / "memory.md"),
        analyst_concurrency_limit=2,
    )
    monkeypatch.setattr(cli, "DEFAULT_CONFIG", config)
    monkeypatch.setattr(cli, "get_user_selections", lambda: selections)
    monkeypatch.setattr(cli, "Live", lambda *args, **kwargs: nullcontext())
    monkeypatch.setattr(cli, "console", MagicMock())
    monkeypatch.setattr(cli.typer, "prompt", lambda *args, **kwargs: "N")

    status_snapshots = []
    monkeypatch.setattr(
        cli,
        "update_display",
        lambda *args, **kwargs: status_snapshots.append(dict(cli.message_buffer.agent_status)),
    )
    models = [
        ScriptedModel(structured=True, fail_at=12),
        ScriptedModel(structured=True),
        ScriptedModel(structured=True),
    ]
    graphs, savers = [], []
    real_graph = trading_graph.TradingAgentsGraph
    real_checkpointer = trading_graph.get_checkpointer

    def create_graph(*args, **kwargs):
        model = models[len(graphs)]
        monkeypatch.setattr(trading_graph, "create_llm_client", lambda **kw: _Client(model))
        graph = real_graph(*args, **kwargs)
        graphs.append(graph)
        return graph

    @contextmanager
    def audit_checkpointer(*args, **kwargs):
        with real_checkpointer(*args, **kwargs) as saver:
            savers.append(saver)
            yield saver

    monkeypatch.setattr(cli, "TradingAgentsGraph", create_graph)
    monkeypatch.setattr(trading_graph, "get_checkpointer", audit_checkpointer)

    # A fresh buffer per invocation prevents the CLI's logging decorators from
    # retaining a prior run's files or stacking another wrapper on top.
    monkeypatch.setattr(cli, "message_buffer", cli.MessageBuffer())
    with pytest.raises(RuntimeError, match="provider unavailable"):
        cli.run_analysis(checkpoint=True)
    first = graphs[0]
    signature = first._run_signature("stock")
    assert checkpoint_step(config["data_cache_dir"], "NVDA", TRADE_DATE, signature) is not None
    assert first._checkpointer_ctx is None and first.graph.checkpointer is None
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        savers[0].conn.execute("SELECT 1")

    monkeypatch.setattr(cli, "message_buffer", cli.MessageBuffer())
    cli.run_analysis(checkpoint=True)
    resumed = graphs[1]
    assert any(
        kind == "System" and content == "Resuming saved analysis"
        for _, kind, content in cli.message_buffer.messages
    )
    assert resumed.curr_state["final_rating"] == "Overweight"
    memory = resumed.curr_state["memory_bundle"]
    assert resumed._research_memory().store.load_bundle(memory["run_id"]) == memory
    assert memory["decision_snapshot"]["decision"]["rating"] == "Overweight"
    assert resumed.memory_log.load_entries() == []
    log_file = next((tmp_path / "results").rglob("full_states_log_*.json"))
    saved = json.loads(log_file.read_text())
    assert saved["final_rating"] == "Overweight"
    assert saved["memory_bundle"] == memory
    assert saved["run_settings"]["analyst_concurrency_limit"] == 2
    assert checkpoint_step(config["data_cache_dir"], "NVDA", TRADE_DATE, signature) is None
    assert resumed._checkpointer_ctx is None and resumed.graph.checkpointer is None
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        savers[1].conn.execute("SELECT 1")

    # Compare the resumed CLI against the same full CLI path in a fresh store.
    config.update(
        results_dir=str(tmp_path / "fresh" / "results"),
        data_cache_dir=str(tmp_path / "fresh" / "cache"),
        memory_log_path=str(tmp_path / "fresh" / "memory.md"),
    )
    monkeypatch.setattr(cli, "message_buffer", cli.MessageBuffer())
    cli.run_analysis(checkpoint=False)
    assert len(models[1].calls) < len(models[2].calls)
    assert len(models[1].calls) == len(models[2].calls) - (models[0].fail_at - 1)
    analyst_names = set(cli.ANALYST_AGENT_NAMES.values())
    active = [
        sum(state.get(agent) == "in_progress" for agent in analyst_names)
        for state in status_snapshots
    ]
    assert max(active) == 2
    assert all(
        any(state.get(agent) == "in_progress" for state in status_snapshots)
        for agent in analyst_names
    )
    assert len(models[0].threads) > 1 and len(models[2].threads) > 1
    assert all(status == "completed" for status in cli.message_buffer.agent_status.values())
    assert "get_stock_data" in tool_calls and "get_balance_sheet" in tool_calls
