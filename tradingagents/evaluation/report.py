"""Validate complete exported report ownership and saved attachment receipts."""

from __future__ import annotations

from copy import deepcopy

from tradingagents.evidence import audit_citations, validate_evidence_bundle
from tradingagents.memory.publication import validate_completed_memory
from tradingagents.memory.schema import canonical_json, make_component, validate_review_attachment
from tradingagents.research import effective_request_identity as identity_source
from tradingagents.research.numeric_review import (
    REPORT_SECTION_KEYS,
    validate_numeric_reviews,
    validate_report_text_snapshot,
)
from tradingagents.research.readiness import assess_readiness

from ._rating import normalize_rating, extract_rating
from .guards import bounded, checked, fail, identifier, integer, shape, text, timestamp, day, uuid

REPORT_KEYS = {
    "task_id",
    "origin",
    "id",
    "versionNumber",
    "createdAt",
    "legacy",
    "decision",
    "task",
    "run",
    "stats",
    "reportSections",
}
ENVELOPE_KEYS = {
    "schema_version",
    "kind",
    "report",
    "evidence_bundle",
    "memory_bundle",
    "evaluation_reviews",
    "research_readiness",
    "effective_request_identity",
}
ENVELOPE_OPTIONAL = {"report_text_snapshot", "numeric_reviews", "memory_verification_scope"}
TASK_KEYS = {
    "ticker",
    "analysisDate",
    "assetType",
    "researchDepth",
    "analysts",
    "outputLanguage",
}
RUN_KEYS = {
    "appVersion",
    "llmProvider",
    "quickThinkLlm",
    "deepThinkLlm",
    "coreStockApis",
    "technicalIndicators",
    "fundamentalData",
    "newsData",
    "maxDebateRounds",
    "maxRiskRounds",
    "benchmarkTicker",
}
RUN_OPTIONAL = {"coreVersion", "holdingPeriodDays", "toolVendors", "runtimeRunSettings"}
MEMORY_SCOPE = {
    "content_checks": "structure_references_and_hashes",
    "arithmetic_replay": "not_performed_by_exporter",
    "model_eligibility": "not_established_by_exporter",
}


def _validate_identity_receipt(value, evidence, snapshot):
    """Use inherited selector derivation, with the identical pure rating helper.

    The public inherited receipt validator imports the eager agents package in
    its unsafe-selector branch. This small assembly mirrors its exact schema
    while reusing the same complete input, selector and chronology derivations.
    It neither changes saved inputs nor bypasses the marked REVIEW constraint.
    """
    bundle, captured = identity_source._inputs(evidence, snapshot)
    clock = value.get("reviewed_at")
    if identity_source._reviewed(clock) < identity_source._reviewed(captured["captured_at"]):
        fail()
    records = identity_source._records(bundle)
    summary = {
        "record_count": len(records),
        "source_count": sum(len(record["sources"]) for record in records),
        **{
            alignment + "_count": sum(record["record_alignment"] == alignment for record in records)
            for alignment in identity_source._ALIGNMENTS
        },
        "unsafe_record_ids": [
            record["evidence_id"] for record in records if identity_source._unsafe(record)
        ],
    }
    if (
        "effective_request_identity_policy_sha256" in bundle["manifest"]
        and summary["unsafe_record_ids"]
        and extract_rating(captured["report_sections"]["final_trade_decision"]) != "REVIEW"
    ):
        fail()
    expected = make_component(
        {
            "schema_version": 1,
            "scope": identity_source.EFFECTIVE_REQUEST_IDENTITY_POLICY["scope"],
            "policy_version": identity_source.EFFECTIVE_REQUEST_IDENTITY_POLICY["policy_version"],
            "policy_sha256": identity_source.POLICY_SHA256,
            "run_id": bundle["run_id"],
            "instrument": bundle["instrument"],
            "analysis_date": bundle["analysis_date"],
            "evidence_bundle_sha256": bundle["bundle_sha256"],
            "report_snapshot_sha256": captured["snapshot_sha256"],
            "reviewed_at": clock,
            "records": records,
            "summary": summary,
        },
        "assessment_sha256",
    )
    if canonical_json(value) != canonical_json(expected):
        fail()
    return expected


def _validate_readiness_receipt(value, evidence):
    # assess_readiness is the inherited pure policy/complete-check derivation;
    # its public validator's blocked branch eagerly imports agents for rating.
    expected = assess_readiness(evidence, value["policy"])
    if canonical_json(value) != canonical_json(expected):
        fail()
    return expected


