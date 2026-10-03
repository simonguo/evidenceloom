"""Holding-window mistakes fail at configuration boundaries, even with no memory."""

from unittest.mock import MagicMock

import pytest

from frontend.server.run_analysis import build_config
from tradingagents.default_config import _apply_env_overrides
from tradingagents.graph import trading_graph

INVALID_HOLDING_DAYS = [0, -1, "5", "invalid", True, False, None, 1.5]


@pytest.mark.parametrize("holding_days", INVALID_HOLDING_DAYS)
def test_graph_rejects_invalid_holding_windows_before_initializing_any_run(
    tmp_path, monkeypatch, holding_days
):
    client, memory = MagicMock(), MagicMock()
    monkeypatch.setattr(trading_graph, "create_llm_client", client)
    monkeypatch.setattr(trading_graph, "TradingMemoryLog", memory)
    with pytest.raises(ValueError, match="holding_period_days must be a positive integer"):
        trading_graph.TradingAgentsGraph(
            config={
                "holding_period_days": holding_days,
                "results_dir": str(tmp_path / "results"),
                "data_cache_dir": str(tmp_path / "cache"),
                "memory_log_path": str(tmp_path / "memory.md"),
            }
        )
    client.assert_not_called()
    memory.assert_not_called()
    assert not (tmp_path / "results").exists() and not (tmp_path / "cache").exists()


@pytest.mark.parametrize("holding_days", INVALID_HOLDING_DAYS)
def test_desktop_config_rejects_invalid_holding_windows(holding_days):
    with pytest.raises(ValueError, match="holding_period_days must be a positive integer"):
        build_config({"holdingPeriodDays": holding_days})


def test_desktop_config_retains_a_valid_integer_holding_window():
    assert build_config({"holdingPeriodDays": 7})["holding_period_days"] == 7


@pytest.mark.parametrize("holding_days", ["0", "-1", "true", "1.5", "invalid"])
def test_env_rejects_invalid_holding_windows(monkeypatch, holding_days):
    monkeypatch.setenv("TRADINGAGENTS_HOLDING_PERIOD_DAYS", holding_days)
    with pytest.raises(ValueError):
        _apply_env_overrides({"holding_period_days": 5})


def test_env_coerces_a_valid_holding_window_to_an_integer(monkeypatch):
    monkeypatch.setenv("TRADINGAGENTS_HOLDING_PERIOD_DAYS", "7")
    assert _apply_env_overrides({"holding_period_days": 5})["holding_period_days"] == 7
