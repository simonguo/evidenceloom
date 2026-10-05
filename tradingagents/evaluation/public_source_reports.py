"""Offline engineering reports bound to original monthly public-source cells.

This separate protocol does not reinterpret saved stock/crypto exports, Numeric,
Evidence or fictional frozen packs. Hashes bind supplied artifacts; they do not
authenticate authors, providers, historical vintages or surrounding prose.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import re

from tradingagents.memory.schema import canonical_json, make_component, parse_json
from tradingagents.research.numeric_spans import (
    span_text,
    supported_context_span,
    supported_numeric_span,
)

from .guards import bounded, component, fail, identifier, integer, shape, text, timestamp, uuid
from .public_sources import MAX_SOURCE_BYTES, derive_bls_table, validate_corpus

MAX_REPORT_BYTES = 1024 * 1024
MAX_CASE_BYTES = 1024 * 1024
POLICY = {
    "policy_version": "public-source-report-cell-literals-v1",
    "scope": "explicit_selected_current_snapshot_cell_literals",
    "comparison": "original_decimal_string_equality_no_rounding",
    "span_encoding": "full_text_original_utf8_half_open",
    "denominator": "all_declared_claims_in_input_order",
    "max_claims": 100,
    "metadata_authority": "manifest_declarations_only",
    "semantic_support": "NOT_EVALUATED",
    "provider_origin": "NOT_AUTHENTICATED",
    "historical_authority": "UNAVAILABLE",
    "expert_approved_claim_denominator": 0,
}
POLICY_SHA256 = hashlib.sha256(canonical_json(POLICY).encode("utf-8")).hexdigest()
UNKNOWN_AUTHORITY = {
    "provider_origin": "NOT_AUTHENTICATED",
    "historical_vintage": "unknown",
    "publication_time": None,
    "first_public_availability": None,
    "first_public_availability_status": "unknown",
}
EXPERT = {
    "status": "PENDING",
    "reviewer": None,
    "reviewed_at": None,
    "approved_claim_denominator": 0,
    "dimensions": {
        "semantic_support": "PENDING",
        "temporal_validity": "PENDING",
        "inference_classification": "PENDING",
        "abstention_appropriateness": "PENDING",
    },
    "labels": [],
}


class PublicSourceReportError(ValueError):
    def __init__(self):
        super().__init__("Invalid public-source report case")


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
        OSError,
    ):
        raise PublicSourceReportError() from None


def _json_bytes(payload, limit):
    if type(payload) is not bytes or not 0 < len(payload) <= limit:
        fail()
    # UTF-8 only: parse_json also accepts UTF-16 bytes, which this protocol does not.
    return bounded(parse_json(payload.decode("utf-8")))


def _report(payload):
    report = _json_bytes(payload, MAX_REPORT_BYTES)
    shape(
        report,
        {
            "schema_version",
            "kind",
            "report_id",
            "version_id",
            "version_number",
            "created_at",
            "authorship",
            "scope",
            "title",
            "full_text",
            "authority",
            "expert_review",
            "report_sha256",
        },
    )
    if type(report["schema_version"]) is not int or report["schema_version"] != 1:
        fail()
    if report["kind"] != "public_source_engineering_report":
        fail()
    for key in ("report_id", "version_id"):
        uuid(report[key])
    integer(report["version_number"], low=1)
    timestamp(report["created_at"])
    text(report["title"], nonempty=True, limit=4096)
    text(report["full_text"], nonempty=True, limit=MAX_REPORT_BYTES)
    if report["scope"] != "current_saved_snapshot_cell_transcription":
        fail()
    authorship = report["authorship"]
    shape(
        authorship,
        {
            "mode",
            "author_identity",
            "production_run_id",
            "external_research_model_run_id",
            "method_record",
        },
    )
    if (
        authorship["mode"] != "engineering_fixture"
        or authorship["author_identity"] is not None
        or authorship["production_run_id"] is not None
        or authorship["external_research_model_run_id"] is not None
    ):
        fail()
    text(authorship["method_record"], nonempty=True, limit=4096)
    # Canonical comparisons reject bool/int equivalence and preserve explicit nulls.
    if canonical_json(report["authority"]) != canonical_json(UNKNOWN_AUTHORITY) or canonical_json(
        report["expert_review"]
    ) != canonical_json(EXPERT):
        fail()
    component(report, "report_sha256")
    return report


def _report_ref(report, payload):
    return {
        "report_id": report["report_id"],
        "version_id": report["version_id"],
        "report_raw_utf8_sha256": hashlib.sha256(payload).hexdigest(),
        "report_sha256": report["report_sha256"],
        "full_text_utf8_sha256": hashlib.sha256(report["full_text"].encode("utf-8")).hexdigest(),
    }


def _source_ref(manifest, table):
    return {
        "corpus_id": manifest["corpus_id"],
        "manifest_sha256": manifest["manifest_sha256"],
        "raw_sha256": table["source_raw_sha256"],
        "table_sha256": table["table_sha256"],
    }


def _validate(case, report_bytes, manifest, raw_bytes):
    captured = bounded(case)
    if len(canonical_json(captured).encode("utf-8")) > MAX_CASE_BYTES:
        fail()
    shape(
        captured,
        {
            "schema_version",
            "kind",
            "case_id",
            "policy_sha256",
            "report_ref",
            "source_ref",
            "claims",
            "case_sha256",
        },
    )
    if (
        type(captured["schema_version"]) is not int
        or captured["schema_version"] != 1
        or captured["kind"] != "public_source_report_case"
        or captured["policy_sha256"] != POLICY_SHA256
    ):
        fail()
    uuid(captured["case_id"])
    report = _report(report_bytes)
    source = validate_corpus(manifest, raw_bytes)
    table = derive_bls_table(raw_bytes)
    expected_report = _report_ref(report, report_bytes)
    expected_source = _source_ref(source, table)
    if canonical_json(captured["report_ref"]) != canonical_json(expected_report) or canonical_json(
        captured["source_ref"]
    ) != canonical_json(expected_source):
        fail()
    claims = captured["claims"]
    if not isinstance(claims, list) or not 1 <= len(claims) <= POLICY["max_claims"]:
        fail()
    rows = {(r["source_series_index"], r["source_observation_index"]): r for r in table["rows"]}
    declarations = {s["series_id"]: s for s in source["series"]}
    ids, spans = set(), set()
    for claim in claims:
        shape(
            claim,
            {
                "claim_id",
                "report_target",
                "source_target",
                "span",
                "cell",
                "context_spans",
                "claim_sha256",
            },
        )
        identifier(claim["claim_id"])
        if claim["claim_id"] in ids:
            fail()
        ids.add(claim["claim_id"])
        if canonical_json(claim["report_target"]) != canonical_json(
            expected_report
        ) or canonical_json(claim["source_target"]) != canonical_json(expected_source):
            fail()
        cell = claim["cell"]
        shape(
            cell,
            {
                "series_id",
                "year",
                "period",
                "reference_period",
                "source_series_index",
                "source_observation_index",
                "value",
                "units",
                "adjustment",
                "metadata_status",
            },
        )
        for key in ("source_series_index", "source_observation_index"):
            integer(cell[key], high=119)
        row = rows.get((cell["source_series_index"], cell["source_observation_index"]))
        if row is None or any(
            cell[k] != row[k] for k in ("series_id", "year", "period", "reference_period", "value")
        ):
            fail()
        declaration = declarations[row["series_id"]]
        if (
            canonical_json(cell["units"]) != canonical_json(declaration["units"])
            or cell["adjustment"] != declaration["adjustment"]
            or cell["metadata_status"] != declaration["metadata_basis"]["status"]
        ):
            fail()
        span_text(report["full_text"], claim["span"])
        if not re.fullmatch(
            r"[0-9]+(?:\.[0-9]+)?", claim["span"]["text"]
        ) or not supported_numeric_span(report["full_text"], claim["span"]):
            fail()
        span_key = claim["span"]["start_byte"], claim["span"]["end_byte"]
        if span_key in spans:
            fail()
        spans.add(span_key)
        context = claim["context_spans"]
        expected_context = {
            "series_id": row["series_id"],
            "reference_period": row["reference_period"],
            "units": "index (1982-84=100)",
            "adjustment": declaration["adjustment"],
        }
        shape(context, set(expected_context))
        for key, literal in expected_context.items():
            if span_text(report["full_text"], context[key])[
                0
            ] != literal or not supported_context_span(report["full_text"], context[key]):
                fail()
        component(claim, "claim_sha256")
    component(captured, "case_sha256")
    return captured, report, table


def validate_report_case(case, report_bytes, manifest, raw_bytes):
    """Validate independent report/source owners without rejecting wrong prose numbers."""
    return _checked(lambda: deepcopy(_validate(case, report_bytes, manifest, raw_bytes)[0]))


def _evaluate(case, report_bytes, manifest, raw_bytes):
    captured, report, table = _validate(case, report_bytes, manifest, raw_bytes)
    claims = [
        {
            "claim_id": claim["claim_id"],
            "claim_sha256": claim["claim_sha256"],
            "status": "MATCH" if claim["span"]["text"] == claim["cell"]["value"] else "MISMATCH",
            "reported_literal": claim["span"]["text"],
            "source_literal": claim["cell"]["value"],
        }
        for claim in captured["claims"]
    ]
    return make_component(
        {
            "schema_version": 1,
            "kind": "public_source_report_case_result",
            "policy_sha256": POLICY_SHA256,
            "case_id": captured["case_id"],
            "case_sha256": captured["case_sha256"],
            "report_ref": captured["report_ref"],
            "source_ref": captured["source_ref"],
            "series_count": len({r["series_id"] for r in table["rows"]}),
            "observation_count": len(table["rows"]),
            "claims": claims,
            "counts": {
                "submitted": len(claims),
                **{
                    status.lower(): sum(c["status"] == status for c in claims)
                    for status in ("MATCH", "MISMATCH")
                },
            },
            "metadata_authority": POLICY["metadata_authority"],
            "semantic_support": "NOT_EVALUATED",
            "authority": report["authority"],
            "historical_authority": "UNAVAILABLE",
            "expert_review": report["expert_review"],
        },
        "result_sha256",
    )


def evaluate_report_case(case, report_bytes, manifest, raw_bytes):
    """Compare selected original decimal strings; do not infer sentence support."""
    return _checked(lambda: _evaluate(case, report_bytes, manifest, raw_bytes))


def validate_report_case_result(result, case, report_bytes, manifest, raw_bytes):
    def operation():
        expected = _evaluate(case, report_bytes, manifest, raw_bytes)
        if canonical_json(bounded(result)) != canonical_json(expected):
            fail()
        return deepcopy(expected)

    return _checked(operation)


__all__ = [
    "MAX_CASE_BYTES",
    "MAX_REPORT_BYTES",
    "MAX_SOURCE_BYTES",
    "POLICY",
    "POLICY_SHA256",
    "PublicSourceReportError",
    "evaluate_report_case",
    "validate_report_case",
    "validate_report_case_result",
]