def _metadata(report):
    shape(report, REPORT_KEYS, optional={"outputQuality", "runId"})
    for key in ("task_id", "id"):
        identifier(report[key])
    if report["origin"] not in {"analysis", "demo"} or type(report["legacy"]) is not bool:
        fail()
    integer(report["versionNumber"], low=1)
    timestamp(report["createdAt"])
    text(report["decision"], limit=256)
    if report["decision"] and normalize_rating(report["decision"]) != report["decision"]:
        fail()
    task = report["task"]
    shape(task, TASK_KEYS, optional={"instrumentName"})
    for key in ("ticker", "outputLanguage"):
        text(task[key], nonempty=True, limit=256)
    if "instrumentName" in task and task["instrumentName"] is not None:
        text(task["instrumentName"], limit=256)
    day(task["analysisDate"])
    if task["assetType"] not in {"stock", "crypto"}:
        fail()
    integer(task["researchDepth"], low=1, high=100)
    analysts = task["analysts"]
    if (
        not isinstance(analysts, list)
        or len(analysts) > 4
        or len(set(analysts)) != len(analysts)
        or any(a not in {"market", "social", "news", "fundamentals"} for a in analysts)
    ):
        fail()
    sections = report["reportSections"]
    if not isinstance(sections, dict) or set(sections) - set(REPORT_SECTION_KEYS):
        fail()
    for section in sections.values():
        if section is not None:
            text(section)
    run = report["run"]
    if run is not None:
        shape(run, set(), optional=RUN_KEYS | RUN_OPTIONAL)
        for key in (RUN_KEYS - {"maxDebateRounds", "maxRiskRounds"}) & run.keys():
            if run[key] is not None:
                text(run[key], limit=256)
        for key in ("maxDebateRounds", "maxRiskRounds"):
            if key in run and run[key] is not None:
                integer(run[key], high=1000)
        if "coreVersion" in run and run["coreVersion"] is not None:
            text(run["coreVersion"], limit=256)
        if "holdingPeriodDays" in run and run["holdingPeriodDays"] is not None:
            integer(run["holdingPeriodDays"], low=1, high=10000)
        for key in ("toolVendors", "runtimeRunSettings"):
            if key in run and run[key] is not None and not isinstance(run[key], dict):
                fail()
            if key in run:
                _metadata_text(run[key])
    shape(report["stats"], {"llmCalls", "toolCalls", "tokensIn", "tokensOut", "elapsedSeconds"})
    for key, value in report["stats"].items():
        if key == "elapsedSeconds":
            if type(value) not in {int, float} or value < 0:
                fail()
        else:
            integer(value)
    quality = report.get("outputQuality")
    if quality is not None:
        schemas = {
            "sentiment": "SentimentReport",
            "research_manager": "ResearchPlan",
            "trader": "TraderProposal",
            "portfolio_manager": "PortfolioDecision",
        }
        shape(quality, set(), optional=schemas)
        for role, item in quality.items():
            shape(item, {"schema", "status", "source"}, optional={"reason"})
            if item["schema"] != schemas[role]:
                fail()
            if item["status"] == "validated_schema":
                if item["source"] != "structured" or "reason" in item:
                    fail()
            elif item["status"] == "unvalidated_text":
                if item["source"] not in {"raw_response", "plain_generation"} or item.get(
                    "reason"
                ) not in {
                    "structured_unavailable",
                    "no_tool_call",
                    "schema_validation_failed",
                    "unsupported_format",
                }:
                    fail()
            else:
                fail()


def _metadata_text(value):
    if isinstance(value, str):
        text(value)
    elif isinstance(value, dict):
        for key, child in value.items():
            text(key, limit=1024)
            _metadata_text(child)
    elif isinstance(value, list):
        for child in value:
            _metadata_text(child)


def _owner(bundle, report):
    if (
        (has_run_authority(report) and bundle["run_id"] != report["runId"])
        or bundle["instrument"] != report["task"]["ticker"]
        or bundle["analysis_date"] != report["task"]["analysisDate"]
    ):
        fail()


def has_run_authority(report):
    value = report.get("runId")
    if not isinstance(value, str):
        return False
    try:
        uuid(value)
        return True
    except ValueError:
        return False


