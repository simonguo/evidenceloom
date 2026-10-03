"""Realized and benchmark returns use a complete window with common endpoints."""

from unittest.mock import MagicMock

import pandas as pd
import pytest

from tradingagents.agents.utils.settlement import compute_returns


def mock_prices(monkeypatch, stock_dates, stock_prices, bench_dates, bench_prices):
    frames = {
        "NVDA": pd.DataFrame({"Close": stock_prices}, index=pd.to_datetime(stock_dates)),
        "SPY": pd.DataFrame({"Close": bench_prices}, index=pd.to_datetime(bench_dates)),
    }
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement.yf.Ticker",
        lambda symbol: MagicMock(history=MagicMock(return_value=frames[symbol])),
    )


def test_incomplete_holding_window_remains_pending(monkeypatch):
    dates = ["2026-01-05", "2026-01-06", "2026-01-07"]
    mock_prices(monkeypatch, dates, [100, 101, 102], dates, [200, 201, 202])
    assert compute_returns("NVDA", "2026-01-05") == (None, None, None, None)


def test_benchmark_spans_same_dates_when_calendars_differ(monkeypatch):
    stock_dates = [
        "2026-01-05",
        "2026-01-06",
        "2026-01-08",
        "2026-01-09",
        "2026-01-12",
        "2026-01-13",
    ]
    bench_dates = pd.bdate_range("2026-01-05", "2026-01-13")
    mock_prices(
        monkeypatch,
        stock_dates,
        [100, 101, 102, 103, 104, 110],
        bench_dates,
        [200, 201, 202, 203, 204, 205, 220],
    )
    raw, alpha, days, known = compute_returns("NVDA", "2026-01-05")
    assert raw == pytest.approx(0.1) and alpha == pytest.approx(0)
    assert days == 5 and known == "2026-01-13"


def test_crypto_weekend_entry_uses_last_benchmark_close_by_entry(monkeypatch):
    stock_dates = pd.date_range("2026-01-10", "2026-01-15", tz="UTC")
    bench_dates = pd.bdate_range("2026-01-09", "2026-01-16", tz="America/New_York")
    mock_prices(
        monkeypatch,
        stock_dates,
        [100, 101, 102, 103, 104, 105],
        bench_dates,
        [100, 103, 104, 105, 106, 107],
    )
    raw, alpha, days, known = compute_returns("NVDA", "2026-01-10")
    assert raw == pytest.approx(0.05) and alpha == pytest.approx(-0.01)
    assert days == 5 and known == "2026-01-15"


def test_benchmark_must_have_traded_through_exit(monkeypatch):
    mock_prices(
        monkeypatch,
        pd.bdate_range("2026-01-05", periods=6),
        [100, 101, 102, 103, 104, 105],
        pd.bdate_range("2026-01-05", periods=3),
        [200, 201, 202],
    )
    assert compute_returns("NVDA", "2026-01-05") == (None, None, None, None)


@pytest.mark.parametrize("holding_days", [0, -1, "5", "invalid", True, False, None, 1.5])
def test_invalid_holding_windows_raise_before_requesting_prices(monkeypatch, holding_days):
    ticker = MagicMock()
    monkeypatch.setattr("tradingagents.agents.utils.settlement.yf.Ticker", ticker)
    with pytest.raises(ValueError, match="holding_days must be a positive integer"):
        compute_returns("NVDA", "2026-01-05", holding_days=holding_days)
    ticker.assert_not_called()


def test_provider_failure_leaves_a_valid_holding_window_pending(monkeypatch):
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement.yf.Ticker",
        MagicMock(side_effect=RuntimeError("provider unavailable")),
    )
    assert compute_returns("NVDA", "2026-01-05") == (None, None, None, None)


