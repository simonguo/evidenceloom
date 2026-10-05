"""One explicit two-row saved-price percentage oracle; no financial inference."""

from __future__ import annotations

from copy import deepcopy
from fractions import Fraction
import re
from uuid import NAMESPACE_URL, uuid5

from tradingagents.research.numeric_decimal import decimal_parts, equal_decimal
from tradingagents.research.numeric_review import (
    _PreparedNumericInput,
    date_component,
    derive_numeric_review,
)
from tradingagents.research.numeric_spans import (
    span_text,
    supported_context_span,
    supported_numeric_span,
)

from .policy import FROZEN_CLAIM_EVALUATION_POLICY

_PERCENT = re.compile(r"[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?%\Z", re.ASCII)
_STATUS = {
    "match": "MATCH",
    "mismatch": "MISMATCH",
    "missing": "MISSING",
    "manual_inference": "MANUAL",
}


def _fraction(lexeme):
    parts = decimal_parts(lexeme)
    if parts is None:
        return None
    coefficient, power = parts
    return (
        Fraction(coefficient * 10**power, 1)
        if power >= 0
        else Fraction(coefficient, 10 ** (-power))
    )


def exact_price_change_percent(start_lexeme, end_lexeme, places):
    """Exact saved lexemes, positive prices, and a single final quantization."""
    if type(places) is not int or not 0 <= places <= 18:
        return None
    a, b = _fraction(start_lexeme), _fraction(end_lexeme)
    if a is None or b is None or a <= 0 or b <= 0:
        return None
    value = (b - a) / a * 100
    scaled = abs(value) * 10**places
    rounded, remainder = divmod(scaled.numerator, scaled.denominator)
    if remainder * 2 >= scaled.denominator:
        rounded += 1
    digits = str(rounded).rjust(places + 1, "0")
    result = digits if places == 0 else digits[:-places] + "." + digits[-places:]
    return ("-" if value < 0 and rounded else "") + result


def _percent_supported(section, span):
    literal, prefix, suffix = span_text(section, span)
    if _PERCENT.fullmatch(literal) is None or decimal_parts(literal[:-1]) is None:
        return False
    # Reuse the unchanged Numericv1 whole-number boundary rules, removing only
    # this claimed percent sign from the local text. A second sign/scale remains.
    number_span = {**span, "end_byte": span["end_byte"] - 1, "text": literal[:-1]}
    return supported_numeric_span(prefix + literal[:-1] + suffix, number_span)


def _context(section, bindings, expected):
    result = {}
    for key, binding in bindings.items():
        result[key] = (
            "unknown"
            if binding is None
            else "missing"
            if expected[key] is None or not supported_context_span(section, binding)
            else "match_declared_literal"
            if binding["text"] == expected[key]
            else "mismatch"
        )
    return result


def saved_field(report, claim, case_id):
    selection, snapshot = claim["selection"], report["report_text_snapshot"]
    request = {
        "review_id": str(uuid5(NAMESPACE_URL, "frozen-claim:" + case_id + ":" + claim["claim_id"])),
        "reviewed_at": snapshot["captured_at"],
        "previous_review_sha256": None,
        "target": deepcopy(claim["target"]),
        "numeric_span": deepcopy(claim["span"]),
        **deepcopy(selection),
    }
    request["operand"] = {
        key: request["operand"][key] for key in ("evidence_id", "source_index", "selector")
    }
    witness = derive_numeric_review(snapshot, report["evidence_bundle"], request)
    return _STATUS[witness["result"]["status"]], witness["result"]["reason"], witness