def _validate(value):
    captured = bounded(value)
    shape(captured, ENVELOPE_KEYS, optional=ENVELOPE_OPTIONAL)
    if (
        type(captured["schema_version"]) is not int
        or captured["schema_version"] != 1
        or captured["kind"] != "research_report"
    ):
        fail()
    report = captured["report"]
    _metadata(report)
    evidence, snapshot = captured["evidence_bundle"], captured.get("report_text_snapshot")
    memory = captured["memory_bundle"]
    numeric_reviews = captured.get("numeric_reviews", [])
    reviews = captured["evaluation_reviews"]
    if (
        not isinstance(numeric_reviews, list)
        or not isinstance(reviews, list)
        or len(reviews) > 1000
    ):
        fail()
    # Preserve absence/null and old opaque legacy labels. None of these invent
    # a report-run owner; a malformed present modern run remains invalid.
    if report.get("runId") is not None:
        text(report["runId"], nonempty=True, limit=256)
        if not report["legacy"]:
            uuid(report["runId"])
    if evidence is None:
        if (
            snapshot is not None
            or memory is not None
            or numeric_reviews
            or reviews
            or captured["research_readiness"] is not None
            or captured["effective_request_identity"] is not None
        ):
            fail()
    else:
        evidence = validate_evidence_bundle(evidence)
        _owner(evidence, report)
        manifest = evidence["manifest"]
        if (
            "research_readiness_policy_sha256" in manifest
            and captured["research_readiness"] is None
        ) or (
            "effective_request_identity_policy_sha256" in manifest
            and captured["effective_request_identity"] is None
        ):
            fail()
        sections = {key: report["reportSections"].get(key) for key in REPORT_SECTION_KEYS}
        audited = audit_citations(evidence, sections)
        empty = {"referenced_ids": [], "unresolved_ids": [], "status": "none"}
        if any(
            evidence["citation_audit"].get(key, empty) != audited["citation_audit"][key]
            for key in REPORT_SECTION_KEYS
        ):
            fail()
        if snapshot is not None:
            snapshot = validate_report_text_snapshot(snapshot, evidence)
            _owner(snapshot, report)
            if snapshot["report_sections"] != sections:
                fail()
            validate_numeric_reviews(
                numeric_reviews,
                snapshot,
                evidence,
                task_id=report["task_id"],
                version_id=report["id"],
            )
        elif numeric_reviews:
            fail()
        validate_completed_memory(memory, evidence)
        if memory is not None:
            _owner(memory, report)
            saved = memory["decision_snapshot"]
            decision = saved["decision"]
            original_text = saved["artifacts"][decision["decision_text_sha256"]]["payload"]
            if (
                report["reportSections"].get("final_trade_decision") != original_text
                or report["decision"] != decision["rating"]
                or report["task"]["assetType"] != decision["asset_type"]
            ):
                fail()
            if snapshot is not None and timestamp(snapshot["captured_at"]) < timestamp(
                decision["recorded_at"]
            ):
                fail()
            previous = saved
            seen_reviews = set()
            reviewed_at = timestamp(decision["recorded_at"])
            for attachment in reviews:
                checked_review = validate_review_attachment(attachment, memory)
                if (
                    checked_review["attachment_sha256"] in seen_reviews
                    or timestamp(checked_review["reviewed_at"]) < reviewed_at
                ):
                    fail()
                seen_reviews.add(checked_review["attachment_sha256"])
                reviewed_at = timestamp(checked_review["reviewed_at"])
                from tradingagents.memory.schema import merge_decision

                if (
                    merge_decision(previous, checked_review["snapshot"])
                    != checked_review["snapshot"]
                ):
                    fail()
                previous = checked_review["snapshot"]
        elif reviews:
            fail()
        readiness = captured["research_readiness"]
        if readiness is not None:
            readiness = _validate_readiness_receipt(readiness, evidence)
            _owner(readiness, report)
            policy = readiness["policy"]
            if report["task"]["analysts"] != policy["selected_analysts"]:
                fail()
            if memory is not None:
                decision = memory["decision_snapshot"]["decision"]
                if (
                    policy["research_started_at"] != decision["research_started_at"]
                    or policy["research_calendar_date"] != decision["analysis_calendar_date"]
                    or policy["host_utc_offset"] != decision["host_utc_offset"]
                ):
                    fail()
            settings = (report["run"] or {}).get("runtimeRunSettings") or {}
            for key, expected in (
                ("research_readiness_policy_sha256", policy["policy_sha256"]),
                ("max_tool_rounds", policy["max_tool_rounds"]),
                ("analysts", policy["selected_analysts"]),
            ):
                if key in settings and settings[key] != expected:
                    fail()
            if not readiness["recommendation_allowed"] and (
                report["decision"] != "REVIEW"
                or extract_rating(report["reportSections"].get("final_trade_decision")) != "REVIEW"
            ):
                fail()
        identity = captured["effective_request_identity"]
        if identity is not None:
            if snapshot is None:
                fail()
            identity = _validate_identity_receipt(identity, evidence, snapshot)
            if (
                "effective_request_identity_policy_sha256" in manifest
                and identity["summary"]["unsafe_record_ids"]
                and (
                    report["decision"] != "REVIEW"
                    or extract_rating(report["reportSections"].get("final_trade_decision"))
                    != "REVIEW"
                )
            ):
                fail()
    if "memory_verification_scope" in captured:
        if memory is None or captured["memory_verification_scope"] != MEMORY_SCOPE:
            fail()
    return deepcopy(captured)


def validate_research_report(value):
    """Copy a complete owner-bound export; never invent an absent snapshot."""
    return checked(lambda: _validate(value))