@pytest.mark.parametrize("exit_date", ["2026-03-02", "2026-06-02"])
def test_a_long_closure_or_suspension_does_not_leave_a_completed_window_pending(
    monkeypatch, exit_date
):
    frame = pd.DataFrame(
        {"Close": [100, 101, 102, 103, 104, 105]},
        index=pd.to_datetime(
            ["2026-02-13", "2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27", exit_date]
        ),
    )
    queried = []

    class Ticker:
        def history(self, start, end):
            queried.append((start, end))
            return frame[(frame.index >= pd.Timestamp(start)) & (frame.index < pd.Timestamp(end))]

    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement.get_current_date", lambda: "2026-06-03"
    )
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement._utc_current_date", lambda: "2026-06-03"
    )
    monkeypatch.setattr("tradingagents.agents.utils.settlement.yf.Ticker", lambda _: Ticker())
    raw, alpha, days, known = compute_returns("600519.SS", "2026-02-13", benchmark="000001.SS")
    assert raw == pytest.approx(0.05) and alpha == pytest.approx(0)
    assert days == 5 and known == exit_date
    assert all(end == "2026-06-03" for _, end in queried)


def test_future_rows_do_not_complete_a_holding_window(monkeypatch):
    dates = pd.bdate_range("2026-01-05", periods=6)
    mock_prices(
        monkeypatch, dates, [100, 101, 102, 103, 104, 105], dates, [200, 201, 202, 203, 204, 205]
    )
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement.get_current_date", lambda: "2026-01-07"
    )
    assert compute_returns("NVDA", "2026-01-05") == (None, None, None, None)


def test_todays_exit_candle_waits_until_the_next_day(monkeypatch):
    dates = pd.bdate_range("2026-01-05", periods=6)
    mock_prices(
        monkeypatch, dates, [100, 101, 102, 103, 104, 105], dates, [200, 201, 202, 203, 204, 210]
    )
    current = ["2026-01-12"]
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement.get_current_date", lambda: current[0]
    )
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement._utc_current_date", lambda: current[0]
    )
    assert compute_returns("NVDA", "2026-01-05") == (None, None, None, None)

    current[0] = "2026-01-13"
    raw, alpha, days, known = compute_returns("NVDA", "2026-01-05")
    assert raw == pytest.approx(0.05) and alpha == pytest.approx(0)
    assert days == 5 and known == "2026-01-12"


def test_a_live_benchmark_candle_does_not_prove_it_has_traded_through_exit(monkeypatch):
    stock_dates = pd.bdate_range("2026-01-05", periods=6)
    mock_prices(
        monkeypatch,
        stock_dates,
        [100, 101, 102, 103, 104, 105],
        ["2026-01-05", "2026-01-13"],
        [200, 210],
    )
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement.get_current_date", lambda: "2026-01-13"
    )
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement._utc_current_date", lambda: "2026-01-13"
    )
    assert compute_returns("NVDA", "2026-01-05") == (None, None, None, None)


@pytest.mark.parametrize(
    ("stock_timezone", "benchmark_timezone"),
    [
        ("America/New_York", "America/New_York"),
        ("UTC", "America/New_York"),
        ("Asia/Shanghai", "America/New_York"),
    ],
)
def test_local_midnight_uses_a_conservative_cutoff_across_market_timezones(
    monkeypatch, stock_timezone, benchmark_timezone
):
    stock_dates = pd.bdate_range("2026-01-05", periods=6, tz=stock_timezone)
    benchmark_dates = pd.bdate_range("2026-01-05", periods=6, tz=benchmark_timezone)
    mock_prices(
        monkeypatch,
        stock_dates,
        [100, 101, 102, 103, 104, 105],
        benchmark_dates,
        [200, 201, 202, 203, 204, 210],
    )
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement.get_current_date", lambda: "2026-01-13"
    )
    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement._utc_current_date", lambda: "2026-01-12"
    )
    assert compute_returns("NVDA", "2026-01-05") == (None, None, None, None)

    monkeypatch.setattr(
        "tradingagents.agents.utils.settlement._utc_current_date", lambda: "2026-01-13"
    )
    assert compute_returns("NVDA", "2026-01-05")[3] == "2026-01-12"
