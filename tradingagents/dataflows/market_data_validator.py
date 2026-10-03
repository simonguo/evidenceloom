"""Deterministic integrity and completion assessment of provider daily rows.

A received daily row is an observation, not proof of a completed exchange
session. Calculations use finite, coherent, conservatively elapsed rows only.
The saved quality artifact is independent of the tool's transport status.
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
from typing import Iterable, Literal, Optional, TypedDict

import pandas as pd
from stockstats import wrap

from tradingagents.dataflows.stockstats_utils import load_ohlcv, preserve_source_dates
from tradingagents.dataflows.errors import NoMarketDataError
from tradingagents.dataflows.evidence_utils import frame_data, observe_ohlcv, scalar
from tradingagents.evidence import observe_source
from tradingagents.research.market_inputs import source_timezone_tzinfo

POLICY_VERSION = "provider-daily-integrity-v1"
COMPLETION_POLICY = "original_local_and_utc_dates_elapsed_midnight_daily_label"
DEFAULT_SNAPSHOT_INDICATORS: tuple[str, ...] = (
    "close_10_ema",
    "close_50_sma",
    "close_200_sma",
    "rsi",
    "boll",
    "boll_ub",
    "boll_lb",
    "macd",
    "macds",
    "macdh",
    "atr",
)
# Minimum input rows, not a claim of convergence or predictive validity.
INDICATOR_WARMUP = {
    "close_10_ema": 10,
    "close_50_sma": 50,
    "close_200_sma": 200,
    "rsi": 15,
    "boll": 20,
    "boll_ub": 20,
    "boll_lb": 20,
    "macd": 26,
    "macds": 34,
    "macdh": 34,
    "atr": 15,
    "vwma": 14,
}
FIELDS = ("Open", "High", "Low", "Close", "Volume")
TimezoneOrigin = Literal["timestamp", "provider_metadata", "symbol_market_convention", "unknown"]


class IndicatorAssessment(TypedDict):
    status: Literal[
        "available", "insufficient_warmup", "unavailable_input", "unsupported", "calculation_failed"
    ]
    required_rows: int | None
    usable_rows: int
    value: float | None


class RowAssessment(TypedDict):
    received: int
    in_window: int
    valid: int
    invalid: int
    conflicting_duplicate_dates: list[str]
    identical_duplicates_collapsed: int
    provisional: int
    unknown_completion: int
    usable_complete: int
    latest_received_date: str | None
    latest_usable_date: str | None


class MarketVerificationQuality(TypedDict):
    kind: Literal["market_verification_quality"]
    schema_version: Literal[1]
    policy_version: str
    symbol: str
    analysis_date: str
    observed_at: str
    provider: str
    source_timezone: str | None
    timezone_origin: TimezoneOrigin
    requested_window: dict[str, str | None]
    integrity_status: Literal["valid", "invalid", "empty"]
    completion_status: Literal["complete_provider_daily_rows", "provisional", "unknown", "empty"]
    completion_policy: str
    price_basis: dict[str, str | None]
    revision_status: Literal["unknown"]
    calendar_coverage_status: Literal["unknown"]
    rows: RowAssessment
    issues: list[str]
    indicator_assessments: dict[str, IndicatorAssessment]


def _observed_time(value: datetime | str | None) -> datetime:
    try:
        observed = (
            datetime.now(timezone.utc)
            if value is None
            else (
                datetime.fromisoformat(value.replace("Z", "+00:00"))
                if isinstance(value, str)
                else value
            )
        )
        if observed.tzinfo is None or observed.utcoffset() is None:
            raise ValueError
        return observed.astimezone(timezone.utc)
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise ValueError("Market observation requires a valid timezone-aware timestamp") from None


def _number(value) -> float | None:
    value = scalar(value)
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if math.isfinite(number) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _source_stamp(row) -> pd.Timestamp | None:
    try:
        value = row.get("SourceTimestamp", row.get("Date"))
        if value is None or pd.isna(value):
            return None
        stamp = pd.Timestamp(value)
        zone = row.get("SourceTimezone")
        if stamp.tzinfo is None and isinstance(zone, str) and zone:
            stamp = stamp.tz_localize(
                source_timezone_tzinfo(zone), ambiguous="raise", nonexistent="raise"
            )
        elif stamp.tzinfo is not None and isinstance(zone, str) and zone:
            original = stamp.tz_convert(source_timezone_tzinfo(zone))
            if original.tz_localize(None) != stamp.tz_localize(None):
                return None
            stamp = original
        return None if pd.isna(stamp) else stamp
    except (ValueError, TypeError, OverflowError, KeyError):
        return None


def _completion(row, observed: datetime) -> str:
    if row.get("TimezoneOrigin") not in {"timestamp", "provider_metadata"}:
        return "unknown"
    stamp = _source_stamp(row)
    if stamp is None:
        return "unknown"
    # An intraday timestamp cannot establish the identity of a complete daily bar.
    if any((stamp.hour, stamp.minute, stamp.second, stamp.microsecond, stamp.nanosecond)):
        return "provisional"
    if stamp.tzinfo is None:
        return "unknown"
    if stamp.date() >= observed.astimezone(stamp.tzinfo).date() or stamp.date() >= observed.date():
        return "provisional"
    return "complete_provider_daily_rows"


def _fmt(value) -> str:
    value = scalar(value)
    if value is None:
        return "N/A"
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "N/A"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return f"{value:.2f}" if math.isfinite(value) else "N/A"
    return str(value)


def _inputs(symbol: str, curr_date: str) -> pd.DataFrame:
    data = load_ohlcv(symbol, curr_date, fill_gaps=False)
    if data is None:
        return pd.DataFrame(columns=["Date", *FIELDS])
    return preserve_source_dates(data).reset_index(drop=True)


def _assess(data, symbol, curr_date, observed, selected):
    issues = set()
    attrs = data.attrs.copy()
    received = len(data) + int(attrs.get("invalid_timestamp_rows", 0))
    if "Date" not in data:
        data["Date"] = pd.NaT
    # Work with source-local date labels; original timestamps/offsets remain saved.
    dates = []
    for value in data["SourceTimestamp"] if "SourceTimestamp" in data else data["Date"]:
        try:
            stamp = pd.Timestamp(value)
            dates.append(pd.NaT if pd.isna(stamp) else pd.Timestamp(stamp.date()))
        except (ValueError, TypeError, OverflowError):
            dates.append(pd.NaT)
    data = data.copy()
    data["Date"] = pd.Series(dates, index=data.index, dtype="datetime64[ns]")
    for field in (*FIELDS, "SourceTimestamp"):
        if field not in data:
            data[field] = None
    bad_dates = int(data["Date"].isna().sum()) + int(attrs.get("invalid_timestamp_rows", 0))
    if bad_dates:
        issues.add("invalid_source_timestamp")
    data = data[data["Date"].notna() & (data["Date"] <= pd.Timestamp(curr_date))].copy()
    data = data.sort_values("Date", kind="stable")
    valid_indices = []
    for index, row in data.iterrows():
        numbers = {field: _number(row.get(field)) for field in FIELDS}
        row_valid = True
        for field, number in numbers.items():
            if number is None:
                issues.add("missing_or_nonfinite_" + field.lower())
                row_valid = False
                data.at[index, field] = None
            elif (field == "Volume" and number < 0) or (field != "Volume" and number <= 0):
                issues.add("negative_volume" if field == "Volume" else "nonpositive_price")
                row_valid = False
            if number is not None and isinstance(scalar(row.get(field)), str):
                data.at[index, field] = number
        if all(numbers[field] is not None for field in FIELDS[:4]):
            if numbers["High"] < max(numbers["Open"], numbers["Close"], numbers["Low"]) or numbers[
                "Low"
            ] > min(numbers["Open"], numbers["Close"], numbers["High"]):
                issues.add("incoherent_ohlc")
                row_valid = False
        if row_valid:
            valid_indices.append(index)
    # Conflicting observations remain in the source input, in deterministic
    # order; no provider ordering can select an authoritative duplicate close.
    data = data.sort_values(["Date", *FIELDS, "SourceTimestamp"], kind="stable")
    conflicts = []
    collapsed = 0
    excluded = set()
    for day, group in data.groupby("Date", sort=True):
        if len(group) < 2:
            continue
        signatures = {
            tuple(
                scalar(row.get(field))
                for field in (
                    *FIELDS,
                    "SourceTimestamp",
                    "SourceTimezone",
                    "SourceUTCOffset",
                    "TimezoneOrigin",
                )
            )
            for _, row in group.iterrows()
        }
        if len(signatures) != 1:
            conflicts.append(day.strftime("%Y-%m-%d"))
            excluded.update(group.index)
            issues.add("conflicting_duplicate_date")
        else:
            excluded.update(group.index[1:])
            collapsed += len(group) - 1
    valid = data.loc[[index for index in valid_indices if index not in excluded]].copy()
    zones = {
        str(zone) for zone in valid.get("SourceTimezone", []) if isinstance(zone, str) and zone
    }
    origins = {origin for origin in valid.get("TimezoneOrigin", []) if isinstance(origin, str)}
    source_timezone = next(iter(zones)) if len(zones) == 1 else None
    timezone_origin = (
        "provider_metadata"
        if "provider_metadata" in origins
        else "timestamp"
        if origins == {"timestamp"}
        else "symbol_market_convention"
        if origins == {"symbol_market_convention"}
        else "unknown"
    )
    states = [
        _completion(row, observed) if source_timezone else "unknown" for _, row in valid.iterrows()
    ]
    stamps = [_source_stamp(row) for _, row in valid.iterrows()]
    if not source_timezone or not any(
        stamp is not None and stamp.tzinfo is not None for stamp in stamps
    ):
        source_timezone, timezone_origin = None, "unknown"
    complete = valid.loc[
        [
            index
            for index, state in zip(valid.index, states)
            if state == "complete_provider_daily_rows"
        ]
    ].copy()
    provisional, unknown = states.count("provisional"), states.count("unknown")
    if provisional:
        issues.add("provisional_daily_rows")
    if unknown:
        issues.add("source_timezone_unknown")
    invalid = len(data) - len(valid) - collapsed + bad_dates
    if complete.empty:
        completion = "provisional" if provisional else "unknown" if unknown else "empty"
    elif states and states[-1] != "complete_provider_daily_rows":
        completion = states[-1]
    else:
        completion = "complete_provider_daily_rows"
    basis = attrs.get("price_basis") or attrs.get("adjustments")
    if not isinstance(basis, str) or not basis:
        basis = None
        issues.add("price_basis_unknown")
    quality: MarketVerificationQuality = {
        "kind": "market_verification_quality",
        "schema_version": 1,
        "policy_version": POLICY_VERSION,
        "symbol": symbol,
        "analysis_date": curr_date,
        "observed_at": observed.isoformat(timespec="microseconds").replace("+00:00", "Z"),
        "provider": str(attrs.get("source", "unknown")).lower(),
        "source_timezone": source_timezone,
        "timezone_origin": timezone_origin,
        "requested_window": attrs.get("requested_window", {"start": None, "end": curr_date}),
        "integrity_status": "invalid" if invalid else "valid" if len(valid) else "empty",
        "completion_status": completion,
        "completion_policy": COMPLETION_POLICY,
        "price_basis": {"status": "observed" if basis else "unknown", "value": basis},
        "revision_status": "unknown",
        "calendar_coverage_status": "unknown",
        "rows": {
            "received": received,
            "in_window": len(data),
            "valid": len(valid),
            "invalid": invalid,
            "conflicting_duplicate_dates": conflicts,
            "identical_duplicates_collapsed": collapsed,
            "provisional": provisional,
            "unknown_completion": unknown,
            "usable_complete": len(complete),
            "latest_received_date": data["Date"].max().strftime("%Y-%m-%d") if len(data) else None,
            "latest_usable_date": complete["Date"].max().strftime("%Y-%m-%d")
            if len(complete)
            else None,
        },
        "issues": [],
        "indicator_assessments": {},
    }
    stock_df = wrap(complete.copy()) if len(complete) else None
    for name in selected:
        required = INDICATOR_WARMUP.get(name)
        status = (
            "unsupported"
            if required is None
            else (
                "unavailable_input"
                if invalid or not len(complete)
                else ("insufficient_warmup" if len(complete) < required else "available")
            )
        )
        value = None
        if status == "available":
            try:
                stock_df[name]
                value = _number(stock_df.iloc[-1][name])
                if value is None:
                    status = "calculation_failed"
            except Exception:  # Fixed category; no provider or exception body is emitted.
                status = "calculation_failed"
        quality["indicator_assessments"][name] = {
            "status": status,
            "required_rows": required,
            "usable_rows": len(complete),
            "value": value,
        }
    quality["issues"] = sorted(issues)
    return data, complete, quality


def build_verified_market_snapshot(
    symbol: str,
    curr_date: str,
    look_back_days: int = 30,
    indicators: Optional[Iterable[str]] = None,
    *,
    observed_at: datetime | str | None = None,
) -> str:
    """Render observed rows and separately saved daily integrity assessments."""
    data = _inputs(symbol, curr_date)
    observed = _observed_time(observed_at)
    data, complete, quality = _assess(
        data,
        symbol,
        curr_date,
        observed,
        tuple(dict.fromkeys(indicators or DEFAULT_SNAPSHOT_INDICATORS)),
    )
    window = max(1, min(int(look_back_days), 30))
    recent = data.tail(window)
    precise = {name: value["value"] for name, value in quality["indicator_assessments"].items()}
    observe_ohlcv(
        data,
        transformations=(
            "Source timestamps/timezones retained beside local date labels",
            "Rows after analysis date excluded",
            "Invalid rows excluded from calculations; gaps never filled",
        ),
    )
    observe_source(
        "local_calculation",
        normalized_data={
            "latest_ohlcv": frame_data(complete.tail(1))
            if quality["integrity_status"] == "valid"
            else {"columns": [], "rows": []},
            "recent_closes": frame_data(recent[["Date", "Close"]])
            if "Close" in recent
            else {"columns": [], "rows": []},
            "indicator_values": precise,
        },
        transformations=(
            "Only valid conservatively complete rows used",
            "Explicit minimum indicator warm-up applied",
            "Display rounded to two decimals",
        ),
    )
    observe_source(
        "local_calculation",
        normalized_data=quality,
        transformations=(
            "Typed provider daily integrity assessment; exchange calendar and revision vintage unknown",
        ),
    )
    if data.empty:
        raise NoMarketDataError(
            symbol, symbol, "no dated OHLCV observations in the requested window"
        )
    latest = data.iloc[-1]
    date = latest["Date"].strftime("%Y-%m-%d")
    duplicate_latest = date in quality["rows"]["conflicting_duplicate_dates"]
    lines = [
        f"## Market data integrity snapshot for {symbol.upper()}",
        "",
        f"- Requested analysis date: {curr_date}",
        f"- Latest provider date observed: {date}",
        f"- Latest trading row used: {quality['rows']['latest_usable_date'] or 'N/A (no validated elapsed provider row)'}",
        f"- Integrity: {quality['integrity_status']}; completion: {quality['completion_status']}.",
        f"- Source timezone: {quality['source_timezone'] or 'unknown'} ({quality['timezone_origin']}).",
        f"- Price basis: {quality['price_basis']['value'] or 'unknown'}; revision vintage and exchange-calendar coverage: unknown.",
        "- Rows after the requested analysis date are excluded. Same-day/intraday rows are provisional; unknown timezone cannot establish completion.",
        "",
        "### Latest observed OHLCV row (not proof of a completed session)",
        "",
        "| Field | Value |",
        "|---|---:|",
    ]
    lines.extend(
        f"| {field} | {'N/A (conflicting provider rows)' if duplicate_latest else _fmt(latest.get(field))} |"
        for field in FIELDS
    )
    lines += [
        "",
        "### Technical indicators from valid elapsed provider daily rows",
        "",
        "| Indicator | Value |",
        "|---|---:|",
    ]
    for name, assessment in quality["indicator_assessments"].items():
        value = (
            _fmt(assessment["value"])
            if assessment["status"] == "available"
            else f"N/A ({assessment['status']}; requires {assessment['required_rows']} rows, has {assessment['usable_rows']})"
        )
        lines.append(f"| {name} | {value} |")
    lines += [
        "",
        f"### Recent observed closes (last {len(recent)} rows; completion not implied)",
        "",
        "| Date | Close |",
        "|---|---:|",
    ]
    lines.extend(
        f"| {row['Date'].strftime('%Y-%m-%d')} | {_fmt(row.get('Close'))} |"
        for _, row in recent.iterrows()
    )
    if quality["issues"]:
        lines += ["", "Quality limitations: " + ", ".join(quality["issues"]) + "."]
    lines += [
        "",
        "Only values marked available passed these deterministic input checks. This does not establish exchange-calendar completeness, historical adjustment vintage, predictive validity, or independent source agreement. Flag conflicting price bases or sources; do not invent a reconciled number, holiday, or missing price.",
    ]
    return "\n".join(lines)
