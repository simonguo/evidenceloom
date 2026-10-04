"""Deterministic selected saved numeric field reviews; no provider/model calls.

Raw JSON number lexemes, report UTF-8 bytes and source metadata are retained.
A numeric match never certifies surrounding prose or independent source truth.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timezone
import hashlib
import json
import re
from uuid import UUID

from tradingagents.evidence import audit_citations, sanitize_diagnostic, validate_evidence_bundle
from tradingagents.evidence.ledger import _timestamp
from tradingagents.memory.schema import canonical_json, hash_component, make_component, _safe
from .numeric_decimal import decimal_parts, equal_decimal, round_saved_decimal
from .numeric_spans import span_text, supported_context_span, supported_numeric_span

REPORT_SECTION_KEYS = (
    "market_report",
    "sentiment_report",
    "news_report",
    "fundamentals_report",
    "investment_plan",
    "trader_investment_plan",
    "final_trade_decision",
)
NUMERIC_REVIEW_POLICY = {
    "policy_version": "saved-numeric-field-v1",
    "scope": "selected_saved_numeric_field",
    "operation": "field_value",
    "rounding_mode": "saved_decimal_half_up",
    "rounded_zero_sign": "positive",
    "max_decimal_places": 18,
    "max_number_bytes": 256,
    "max_coefficient_digits": 128,
    "max_abs_exponent": 1024,
    "max_section_bytes": 1048576,
    "max_table_rows": 100000,
    "max_table_columns": 256,
    "max_reviews_per_version": 1000,
    "span_encoding": "utf8_half_open",
    "context_comparison": "exact_bound_literal_only",
    "table_paths": [[], ["latest_ohlcv"], ["recent_closes"]],
    "unreviewed_dimensions": [
        "surrounding_prose",
        "source_reliability",
        "historical_vintage",
        "indicator_method",
        "prediction",
        "causality",
    ],
}
POLICY_SHA256 = hashlib.sha256(canonical_json(NUMERIC_REVIEW_POLICY).encode("utf-8")).hexdigest()
REASONS = frozenset(
    {
        "value_match",
        "value_mismatch",
        "context_mismatch",
        "context_missing",
        "source_unavailable",
        "source_withheld",
        "table_missing",
        "table_ambiguous",
        "row_missing",
        "row_ambiguous",
        "field_missing",
        "field_not_numeric",
        "number_unsupported",
        "selection_unsupported",
    }
)
_SHA = re.compile(r"[a-f0-9]{64}\Z")
_ID = re.compile(r"ev-[a-f0-9]{32}\Z")
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\Z")
_LABEL = re.compile(
    r"([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?\Z"
)


class NumericReviewError(ValueError):
    def __init__(self):
        super().__init__("Invalid or conflicting saved numeric review")


def _fail():
    raise NumericReviewError()


def _shape(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        _fail()


def _text(value, *, limit=1048576, nonempty=False):
    if not isinstance(value, str) or (nonempty and not value):
        _fail()
    if len(value.encode("utf-8")) > limit:
        _fail()
    return value


def _uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        _fail()


def _sha(value, *, nullable=False):
    if nullable and value is None:
        return
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        _fail()


def _utc(value):
    if not isinstance(value, str) or not _UTC.fullmatch(value):
        _fail()
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def now_utc():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def public_report_copy(state, *, secrets=()):
    """Redact report/debate text copies, preserving hash-bearing attachments."""
    result = deepcopy(state)
    for key in (*REPORT_SECTION_KEYS, "trader_investment_decision"):
        if isinstance(result.get(key), str):
            result[key] = sanitize_diagnostic(result[key], secrets=secrets)
    for key in ("investment_debate_state", "risk_debate_state"):
        debate = result.get(key)
        if isinstance(debate, dict):
            for field, text in debate.items():
                if isinstance(text, str):
                    debate[field] = sanitize_diagnostic(text, secrets=secrets)
    return result


def _checked(operation):
    try:
        return operation()
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        OverflowError,
        RecursionError,
        UnicodeError,
        AttributeError,
    ):
        raise NumericReviewError() from None


def _snapshot(value, evidence):
    _shape(
        value,
        {
            "schema_version",
            "run_id",
            "instrument",
            "analysis_date",
            "captured_at",
            "evidence_bundle_sha256",
            "report_sections",
            "snapshot_sha256",
        },
    )
    _safe(value)
    if type(value["schema_version"]) is not int or value["schema_version"] != 1:
        _fail()
    _uuid(value["run_id"])
    for key in ("run_id", "instrument", "analysis_date"):
        if value[key] != evidence[key]:
            _fail()
    if value["evidence_bundle_sha256"] != evidence["bundle_sha256"]:
        _fail()
    captured = _utc(value["captured_at"])
    if captured < _timestamp(evidence["created_at"]) or any(
        captured < _timestamp(record["fetched_at"]) for record in evidence["records"]
    ):
        _fail()
    _shape(value["report_sections"], REPORT_SECTION_KEYS)
    for section in value["report_sections"].values():
        if section is not None:
            _text(section)
    audited = audit_citations(evidence, value["report_sections"])
    empty = {"referenced_ids": [], "unresolved_ids": [], "status": "none"}
    if any(
        evidence["citation_audit"].get(key, empty) != audited["citation_audit"][key]
        for key in REPORT_SECTION_KEYS
    ):
        _fail()
    _sha(value["snapshot_sha256"])
    if hash_component(value, "snapshot_sha256") != value["snapshot_sha256"]:
        _fail()
    return deepcopy(value)


def validate_report_text_snapshot(value, evidence):
    return _checked(lambda: _snapshot(value, validate_evidence_bundle(evidence)))


def make_report_text_snapshot(evidence, report_sections, *, captured_at=None):
    def make():
        bundle = validate_evidence_bundle(evidence)
        if not isinstance(report_sections, dict):
            _fail()
        snapshot = make_component(
            {
                "schema_version": 1,
                "run_id": bundle["run_id"],
                "instrument": bundle["instrument"],
                "analysis_date": bundle["analysis_date"],
                "captured_at": captured_at or now_utc(),
                "evidence_bundle_sha256": bundle["bundle_sha256"],
                "report_sections": {key: report_sections.get(key) for key in REPORT_SECTION_KEYS},
            },
            "snapshot_sha256",
        )
        return _snapshot(snapshot, bundle)

    return _checked(make)


class RawNumber(str):
    """Distinguish original JSON number tokens from strings and booleans."""


def _duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail()
        result[key] = value
    return result


def parse_saved_numbers(payload):
    """A bounded lossless parser; duplicate keys and non-JSON numbers invalid."""

    def parse():
        _text(payload, limit=64 * 1024 * 1024)
        value = json.loads(
            payload,
            parse_int=RawNumber,
            parse_float=RawNumber,
            parse_constant=lambda _: _fail(),
            object_pairs_hook=_duplicates,
        )

        def depth(item, level=0):
            if level > 64:
                _fail()
            if isinstance(item, dict):
                for child in item.values():
                    depth(child, level + 1)
            elif isinstance(item, list):
                for child in item:
                    depth(child, level + 1)

        depth(value)
        return value

    return _checked(parse)


def date_component(label):
    if not isinstance(label, str) or not _LABEL.fullmatch(label):
        return None
    try:
        day = date.fromisoformat(label[:10])
        if len(label) > 10:
            # Validate calendar/time components independently of Python's
            # version-specific fractional-second parser. The original 1–9
            # digit fraction remains untouched; only the local date is used.
            datetime(
                day.year,
                day.month,
                day.day,
                int(label[11:13]),
                int(label[14:16]),
                int(label[17:19]),
            )
            offset = re.search(r"([+-])([0-9]{2}):([0-9]{2})$", label)
            if offset and (
                int(offset[2]) > 14
                or int(offset[3]) > 59
                or (int(offset[2]) == 14 and int(offset[3]))
                or label.endswith("-00:00")
            ):
                return None
        return day.isoformat()
    except ValueError:
        return None


def _cell(payload, selector):
    table = parse_saved_numbers(payload)
    for key in selector["table_path"]:
        if not isinstance(table, dict) or key not in table:
            return None, None, "table_missing"
        table = table[key]
    if not isinstance(table, dict) or not {"columns", "rows"}.issubset(table):
        return None, None, "table_missing"
    columns, rows = table["columns"], table["rows"]
    if (
        not isinstance(columns, list)
        or not 1 <= len(columns) <= 256
        or not all(type(c) is str and c for c in columns)
        or not isinstance(rows, list)
        or len(rows) > 100000
        or any(not isinstance(row, list) or len(row) != len(columns) for row in rows)
    ):
        return None, None, "table_missing"
    if len(set(columns)) != len(columns):
        return None, None, "table_ambiguous"
    if "Date" not in columns:
        return None, None, "table_missing"
    date_index = columns.index("Date")
    labels = [row[date_index] for row in rows]
    if not all(type(label) is str for label in labels):
        return None, None, "table_missing"
    if len(set(labels)) != len(labels):
        return None, None, "row_ambiguous"
    if selector["row_date"] not in labels or date_component(selector["row_date"]) is None:
        return None, None, "row_missing"
    actual_date = selector["row_date"]
    if selector["field"] not in columns:
        return None, actual_date, "field_missing"
    cell = rows[labels.index(actual_date)][columns.index(selector["field"])]
    if not isinstance(cell, RawNumber):
        return None, actual_date, "field_not_numeric"
    if decimal_parts(str(cell)) is None:
        return None, actual_date, "number_unsupported"
    return str(cell), actual_date, None


def _request(value, snapshot):
    _shape(
        value,
        {
            "review_id",
            "reviewed_at",
            "previous_review_sha256",
            "target",
            "numeric_span",
            "operand",
            "rounding",
            "context_bindings",
        },
    )
    _safe(value)
    _uuid(value["review_id"])
    if _utc(value["reviewed_at"]) < _utc(snapshot["captured_at"]):
        _fail()
    _sha(value["previous_review_sha256"], nullable=True)
    target = value["target"]
    _shape(
        target,
        {
            "task_id",
            "version_id",
            "run_id",
            "report_snapshot_sha256",
            "section_key",
            "section_utf8_sha256",
        },
    )
    _text(target["task_id"], limit=256, nonempty=True)
    _text(target["version_id"], limit=256, nonempty=True)
    if (
        target["run_id"] != snapshot["run_id"]
        or target["report_snapshot_sha256"] != snapshot["snapshot_sha256"]
        or target["section_key"] not in REPORT_SECTION_KEYS
    ):
        _fail()
    section = snapshot["report_sections"][target["section_key"]]
    if (
        section is None
        or target["section_utf8_sha256"] != hashlib.sha256(section.encode()).hexdigest()
    ):
        _fail()
    span_text(section, value["numeric_span"])
    operand = value["operand"]
    _shape(operand, {"evidence_id", "source_index", "selector"})
    if not isinstance(operand["evidence_id"], str) or not _ID.fullmatch(operand["evidence_id"]):
        _fail()
    if type(operand["source_index"]) is not int or not 0 <= operand["source_index"] < 1024:
        _fail()
    selector = operand["selector"]
    _shape(selector, {"kind", "table_path", "row_date", "field"})
    if (
        selector["kind"] != "table_cell"
        or selector["table_path"] not in NUMERIC_REVIEW_POLICY["table_paths"]
    ):
        _fail()
    _text(selector["row_date"], limit=256, nonempty=True)
    _text(selector["field"], limit=256, nonempty=True)
    _shape(value["rounding"], {"mode", "places"})
    if (
        value["rounding"]["mode"] != "saved_decimal_half_up"
        or type(value["rounding"]["places"]) is not int
        or not 0 <= value["rounding"]["places"] <= 18
    ):
        _fail()
    _shape(value["context_bindings"], {"instrument", "row_date", "units"})
    for binding in value["context_bindings"].values():
        if binding is not None:
            span_text(section, binding)
    return section


def _derive(snapshot, evidence, request):
    section = _request(request, snapshot)
    operand = request["operand"]
    matches = [r for r in evidence["records"] if r["id"] == operand["evidence_id"]]
    if len(matches) != 1 or operand["source_index"] >= len(matches[0]["sources"]):
        _fail()
    record = matches[0]
    if record["instrument"] != snapshot["instrument"]:
        _fail()
    source = record["sources"][operand["source_index"]]
    lexeme, label, reason = None, None, None
    if source["historical_availability"] == "withheld" or record["status"] == "withheld":
        reason = "source_withheld"
    elif record["status"] not in {"available", "partial"}:
        reason = "source_unavailable"
    elif source["data_sha256"] is None:
        reason = "table_missing"
    else:
        artifact = evidence["artifacts"][source["data_sha256"]]
        if artifact["kind"] != "normalized_data":
            _fail()
        lexeme, label, reason = _cell(artifact["payload"], operand["selector"])
    context = {
        "instrument": snapshot["instrument"],
        "row_date": label,
        "units": source["units"],
        "provider": source["provider"],
        "historical_availability": source["historical_availability"],
        "adjustments": source["adjustments"],
        "transformations": deepcopy(source["transformations"]),
    }
    expected_context = {
        "instrument": snapshot["instrument"],
        "row_date": date_component(label),
        "units": source["units"],
    }
    context_results = {}
    for key, binding in request["context_bindings"].items():
        context_results[key] = (
            "unreviewed"
            if binding is None
            else "missing"
            if expected_context[key] is None or not supported_context_span(section, binding)
            else "match"
            if binding["text"] == expected_context[key]
            else "mismatch"
        )
    rounded = None if lexeme is None else round_saved_decimal(lexeme, request["rounding"]["places"])
    selected = request["numeric_span"]["text"]
    supported = supported_numeric_span(section, request["numeric_span"])
    comparable = supported and decimal_parts(selected) is not None and rounded is not None
    if "mismatch" in context_results.values():
        status, reason = "mismatch", "context_mismatch"
    elif comparable and not equal_decimal(selected, rounded):
        status, reason = "mismatch", "value_mismatch"
    elif "missing" in context_results.values():
        status, reason = "missing", "context_missing"
    elif reason is not None and reason != "number_unsupported":
        status = "missing"
    elif not supported:
        status, reason = "manual_inference", "selection_unsupported"
    elif not comparable:
        status, reason = "manual_inference", "number_unsupported"
    else:
        status, reason = "match", "value_match"
    review = {
        "schema_version": 1,
        **deepcopy(request),
        "policy_version": NUMERIC_REVIEW_POLICY["policy_version"],
        "policy_sha256": POLICY_SHA256,
        "scope": NUMERIC_REVIEW_POLICY["scope"],
        "result": {
            "status": status,
            "reason": reason,
            "rounded_decimal": rounded,
            "context_results": context_results,
            "unreviewed_dimensions": [
                *NUMERIC_REVIEW_POLICY["unreviewed_dimensions"],
                *(
                    key
                    for key in ("instrument", "row_date", "units")
                    if context_results[key] in {"unreviewed", "missing"}
                ),
            ],
            "source_context": context,
        },
    }
    review["operand"].update(
        {
            "provider": source["provider"],
            "data_sha256": source["data_sha256"],
            "raw_number_lexeme": lexeme,
        }
    )
    return make_component(review, "review_sha256")


def derive_numeric_review(snapshot, evidence, request):
    def derive():
        bundle = validate_evidence_bundle(evidence)
        return _derive(_snapshot(snapshot, bundle), bundle, request)

    return _checked(derive)


def validate_numeric_review(review, snapshot, evidence, *, task_id=None, version_id=None):
    def validate():
        _shape(
            review,
            {
                "schema_version",
                "review_id",
                "reviewed_at",
                "previous_review_sha256",
                "policy_version",
                "policy_sha256",
                "scope",
                "target",
                "numeric_span",
                "operand",
                "rounding",
                "context_bindings",
                "result",
                "review_sha256",
            },
        )
        _safe(review)
        _shape(
            review["operand"],
            {
                "evidence_id",
                "source_index",
                "provider",
                "data_sha256",
                "selector",
                "raw_number_lexeme",
            },
        )
        if hash_component(review, "review_sha256") != review["review_sha256"]:
            _fail()
        request = {
            key: deepcopy(review[key])
            for key in (
                "review_id",
                "reviewed_at",
                "previous_review_sha256",
                "target",
                "numeric_span",
                "rounding",
                "context_bindings",
            )
        }
        request["operand"] = {
            key: deepcopy(review["operand"][key])
            for key in ("evidence_id", "source_index", "selector")
        }
        expected = derive_numeric_review(snapshot, evidence, request)
        # Canonical comparison also rejects bool/int equivalence in outer fields.
        if canonical_json(review) != canonical_json(expected):
            _fail()
        if (
            task_id is not None
            and review["target"]["task_id"] != task_id
            or version_id is not None
            and review["target"]["version_id"] != version_id
        ):
            _fail()
        return expected

    return _checked(validate)


def validate_numeric_reviews(reviews, snapshot, evidence, *, task_id, version_id):
    def validate():
        if not isinstance(reviews, list) or len(reviews) > 1000:
            _fail()
        result, ids, previous, time = [], set(), None, None
        for review in reviews:
            checked = validate_numeric_review(
                review, snapshot, evidence, task_id=task_id, version_id=version_id
            )
            current = _utc(checked["reviewed_at"])
            if (
                checked["review_id"] in ids
                or checked["previous_review_sha256"] != previous
                or time is not None
                and current < time
            ):
                _fail()
            ids.add(checked["review_id"])
            previous, time = checked["review_sha256"], current
            result.append(checked)
        return result

    return _checked(validate)
