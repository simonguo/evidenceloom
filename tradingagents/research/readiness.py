"""A deterministic input gate; no model, provider or market-library imports.

Hashes establish an immutable saved assessment. Validation additionally derives
every check from the referenced Evidence artifacts, so rehashing a falsely
passing assessment cannot bypass the gate.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta
import math
import re

from tradingagents.evidence import validate_evidence_bundle
from tradingagents.evidence.ledger import _has_observed_data
from tradingagents.memory.schema import canonical_json, hash_component, make_component, parse_json
from tradingagents.research.market_inputs import validate_market_observations

ANALYSTS = ("market", "social", "news", "fundamentals")
PRICE_PROVIDERS = frozenset({"yfinance", "eastmoney", "tencent", "alpha_vantage", "akshare"})
INDICATOR_ROWS = {
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
}
REASONS = frozenset(
    {
        "historical_availability_unknown",
        "future_analysis_date",
        "market_not_selected",
        "missing_required_verification",
        "provider_unavailable",
        "empty_observations",
        "partial_observations",
        "unknown_source_provenance",
        "verification_quality_unknown",
        "invalid_ohlcv",
        "conflicting_daily_rows",
        "provisional_daily_rows",
        "unknown_bar_completion",
        "insufficient_indicator_history",
        "unsupported_indicator",
        "indicator_calculation_failed",
        "missing_selected_source",
        "unknown_price_basis",
        "unknown_price_vintage",
        "unknown_exchange_calendar",
        "stale_or_unknown_session_coverage",
        "price_basis_conflict",
        "source_withheld",
    }
)
QUALITY_ISSUES = frozenset(
    {
        "invalid_source_timestamp",
        "missing_or_nonfinite_open",
        "missing_or_nonfinite_high",
        "missing_or_nonfinite_low",
        "missing_or_nonfinite_close",
        "missing_or_nonfinite_volume",
        "nonpositive_price",
        "negative_volume",
        "incoherent_ohlc",
        "conflicting_duplicate_date",
        "provisional_daily_rows",
        "source_timezone_unknown",
        "price_basis_unknown",
    }
)
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\Z")
_OFFSET = re.compile(r"([+-])([0-9]{2}):([0-9]{2})\Z")
_POLICY_KEYS = {
    "schema_version",
    "policy_version",
    "selected_analysts",
    "required_checks",
    "research_started_at",
    "research_as_of",
    "research_calendar_date",
    "host_utc_offset",
    "temporal_mode",
    "max_tool_rounds",
    "max_complete_row_age_days",
    "required_indicators",
    "policy_sha256",
}


def _fail():
    raise ValueError("Invalid or conflicting research readiness")


def _keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        _fail()


def _day(value):
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        _fail()
    return date.fromisoformat(value)


def _utc(value):
    if not isinstance(value, str) or not _UTC.fullmatch(value):
        _fail()
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _integer(value, low=0, high=2**53 - 1):
    if type(value) is not int or not low <= value <= high:
        _fail()
    return value


def _mode(analysis_date, calendar_date):
    return (
        "same_host_date"
        if analysis_date == calendar_date
        else "historical_date_only"
        if analysis_date < calendar_date
        else "future_date"
    )


def _required(selected):
    return [
        "temporal_availability",
        "market_verification",
        "indicator_warmup",
        *(f"selected_sources.{item}" for item in selected),
    ]


def make_policy(
    *,
    selected_analysts,
    analysis_date,
    research_started_at,
    research_calendar_date,
    host_utc_offset,
    max_tool_rounds,
):
    selected = list(dict.fromkeys(selected_analysts))
    result = make_component(
        {
            "schema_version": 1,
            "policy_version": "research-readiness-v1",
            "selected_analysts": selected,
            "required_checks": _required(selected),
            "research_started_at": research_started_at,
            "research_as_of": analysis_date + "T23:59:59.999999Z",
            "research_calendar_date": research_calendar_date,
            "host_utc_offset": host_utc_offset,
            "temporal_mode": _mode(analysis_date, research_calendar_date),
            "max_tool_rounds": max_tool_rounds,
            "max_complete_row_age_days": 3,
            "required_indicators": list(INDICATOR_ROWS),
        },
        "policy_sha256",
    )
    return validate_policy(result)


def validate_policy(value, evidence=None):
    try:
        _keys(value, _POLICY_KEYS)
        if type(value["schema_version"]) is not int or value["schema_version"] != 1:
            _fail()
        if value["policy_version"] != "research-readiness-v1":
            _fail()
        selected = value["selected_analysts"]
        if (
            not isinstance(selected, list)
            or not selected
            or len(selected) > 4
            or any(item not in ANALYSTS for item in selected)
            or len(set(selected)) != len(selected)
        ):
            _fail()
        if value["required_checks"] != _required(selected):
            _fail()
        start = _utc(value["research_started_at"])
        cutoff = _utc(value["research_as_of"])
        analysis = _day(value["research_as_of"][:10])
        calendar = _day(value["research_calendar_date"])
        if value["research_as_of"] != analysis.isoformat() + "T23:59:59.999999Z":
            _fail()
        offset = _OFFSET.fullmatch(value["host_utc_offset"])
        if offset is None:
            _fail()
        hours, minutes = int(offset[2]), int(offset[3])
        if (
            hours > 14
            or minutes > 59
            or (hours == 14 and minutes)
            or value["host_utc_offset"] == "-00:00"
        ):
            _fail()
        delta = timedelta(minutes=(hours * 60 + minutes) * (1 if offset[1] == "+" else -1))
        if (start + delta).date() != calendar or value["temporal_mode"] != _mode(
            analysis, calendar
        ):
            _fail()
        _integer(value["max_tool_rounds"], 1, 10000)
        if (
            type(value["max_complete_row_age_days"]) is not int
            or value["max_complete_row_age_days"] != 3
        ):
            _fail()
        if value["required_indicators"] != list(INDICATOR_ROWS):
            _fail()
        if hash_component(value, "policy_sha256") != value["policy_sha256"]:
            _fail()
        if evidence is not None:
            manifest = evidence["manifest"]
            if (
                cutoff.isoformat() != _utc(evidence["research_as_of"]).isoformat()
                or selected != manifest.get("analysts")
                or value["max_tool_rounds"] != manifest.get("max_tool_rounds")
                or value["policy_sha256"] != manifest.get("research_readiness_policy_sha256")
            ):
                _fail()
        return deepcopy(value)
    except (ValueError, TypeError, KeyError, OverflowError, AttributeError):
        _fail()


def _quality(value, record, evidence, policy):
    _keys(
        value,
        {
            "kind",
            "schema_version",
            "policy_version",
            "symbol",
            "analysis_date",
            "observed_at",
            "provider",
            "source_timezone",
            "timezone_origin",
            "requested_window",
            "integrity_status",
            "completion_status",
            "completion_policy",
            "price_basis",
            "revision_status",
            "calendar_coverage_status",
            "rows",
            "issues",
            "indicator_assessments",
        },
    )
    if (
        value["kind"] != "market_verification_quality"
        or type(value["schema_version"]) is not int
        or value["schema_version"] != 1
        or value["policy_version"] != "provider-daily-integrity-v1"
        or value["completion_policy"] != "original_local_and_utc_dates_elapsed_midnight_daily_label"
        or value["symbol"] != evidence["instrument"]
        or value["analysis_date"] != evidence["analysis_date"]
        or value["revision_status"] != "unknown"
        or value["calendar_coverage_status"] != "unknown"
    ):
        _fail()
    observed = _utc(value["observed_at"])
    if not _utc(policy["research_started_at"]) <= observed <= _utc(policy["research_as_of"]):
        _fail()
    if observed > datetime.fromisoformat(record["fetched_at"].replace("Z", "+00:00")):
        _fail()
    # The typed assessment is local calculation, but must name its actual input provider.
    if value["provider"] not in PRICE_PROVIDERS or not any(
        source["provider"] == value["provider"] for source in _observed_sources(record, evidence)
    ):
        _fail()
    zone = value["source_timezone"]
    if zone is not None and (not isinstance(zone, str) or not zone or len(zone) > 128):
        _fail()
    if value["timezone_origin"] not in {
        "timestamp",
        "provider_metadata",
        "symbol_market_convention",
        "unknown",
    }:
        _fail()
    _keys(value["requested_window"], {"start", "end"})
    window = value["requested_window"]
    if _day(window["end"]) > _day(evidence["analysis_date"]):
        _fail()
    if window["start"] is not None and _day(window["start"]) > _day(window["end"]):
        _fail()
    if value["integrity_status"] not in {"valid", "invalid", "empty"} or value[
        "completion_status"
    ] not in {"complete_provider_daily_rows", "provisional", "unknown", "empty"}:
        _fail()
    _keys(value["price_basis"], {"status", "value"})
    basis = value["price_basis"]
    if basis["status"] == "observed":
        if not isinstance(basis["value"], str) or not basis["value"] or len(basis["value"]) > 1024:
            _fail()
    elif basis != {"status": "unknown", "value": None}:
        _fail()
    rows = value["rows"]
    count_keys = {
        "received",
        "in_window",
        "valid",
        "invalid",
        "identical_duplicates_collapsed",
        "provisional",
        "unknown_completion",
        "usable_complete",
    }
    _keys(
        rows,
        count_keys | {"conflicting_duplicate_dates", "latest_received_date", "latest_usable_date"},
    )
    for key in count_keys:
        _integer(rows[key], 0, 1000000)
        if rows[key] > rows["received"]:
            _fail()
    if rows["usable_complete"] + rows["provisional"] + rows["unknown_completion"] != rows["valid"]:
        _fail()
    conflicts = rows["conflicting_duplicate_dates"]
    if not isinstance(conflicts, list) or conflicts != sorted(set(conflicts)):
        _fail()
    for label in conflicts:
        if _day(label) > _day(evidence["analysis_date"]):
            _fail()
    for key in ("latest_received_date", "latest_usable_date"):
        if rows[key] is not None and _day(rows[key]) > _day(evidence["analysis_date"]):
            _fail()
    if bool(rows["usable_complete"]) != (rows["latest_usable_date"] is not None):
        _fail()
    if rows["latest_usable_date"] is not None and (
        rows["latest_received_date"] is None
        or rows["latest_usable_date"] > rows["latest_received_date"]
    ):
        _fail()
    if value["integrity_status"] != (
        "invalid" if rows["invalid"] else "valid" if rows["valid"] else "empty"
    ):
        _fail()
    issues = value["issues"]
    if (
        not isinstance(issues, list)
        or issues != sorted(set(issues))
        or any(item not in QUALITY_ISSUES for item in issues)
    ):
        _fail()
    indicators = value["indicator_assessments"]
    if not isinstance(indicators, dict) or len(indicators) > 128:
        _fail()
    for name, item in indicators.items():
        if not isinstance(name, str) or not name or len(name) > 128:
            _fail()
        _keys(item, {"status", "required_rows", "usable_rows", "value"})
        if item["status"] not in {
            "available",
            "insufficient_warmup",
            "unavailable_input",
            "unsupported",
            "calculation_failed",
        }:
            _fail()
        expected = INDICATOR_ROWS.get(name, 14 if name == "vwma" else None)
        if item["required_rows"] != expected or (
            expected is not None and type(item["required_rows"]) is not int
        ):
            _fail()
        if type(item["usable_rows"]) is not int or item["usable_rows"] != rows["usable_complete"]:
            _fail()
        if item["status"] == "available":
            if (
                expected is None
                or item["usable_rows"] < expected
                or type(item["value"]) not in {int, float}
                or not math.isfinite(item["value"])
            ):
                _fail()
        elif item["value"] is not None:
            _fail()
    validate_market_observations(value, record, evidence)
    return value


def _refs(records):
    return sorted(record["id"] for record in records), sorted(
        {
            source["data_sha256"]
            for record in records
            for source in record["sources"]
            if source["data_sha256"]
        }
    )


def _observed_sources(record, evidence):
    return [
        source
        for source in record["sources"]
        if source["provider"] not in {"unknown", "local_calculation"}
        and source["historical_availability"] != "withheld"
        and source["data_sha256"]
        and _has_observed_data(
            {source["data_sha256"]: evidence["artifacts"][source["data_sha256"]]}
        )
    ]


def _check(key, required, records, findings=()):
    ids, hashes = _refs(records)
    findings = list(findings)
    precedence = ("invalid", "unavailable", "missing", "partial", "unknown", "not_selected")
    status = next(
        (item for item in precedence if any(finding[0] == item for finding in findings)), "passed"
    )
    return {
        "key": key,
        "required": required,
        "status": status,
        "reason_codes": sorted({reason for _, reason in findings}),
        "evidence_ids": ids,
        "artifact_sha256s": hashes,
    }


def _receipt_findings(record):
    return {
        "available": [],
        "unavailable": [("unavailable", "provider_unavailable")],
        "withheld": [("unavailable", "source_withheld")],
        "empty": [("missing", "empty_observations")],
        "partial": [("partial", "partial_observations")],
    }[record["status"]]


def _derive(evidence, policy):
    records = sorted(evidence["records"], key=lambda item: item["id"])
    inputs = [
        {
            "record_id": record["id"],
            "output_sha256": record["output_sha256"],
            "data_sha256s": _refs([record])[1],
        }
        for record in records
    ]
    mode = policy["temporal_mode"]
    temporal = []
    if mode != "same_host_date":
        temporal.append(
            (
                "unknown",
                "historical_availability_unknown"
                if mode == "historical_date_only"
                else "future_analysis_date",
            )
        )
    elif any(
        datetime.fromisoformat(record["fetched_at"].replace("Z", "+00:00"))
        > _utc(policy["research_as_of"])
        for record in records
    ):
        temporal.append(("unknown", "historical_availability_unknown"))
    checks = [_check("temporal_availability", True, records, temporal)]
    market = [
        record
        for record in records
        if record["analyst"] == "market"
        and record["tool"] == "get_verified_market_snapshot"
        and record["parameters"].get("symbol") == evidence["instrument"]
        and record["parameters"].get("curr_date") == evidence["analysis_date"]
    ]
    market_findings, indicator_findings, bases = [], [], set()
    if "market" not in policy["selected_analysts"]:
        market_findings = [("not_selected", "market_not_selected")]
    elif not market:
        market_findings = [("missing", "missing_required_verification")]
    else:
        for record in market:
            market_findings.extend(_receipt_findings(record))
            quality = []
            malformed = False
            for digest in _refs([record])[1]:
                try:
                    value = parse_json(evidence["artifacts"][digest]["payload"])
                    if (
                        isinstance(value, dict)
                        and value.get("kind") == "market_verification_quality"
                    ):
                        if not any(
                            source["data_sha256"] == digest
                            and source["provider"] == "local_calculation"
                            for source in record["sources"]
                        ):
                            _fail()
                        quality.append(_quality(value, record, evidence, policy))
                except (ValueError, TypeError, OverflowError, KeyError):
                    malformed = True
            if malformed or len(quality) != 1:
                market_findings.append(("unknown", "verification_quality_unknown"))
                indicator_findings.append(("unknown", "verification_quality_unknown"))
                continue
            value = quality[0]
            rows = value["rows"]
            if value["integrity_status"] == "invalid":
                market_findings.append(("invalid", "invalid_ohlcv"))
            if rows["conflicting_duplicate_dates"]:
                market_findings.append(("invalid", "conflicting_daily_rows"))
            if value["integrity_status"] == "empty":
                market_findings.append(("missing", "empty_observations"))
            if (
                rows["unknown_completion"]
                or value["source_timezone"] is None
                or value["timezone_origin"] == "unknown"
            ):
                market_findings.append(("unknown", "unknown_bar_completion"))
            if not rows["usable_complete"]:
                market_findings.append(
                    ("partial", "provisional_daily_rows")
                    if rows["provisional"]
                    else ("unknown", "unknown_bar_completion")
                )
            elif (_day(evidence["analysis_date"]) - _day(rows["latest_usable_date"])).days > policy[
                "max_complete_row_age_days"
            ]:
                market_findings.append(("unknown", "stale_or_unknown_session_coverage"))
            if value["price_basis"]["status"] == "unknown":
                market_findings.append(("unknown", "unknown_price_basis"))
            else:
                bases.add(value["price_basis"]["value"])
            for name in policy["required_indicators"]:
                item = value["indicator_assessments"].get(name)
                state = item["status"] if item else "unavailable_input"
                if state != "available":
                    indicator_findings.append(
                        {
                            "insufficient_warmup": ("partial", "insufficient_indicator_history"),
                            "unsupported": ("partial", "unsupported_indicator"),
                            "calculation_failed": ("partial", "indicator_calculation_failed"),
                            "unavailable_input": ("unknown", "verification_quality_unknown"),
                        }[state]
                    )
    if len(bases) > 1:
        market_findings.append(("unknown", "price_basis_conflict"))
    checks.append(_check("market_verification", True, market, market_findings))
    checks.append(_check("indicator_warmup", True, market, [*market_findings, *indicator_findings]))
    for analyst in policy["selected_analysts"]:
        selected = [record for record in records if record["analyst"] == analyst]
        findings = [finding for record in selected for finding in _receipt_findings(record)]
        if not selected:
            findings.append(("missing", "missing_selected_source"))
        elif not any(
            record["status"] == "available" and _observed_sources(record, evidence)
            for record in selected
        ):
            findings.append(("unknown", "unknown_source_provenance"))
        for record in selected:
            if record["status"] == "available" and not _observed_sources(record, evidence):
                findings.append(("unknown", "unknown_source_provenance"))
        checks.append(_check(f"selected_sources.{analyst}", True, selected, findings))
    checks.extend(
        [
            _check("price_vintage", False, market, [("unknown", "unknown_price_vintage")]),
            _check(
                "exchange_calendar_coverage",
                False,
                market,
                [("unknown", "unknown_exchange_calendar")],
            ),
        ]
    )
    required = [check["status"] for check in checks if check["required"]]
    status = (
        "ready"
        if all(item == "passed" for item in required)
        else "insufficient_evidence"
        if any(item in {"missing", "unavailable", "invalid"} for item in required)
        else "review_required"
    )
    return make_component(
        {
            "schema_version": 1,
            "run_id": evidence["run_id"],
            "instrument": evidence["instrument"],
            "analysis_date": evidence["analysis_date"],
            "policy": policy,
            "evidence_inputs": inputs,
            "checks": checks,
            "status": status,
            "recommendation_allowed": status == "ready",
        },
        "assessment_sha256",
    )


def assess_readiness(evidence, policy):
    bundle = validate_evidence_bundle(evidence)
    frozen = validate_policy(policy, bundle)
    return _derive(bundle, frozen)


def validate_readiness(value, evidence, *, rating=None, final_text=None):
    try:
        _keys(
            value,
            {
                "schema_version",
                "run_id",
                "instrument",
                "analysis_date",
                "policy",
                "evidence_inputs",
                "checks",
                "status",
                "recommendation_allowed",
                "assessment_sha256",
            },
        )
        bundle = validate_evidence_bundle(evidence)
        policy = validate_policy(value["policy"], bundle)
        if (
            type(value["schema_version"]) is not int
            or type(value["recommendation_allowed"]) is not bool
        ):
            _fail()
        if canonical_json(value) != canonical_json(_derive(bundle, policy)):
            _fail()
        if not value["recommendation_allowed"]:
            from tradingagents.agents.utils.rating import extract_rating

            if rating is not None and rating != "REVIEW":
                _fail()
            if final_text is not None and extract_rating(final_text) != "REVIEW":
                _fail()
        # Ensure bounded JSON and reject duplicate-key/nonfinite artifact input above.
        if len(canonical_json(value).encode("utf-8")) > 64 * 1024 * 1024:
            _fail()
        return deepcopy(value)
    except (ValueError, TypeError, KeyError, OverflowError, AttributeError, RecursionError):
        _fail()


def withheld_decision(assessment):
    reasons = sorted(
        {
            reason
            for check in assessment["checks"]
            if check["required"] and check["status"] != "passed"
            for reason in check["reason_codes"]
        }
    )
    refs = sorted(
        {
            item
            for check in assessment["checks"]
            if check["required"]
            for item in check["evidence_ids"]
        }
    )
    return (
        "Rating: REVIEW\n\n"
        "Research input checks require human review before a directional recommendation.\n"
        "Reasons: " + ", ".join(reasons) + ".\n"
        "Earlier analyst reports and debate remain exploratory research.\n"
        + (
            "Saved input references: " + " ".join(f"[E:{item}]" for item in refs)
            if refs
            else "No required source receipt was recorded."
        )
    )
