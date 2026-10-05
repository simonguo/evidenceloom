"""Normalize the values actually used by adapters, before presentation rounding."""

from __future__ import annotations

from datetime import date, datetime
from contextvars import ContextVar
from decimal import Decimal
import math

import pandas as pd

from tradingagents.evidence import observe_attempt, observe_source

_attempt_count = ContextVar("source_attempt_count", default=0)


def attempt_count() -> int:
    return _attempt_count.get()


def source_attempt(provider, status, elapsed_ms=0):
    """Let routing distinguish real upstream attempts from wrapper adapters."""
    _attempt_count.set(_attempt_count.get() + 1)
    observe_attempt(provider, status, elapsed_ms)


def scalar(value):
    """JSON scalars without NaN, preserving Python's full floating precision."""
    if value is None or value is pd.NaT or value is pd.NA:
        return None
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value) if value.is_finite() else None
    if isinstance(value, (dict, list, tuple, set)):
        return None
    if hasattr(value, "item"):
        try:
            value = value.item()
        except ValueError:
            return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, (str, bool, int, float)):
        return value
    return None


def frame_data(data: pd.DataFrame, *, include_index=False) -> dict:
    """A normalized table, never an HTTP response or DataFrame repr."""
    frame = data.reset_index() if include_index else data
    return {
        "columns": [str(c) for c in frame.columns],
        "rows": [[scalar(v) for v in row] for row in frame.itertuples(index=False, name=None)],
    }


def business_fields(data: dict, allowed) -> dict:
    """Select scalar business fields; opaque nested objects are never inputs."""
    return {
        key: value
        for key, value in data.items()
        if key in allowed and (value is None or isinstance(value, (str, int, float, bool)))
    }


def observed_window(data: pd.DataFrame, date_column="Date") -> dict | None:
    if date_column not in data and not isinstance(data.index, pd.DatetimeIndex):
        return None
    dates = data[date_column] if date_column in data else data.index
    dates = pd.to_datetime(dates, errors="coerce")
    dates = dates[~pd.isna(dates)]
    if len(dates) == 0 or not isinstance(dates, (pd.DatetimeIndex, pd.Series)):
        return None
    return {"start": dates.min().strftime("%Y-%m-%d"), "end": dates.max().strftime("%Y-%m-%d")}


def observe_ohlcv(data: pd.DataFrame, *, provider=None, url=None, transformations=()):
    """Use observed frame provenance; a missing attribute stays unknown."""
    actual = provider or str(data.attrs.get("source", "unknown")).lower()
    if actual not in {"yfinance", "eastmoney", "tencent", "alpha_vantage"}:
        actual = "unknown"
    observe_source(
        actual,
        url=url or data.attrs.get("source_url"),
        normalized_data=frame_data(data, include_index="Date" not in data),
        observed_window=observed_window(data),
        adjustments=data.attrs.get("adjustments"),
        transformations=transformations,
    )
