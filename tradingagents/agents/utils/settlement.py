"""Measure complete holding windows against a benchmark over the same dates."""

from datetime import datetime, timedelta
import logging
from typing import Optional, Tuple

import pandas as pd
import yfinance as yf

from tradingagents.dataflows.symbol_utils import normalize_symbol
from tradingagents.dataflows.utils import get_current_date

logger = logging.getLogger(__name__)


def _closes_by_day(frame: pd.DataFrame) -> pd.Series:
    closes = pd.to_numeric(frame["Close"], errors="coerce").dropna()
    closes = closes[(closes > 0) & (closes < float("inf"))]
    index = pd.DatetimeIndex(closes.index)
    if index.tz is not None:
        index = index.tz_localize(None)
    closes.index = index.normalize()
    return closes[~closes.index.duplicated(keep="last")].sort_index()


def compute_returns(
    ticker: str,
    trade_date: str,
    holding_days: int = 5,
    benchmark: str = "SPY",
) -> Tuple[Optional[float], Optional[float], Optional[int], Optional[str]]:
    """Return raw, alpha, full holding sessions and their known-by date, or no result.

    The instrument's own sessions define the window. Benchmark returns use its
    last close on or before those same endpoints, and wait until it has traded
    through the exit. This also aligns a crypto weekend with an equity calendar.
    """
    try:
        if holding_days < 1:
            raise ValueError("holding_days must be positive")
        start = datetime.strptime(trade_date, "%Y-%m-%d")
        # Trading sessions cannot be inferred from a fixed calendar-day buffer:
        # long exchange holidays and suspensions would leave a completed window
        # permanently outside that buffer. Ask through today, never tomorrow's data.
        today = pd.Timestamp(get_current_date())
        end = (today + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
        stock = _closes_by_day(
            yf.Ticker(normalize_symbol(ticker)).history(start=trade_date, end=end)
        )
        bench_start = (start - timedelta(days=7)).strftime("%Y-%m-%d")
        bench = _closes_by_day(
            yf.Ticker(normalize_symbol(benchmark)).history(start=bench_start, end=end)
        )
        stock = stock[(stock.index >= pd.Timestamp(start)) & (stock.index <= today)]
        bench = bench[bench.index <= today]
        if len(stock) <= holding_days:
            return None, None, None, None
        entry, exit_date = stock.index[0], stock.index[holding_days]
        if bench.empty or bench.index[0] > entry or bench.index[-1] < exit_date:
            return None, None, None, None
        raw = float(stock.iloc[holding_days] / stock.iloc[0] - 1)
        alpha = raw - float(bench.asof(exit_date) / bench.asof(entry) - 1)
        return raw, alpha, holding_days, exit_date.strftime("%Y-%m-%d")
    except Exception as exc:
        logger.warning(
            "Could not resolve outcome for %s on %s vs %s: %s", ticker, trade_date, benchmark, exc
        )
        return None, None, None, None
