"""Frozen, observational adjusted-close evaluation; never an execution simulation."""

from __future__ import annotations

from copy import deepcopy
from datetime import date, timedelta, timezone
import hashlib
import math
from numbers import Real
from pathlib import Path
import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import pandas as pd
import yfinance as yf

from tradingagents.dataflows.symbol_utils import normalize_symbol
from .schema import (
    CONTRACT_POLICIES,
    HISTORY_PARAMETERS,
    MemoryValidationError,
    canonical_json,
    make_artifact,
    make_component,
    now_utc,
    parse_json,
    utc_timestamp,
    validate_contract,
    validate_decision,
)

EVALUATOR_VERSION = "common-daily-adjusted-close-v1"
_PRICE_FIELDS = ("Close", "Adj Close", "Dividends", "Stock Splits")
_SYMBOL = re.compile(r"[A-Za-z0-9._^=+\-]{1,64}\Z")
_OFFSET = re.compile(r"([+-])([0-9]{2}):([0-9]{2})\Z")
_SHA = re.compile(r"[a-f0-9]{64}\Z")


class EvaluationValidationError(ValueError):
    """A fixed diagnostic, excluding provider bodies, secrets and local paths."""

    def __init__(self):
        super().__init__("Frozen outcome facts could not be verified")


def evaluator_code_sha256() -> str:
    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        raise EvaluationValidationError() from None


def _day(value):
    try:
        if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
            raise MemoryValidationError()
    except (ValueError, TypeError):
        raise MemoryValidationError() from None
    return value


def _host_offset(value):
    match = _OFFSET.fullmatch(value) if isinstance(value, str) else None
    if not match or int(match[2]) > 23 or int(match[3]) > 59:
        raise MemoryValidationError()
    return value


def _symbol(value):
    if not isinstance(value, str) or not _SYMBOL.fullmatch(value):
        raise MemoryValidationError()
    return value


def make_evaluation_plan(
    *,
    analysis_date,
    resolved_benchmark,
    holding_period_days,
    host_local_calendar_at_start,
    host_utc_offset,
) -> dict:
    """Freeze at research start; the host calendar is not an exchange timezone."""
    _day(analysis_date)
    _day(host_local_calendar_at_start)
    _host_offset(host_utc_offset)
    _symbol(resolved_benchmark)
    if type(holding_period_days) is not int or not 1 <= holding_period_days <= 10000:
        raise MemoryValidationError()
    if analysis_date > host_local_calendar_at_start:
        raise MemoryValidationError()
    prospective = analysis_date == host_local_calendar_at_start
    return {
        "schema_version": 1,
        "analysis_date": analysis_date,
        "research_calendar_date": host_local_calendar_at_start,
        "host_utc_offset": host_utc_offset,
        "resolved_benchmark": resolved_benchmark,
        "holding_period_days": holding_period_days,
        "evaluation_mode": "prospective_reference" if prospective else "not_evaluable",
        "not_evaluable_reason": None if prospective else "historical_decision_availability_unknown",
        "evaluator_version": EVALUATOR_VERSION,
        "evaluator_code_sha256": evaluator_code_sha256(),
        "effective_history_parameters": deepcopy(HISTORY_PARAMETERS),
        **deepcopy(CONTRACT_POLICIES),
    }


def bind_evaluation_contract(plan, decision_text_sha256) -> dict:
    """Bind the text artifact without updating the frozen evaluator or settings."""
    if not isinstance(decision_text_sha256, str) or not _SHA.fullmatch(decision_text_sha256):
        raise MemoryValidationError()
    return validate_contract(
        make_component(
            {**deepcopy(plan), "decision_text_sha256": decision_text_sha256}, "contract_sha256"
        )
    )


def make_evaluation_contract(*, decision_text, **plan_arguments) -> dict:
    """Convenience for callers that already possess a frozen start context."""
    return bind_evaluation_contract(
        make_evaluation_plan(**plan_arguments), make_artifact("text", decision_text)["sha256"]
    )


def _unsupported(contract):
    if contract["evaluation_mode"] == "not_evaluable":
        return contract["not_evaluable_reason"]
    if contract["evaluator_version"] != EVALUATOR_VERSION:
        return "unsupported_evaluator_version"
    if contract["evaluator_code_sha256"] != evaluator_code_sha256():
        return "evaluator_code_mismatch"
    return None