def price_change_percent(report, claim):
    selection = claim["selection"]
    snapshot, evidence = report["report_text_snapshot"], report["evidence_bundle"]
    section = snapshot["report_sections"][claim["target"]["section_key"]]
    prepared = _PreparedNumericInput(snapshot, evidence)
    operands = selection["operands"]
    selected = [prepared.selected(operand) for operand in operands]
    source = selected[0][0]
    a, b = operands
    supported_family = (
        a["evidence_id"] == b["evidence_id"]
        and a["source_index"] == b["source_index"]
        and a["selector"]["table_path"] == b["selector"]["table_path"]
        and a["selector"]["field"] == b["selector"]["field"]
        and a["selector"]["field"] in {"Close", "Adj Close"}
        and source == selected[1][0]
    )
    lexemes = [item[1] for item in selected]
    local_dates = [date_component(operand["selector"]["row_date"]) for operand in operands]
    expected_context = {
        "instrument": snapshot["instrument"],
        "start_date": local_dates[0],
        "end_date": local_dates[1],
        "units": source["units"],
        "basis": source["adjustments"],
    }
    contexts = _context(section, selection["context_bindings"], expected_context)
    rounded, reason = None, None
    for item in selected:
        if item[3] is not None:
            reason = item[3]
            break
    window = source["observed_window"]
    temporal_scope = {
        "comparison": "source_label_local_date_component_only",
        "research_cutoff_date": evidence["analysis_date"],
        "declared_observed_window": deepcopy(window),
        "selected_local_dates": local_dates,
        "exchange_calendar_verified": False,
        "historical_vintage_verified": False,
    }
    if not supported_family:
        reason = "operation_outside_supported_family"
    if reason is None:
        if any(d is None for d in local_dates):
            reason = "date_label_unsupported"
        elif local_dates[0] >= local_dates[1]:
            reason = "nonchronological_rows"
        elif any(d > evidence["analysis_date"] for d in local_dates):
            reason = "row_after_research_cutoff"
        elif window is not None and any(
            not window["start"] <= d <= window["end"] for d in local_dates
        ):
            reason = "row_outside_declared_window"
        elif any(_fraction(lexeme) is None for lexeme in lexemes):
            reason = "number_unsupported"
        elif any(_fraction(lexeme) <= 0 for lexeme in lexemes):
            reason = "nonpositive_price"
        else:
            rounded = exact_price_change_percent(*lexemes, selection["rounding"]["places"])
    supported = _percent_supported(section, claim["span"])
    if not supported_family:
        status, reason = "MANUAL", "operation_outside_supported_family"
    elif "mismatch" in contexts.values():
        status, reason = "MISMATCH", "context_mismatch"
    elif reason is not None:
        status = (
            "MANUAL"
            if reason
            in {
                "operation_outside_supported_family",
                "number_unsupported",
                "date_label_unsupported",
                "nonchronological_rows",
                "nonpositive_price",
            }
            else "MISSING"
        )
    elif not supported:
        status, reason = "MANUAL", "selection_unsupported"
    elif rounded is not None and not equal_decimal(claim["span"]["text"][:-1], rounded):
        status, reason = "MISMATCH", "value_mismatch"
    elif "missing" in contexts.values():
        status, reason = "MISSING", "context_missing"
    else:
        status, reason = "MATCH", "value_match"
    witness = {
        "operation": "price_change_percent",
        "formula": "100*(end-start)/start",
        "operands": [
            {
                **deepcopy(operand),
                "provider": item[0]["provider"],
                "data_sha256": item[0]["data_sha256"],
                "raw_number_lexeme": item[1],
                "original_row_label": item[2],
            }
            for operand, item in zip(operands, selected)
        ],
        "rounding": deepcopy(selection["rounding"]),
        "rounded_decimal": rounded,
        "context_results": contexts,
        "source_context": {
            key: deepcopy(source[key])
            for key in (
                "provider",
                "units",
                "adjustments",
                "historical_availability",
                "transformations",
            )
        },
        "temporal_scope": temporal_scope,
        "unreviewed_dimensions": [
            *FROZEN_CLAIM_EVALUATION_POLICY["unreviewed_dimensions"],
            *(key for key, result in contexts.items() if result in {"unknown", "missing"}),
        ],
    }
    return status, reason, witness