def _zone(name):
    if not isinstance(name, str):
        raise EvaluationValidationError()
    match = re.fullmatch(r"UTC([+-][0-9]{2}:[0-9]{2})", name)
    if match:
        offset = _OFFSET.fullmatch(match[1])
        hours, minutes = int(offset[2]), int(offset[3])
        if hours > 23 or minutes > 59:
            raise EvaluationValidationError()
        delta = timedelta(hours=hours, minutes=minutes)
        return timezone(delta if offset[1] == "+" else -delta)
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise EvaluationValidationError() from None


def _observed_zone(index):
    if not isinstance(index, pd.DatetimeIndex) or index.tz is None:
        return None
    name = str(index.tz)
    try:
        _zone(name)
        return name
    except EvaluationValidationError:
        # A genuinely fixed original offset can be retained without inventing
        # an exchange. Unrecognized dynamic timezone implementations are refused.
        if isinstance(index.tz, timezone):
            seconds = index.tz.utcoffset(None).total_seconds()
            if seconds % 60 == 0:
                sign = "+" if seconds >= 0 else "-"
                minutes = int(abs(seconds) // 60)
                return f"UTC{sign}{minutes // 60:02d}:{minutes % 60:02d}"
        return None


def _cell(value, *, present=True):
    if not present:
        return {"status": "missing_column", "value": None}
    if value is None or value is pd.NA or value is pd.NaT:
        return {"status": "missing", "value": None}
    if hasattr(value, "item"):
        try:
            value = value.item()
        except (ValueError, TypeError):
            return {"status": "unsupported", "value": None}
    if isinstance(value, bool) or not isinstance(value, Real):
        return {"status": "unsupported", "value": None}
    try:
        finite = math.isfinite(value)
    except (ValueError, OverflowError):
        finite = False
    if not finite:
        return {"status": "nonfinite", "value": None}
    return {"status": "finite", "value": value}


def _request(decision, contract, observed_at):
    return {
        **deepcopy(contract["effective_history_parameters"]),
        "start": utc_timestamp(decision["recorded_at"]).date().isoformat(),
        "end": utc_timestamp(observed_at).date().isoformat(),
    }


def _source(role, requested, resolved, parameters, frame, observed_at, *, failed=False):
    source = {
        "role": role,
        "provider": "yfinance",
        "requested_symbol": requested,
        "resolved_symbol": resolved,
        "request_parameters": deepcopy(parameters),
        "observed_at": observed_at,
        "timezone": None,
        "currency": None,
        "publication_at": None,
        "price_vintage": "unknown",
        "revision": "unknown",
        "exchange_calendar_coverage": "unknown",
        "rows": [],
        "issue": None,
    }
    if failed:
        source["issue"] = "provider_unavailable"
        return source
    if not isinstance(frame, pd.DataFrame):
        source["issue"] = "unsupported_price_table"
        return source
    if frame.empty:
        source["issue"] = "no_price_rows"
        return source
    source["timezone"] = _observed_zone(frame.index)
    currency = frame.attrs.get("currency")
    if isinstance(currency, str) and re.fullmatch(r"[A-Z]{3}", currency):
        source["currency"] = currency
    if frame.columns.duplicated().any():
        source["issue"] = "ambiguous_price_columns"
        return source
    labels = []
    for position, label in enumerate(frame.index):
        timestamp = label if isinstance(label, pd.Timestamp) and label is not pd.NaT else None
        day = timestamp.date().isoformat() if timestamp is not None else None
        offset = timestamp.strftime("%z") if timestamp is not None and timestamp.tzinfo else None
        source["rows"].append(
            {
                "timestamp": timestamp.isoformat() if timestamp is not None else None,
                "date": day,
                "utc_offset": offset[:3] + ":" + offset[3:] if offset else None,
                "values": {
                    field: _cell(
                        frame[field].iloc[position] if field in frame else None,
                        present=field in frame,
                    )
                    for field in _PRICE_FIELDS
                },
            }
        )
        labels.append(day)
        if timestamp is None or any(
            (
                timestamp.hour,
                timestamp.minute,
                timestamp.second,
                timestamp.microsecond,
                timestamp.nanosecond,
            )
        ):
            source["issue"] = "daily_label_ambiguous"
    if source["timezone"] is None:
        source["issue"] = "timezone_unknown"
    elif len(set(labels)) != len(labels):
        source["issue"] = "duplicate_session_labels"
    elif "Adj Close" not in frame:
        source["issue"] = "adjusted_close_unavailable"
    return source


def _shape(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise EvaluationValidationError()


def _price(row):
    cell = row["values"]["Adj Close"]
    value = cell["value"]
    return value if cell["status"] == "finite" and value > 0 else None


def _validate_source(source, role, requested, parameters, cutoff):
    _shape(
        source,
        (
            "role",
            "provider",
            "requested_symbol",
            "resolved_symbol",
            "request_parameters",
            "observed_at",
            "timezone",
            "currency",
            "publication_at",
            "price_vintage",
            "revision",
            "exchange_calendar_coverage",
            "rows",
            "issue",
        ),
    )
    if (
        source["role"] != role
        or source["provider"] != "yfinance"
        or source["requested_symbol"] != requested
        or (role == "benchmark" and source["resolved_symbol"] != requested)
        or canonical_json(source["request_parameters"]) != canonical_json(parameters)
        or source["publication_at"] is not None
        or source["price_vintage"] != "unknown"
        or source["revision"] != "unknown"
        or source["exchange_calendar_coverage"] != "unknown"
    ):
        raise EvaluationValidationError()
    _symbol(source["resolved_symbol"])
    if source["currency"] is not None and not re.fullmatch(r"[A-Z]{3}", source["currency"]):
        raise EvaluationValidationError()
    observed = utc_timestamp(source["observed_at"])
    if observed < cutoff or not isinstance(source["rows"], list):
        raise EvaluationValidationError()
    allowed_issues = {
        None,
        "provider_unavailable",
        "unsupported_price_table",
        "no_price_rows",
        "ambiguous_price_columns",
        "daily_label_ambiguous",
        "timezone_unknown",
        "duplicate_session_labels",
        "adjusted_close_unavailable",
    }
    if source["issue"] not in allowed_issues:
        raise EvaluationValidationError()
    for row in source["rows"]:
        _shape(row, ("timestamp", "date", "utc_offset", "values"))
        _shape(row["values"], _PRICE_FIELDS)
        for cell in row["values"].values():
            _shape(cell, ("status", "value"))
            if cell["status"] == "finite":
                if (
                    isinstance(cell["value"], bool)
                    or not isinstance(cell["value"], Real)
                    or not math.isfinite(cell["value"])
                ):
                    raise EvaluationValidationError()
            elif (
                cell["status"] not in ("missing", "missing_column", "nonfinite", "unsupported")
                or cell["value"] is not None
            ):
                raise EvaluationValidationError()
    if source["issue"] is not None:
        return
    zone = _zone(source["timezone"])
    labels = set()
    for row in source["rows"]:
        _day(row["date"])
        label = pd.Timestamp(row["timestamp"])
        if label.tzinfo is None or any(
            (label.hour, label.minute, label.second, label.microsecond, label.nanosecond)
        ):
            raise EvaluationValidationError()
        local = label.astimezone(zone)
        offset = local.strftime("%z")
        if (
            local.date().isoformat() != row["date"]
            or local.utcoffset() != label.utcoffset()
            or row["utc_offset"] != offset[:3] + ":" + offset[3:]
            or row["date"] in labels
        ):
            raise EvaluationValidationError()
        labels.add(row["date"])


def _calculation(decision, contract, facts):
    _shape(
        facts,
        (
            "schema_version",
            "decision_sha256",
            "contract_sha256",
            "observation_cutoff",
            "sources",
            "limitations",
        ),
    )
    if (
        type(facts["schema_version"]) is not int
        or facts["schema_version"] != 1
        or facts["decision_sha256"] != decision["decision_sha256"]
        or facts["contract_sha256"] != contract["contract_sha256"]
        or len(facts["sources"]) != 2
        or facts["limitations"] != _limitations()
    ):
        raise EvaluationValidationError()
    cutoff = utc_timestamp(facts["observation_cutoff"])
    recorded = utc_timestamp(decision["recorded_at"])
    if cutoff < recorded:
        raise EvaluationValidationError()
    parameters = _request(decision, contract, facts["observation_cutoff"])
    sources = facts["sources"]
    _validate_source(sources[0], "instrument", decision["instrument"], parameters, cutoff)
    _validate_source(sources[1], "benchmark", contract["resolved_benchmark"], parameters, cutoff)
    issues = [source["issue"] for source in sources if source["issue"] is not None]
    if issues:
        terminal = next(
            (issue for issue in issues if issue not in ("provider_unavailable", "no_price_rows")),
            None,
        )
        return ("not_evaluable" if terminal else "pending"), terminal or issues[0], None
    zones = [_zone(source["timezone"]) for source in sources]
    entry_after = max(recorded.date(), *(recorded.astimezone(zone).date() for zone in zones))
    tables = []
    complete_dates = []
    for source, zone in zip(sources, zones):
        observed = utc_timestamp(source["observed_at"])
        before = min(observed.date(), observed.astimezone(zone).date())
        table = {
            row["date"]: row
            for row in source["rows"]
            if date.fromisoformat(row["date"]) < before and _price(row) is not None
        }
        tables.append(table)
        complete_dates.append(sorted(table))
    common = sorted(set(tables[0]) & set(tables[1]))
    eligible = [day for day in common if date.fromisoformat(day) > entry_after]
    holding = contract["holding_period_days"]
    if len(eligible) <= holding:
        return "pending", "common_window_incomplete", None
    entry, exit_day = eligible[0], eligible[holding]
    endpoints = []
    returns = []
    for source, table in zip(sources, tables):
        entry_row, exit_row = table[entry], table[exit_day]
        entry_price, exit_price = _price(entry_row), _price(exit_row)
        result = float(exit_price / entry_price - 1)
        if not math.isfinite(result):
            return "not_evaluable", "return_not_finite", None
        returns.append(result)
        endpoints.append(
            {
                "role": source["role"],
                "resolved_symbol": source["resolved_symbol"],
                "entry": deepcopy(entry_row),
                "exit": deepcopy(exit_row),
            }
        )
    difference = returns[0] - returns[1]
    if not math.isfinite(difference):
        return "not_evaluable", "return_not_finite", None
    return (
        "available",
        None,
        {
            "schema_version": 1,
            "contract_sha256": contract["contract_sha256"],
            "entry_after_date": entry_after.isoformat(),
            "entry_date": entry,
            "exit_date": exit_day,
            "holding_period_days": holding,
            "holding_period_unit": contract["holding_period_unit"],
            "complete_instrument_dates": complete_dates[0],
            "complete_benchmark_dates": complete_dates[1],
            "common_complete_dates": common,
            "selected_common_dates": eligible[: holding + 1],
            "endpoints": endpoints,
            "raw_return": returns[0],
            "benchmark_return": returns[1],
            "return_difference": difference,
            "raw_return_formula": "instrument_exit_adj_close / instrument_entry_adj_close - 1",
            "benchmark_return_formula": "benchmark_exit_adj_close / benchmark_entry_adj_close - 1",
            "difference_formula": "raw_return - benchmark_return",
            "currency_policy": "native_currency_returns_no_fx_conversion",
            "interpretation": "close_to_close_reference_performance_not_realized_execution_or_capm_alpha",
        },
    )


def _limitations():
    return {
        "publication_time": "unknown",
        "price_vintage": "unknown",
        "provider_revision": "unknown",
        "exchange_calendar_coverage": "unknown",
        "coverage_basis": "provider_reported_daily_rows",
        "execution": "reference_prices_not_realized_fills",
        "fx_conversion": "none",
        "alignment": "identical_session_labels_not_simultaneous_market_closes",
    }


def _result(contract, observed_at, status, reason, facts=None, calculation=None):
    artifacts = {}
    references = []
    for payload in (facts, calculation):
        artifact = make_artifact("canonical_json", payload) if payload is not None else None
        if artifact:
            artifacts[artifact["sha256"]] = artifact
        references.append(artifact["sha256"] if artifact else None)
    outcome = (
        None
        if status == "pending"
        else make_component(
            {
                "schema_version": 1,
                "contract_sha256": contract["contract_sha256"],
                "observed_at": observed_at,
                "status": status,
                "reason": reason,
                "facts_sha256": references[0],
                "calculation_sha256": references[1],
            },
            "outcome_sha256",
        )
    )
    return {
        "status": status,
        "reason": reason,
        "outcome": outcome,
        "artifacts": artifacts,
        "calculation": deepcopy(calculation),
    }


def evaluate_decision(snapshot, *, observed_at=None, history_fetcher=None) -> dict:
    """Construct facts for the store to persist BEFORE any reflection invocation.

    A pending result has observations, but no terminal outcome to attach. A saved
    outcome is verified/reused offline; this function never refreshes its prices.
    ``observed_at`` injects a UTC observation clock for deterministic offline tests.
    """
    snapshot = validate_decision(snapshot)
    contract, decision = snapshot["contract"], snapshot["decision"]
    unsupported = _unsupported(contract)
    if snapshot["outcome"] is not None:
        return replay_evaluation(snapshot)
    clock = observed_at or now_utc()
    if utc_timestamp(clock) < utc_timestamp(decision["recorded_at"]):
        return {
            "status": "pending",
            "reason": "observation_not_after_decision",
            "outcome": None,
            "artifacts": {},
        }
    if unsupported:
        return _result(contract, clock, "not_evaluable", unsupported)
    parameters = _request(decision, contract, clock)
    if parameters["start"] >= parameters["end"]:
        return _result(contract, clock, "pending", "no_elapsed_entry_window")
    sources = []
    for role, requested in (
        ("instrument", decision["instrument"]),
        ("benchmark", contract["resolved_benchmark"]),
    ):
        _symbol(requested)
        # The benchmark is already resolved and frozen at research start.
        # Current alias tables may only resolve the requested instrument.
        resolved = requested if role == "benchmark" else normalize_symbol(requested)
        _symbol(resolved)
        failed = False
        try:
            frame = (
                history_fetcher(resolved, **deepcopy(parameters))
                if history_fetcher
                else yf.Ticker(resolved).history(**deepcopy(parameters))
            )
        except Exception:
            frame, failed = None, True
        source_observed = clock if observed_at is not None else now_utc()
        sources.append(
            _source(role, requested, resolved, parameters, frame, source_observed, failed=failed)
        )
    facts = {
        "schema_version": 1,
        "decision_sha256": decision["decision_sha256"],
        "contract_sha256": contract["contract_sha256"],
        "observation_cutoff": clock,
        "sources": sources,
        "limitations": _limitations(),
    }
    status, reason, calculation = _calculation(decision, contract, facts)
    outcome_observed = max((source["observed_at"] for source in sources), key=utc_timestamp)
    return _result(contract, outcome_observed, status, reason, facts, calculation)


def replay_evaluation(snapshot):
    """Verify artifact hashes, exact selection and formula solely from saved facts."""
    try:
        snapshot = validate_decision(snapshot)
        outcome = snapshot["outcome"]
        if outcome is None:
            raise EvaluationValidationError()
        unsupported = _unsupported(snapshot["contract"])
        artifacts = {
            key: deepcopy(snapshot["artifacts"][key])
            for key in (outcome["facts_sha256"], outcome["calculation_sha256"])
            if key is not None
        }
        result = {
            "status": outcome["status"],
            "reason": outcome["reason"],
            "outcome": deepcopy(outcome),
            "artifacts": artifacts,
            "calculation": None,
        }
        if unsupported and (
            outcome["status"] != "not_evaluable" or outcome["reason"] != unsupported
        ):
            return {
                "status": "not_evaluable",
                "reason": unsupported,
                "outcome": None,
                "artifacts": {},
                "calculation": None,
            }
        if outcome["status"] == "not_evaluable":
            if not unsupported and outcome["facts_sha256"] is not None:
                facts = parse_json(artifacts[outcome["facts_sha256"]]["payload"])
                status, reason, _ = _calculation(snapshot["decision"], snapshot["contract"], facts)
                if status != "not_evaluable" or reason != outcome["reason"]:
                    raise EvaluationValidationError()
                if any(
                    utc_timestamp(source["observed_at"]) > utc_timestamp(outcome["observed_at"])
                    for source in facts["sources"]
                ):
                    raise EvaluationValidationError()
            elif not unsupported or outcome["reason"] != unsupported:
                raise EvaluationValidationError()
            return result
        if unsupported:
            return {
                "status": "not_evaluable",
                "reason": unsupported,
                "outcome": None,
                "artifacts": {},
                "calculation": None,
            }
        facts = parse_json(snapshot["artifacts"][outcome["facts_sha256"]]["payload"])
        calculation = parse_json(snapshot["artifacts"][outcome["calculation_sha256"]]["payload"])
        status, reason, expected = _calculation(snapshot["decision"], snapshot["contract"], facts)
        if (
            status != "available"
            or reason is not None
            or canonical_json(calculation) != canonical_json(expected)
            or any(
                utc_timestamp(source["observed_at"]) > utc_timestamp(outcome["observed_at"])
                for source in facts["sources"]
            )
        ):
            raise EvaluationValidationError()
        result["calculation"] = expected
        return result
    except (MemoryValidationError, KeyError, TypeError, ValueError, OverflowError, RecursionError):
        raise EvaluationValidationError() from None
