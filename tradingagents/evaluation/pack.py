"""Strict selected-claim wire and global immutable saved-run authorities."""

from __future__ import annotations

from copy import deepcopy
import re

from tradingagents.memory.schema import canonical_json, hash_value, merge_decision
from tradingagents.research.numeric_review import REPORT_SECTION_KEYS, NUMERIC_REVIEW_POLICY
from tradingagents.research.numeric_spans import span_text

from .guards import (
    EVIDENCE_ID,
    bounded,
    checked,
    component,
    fail,
    identifier,
    integer,
    section_sha,
    sha,
    shape,
    text,
    uuid,
)
from .report import has_run_authority, validate_research_report
from .policy import POLICY_SHA256, FROZEN_CLAIM_EVALUATION_POLICY


KINDS = {"saved_field", "price_change_percent", "prediction"}


def _operand(value, evidence):
    shape(
        value,
        {
            "evidence_id",
            "source_index",
            "selector",
            "provider",
            "data_sha256",
            "units",
            "adjustments",
        },
    )
    if not isinstance(value["evidence_id"], str) or not EVIDENCE_ID.fullmatch(value["evidence_id"]):
        fail()
    integer(value["source_index"], high=1023)
    selector = value["selector"]
    shape(selector, {"kind", "table_path", "row_date", "field"})
    if (
        selector["kind"] != "table_cell"
        or selector["table_path"] not in NUMERIC_REVIEW_POLICY["table_paths"]
    ):
        fail()
    text(selector["row_date"], nonempty=True, limit=256)
    text(selector["field"], nonempty=True, limit=256)
    sha(value["data_sha256"], nullable=True)
    for key in ("provider", "units", "adjustments"):
        if value[key] is not None:
            text(value[key], limit=256)
    if evidence is not None:
        record = next((r for r in evidence["records"] if r["id"] == value["evidence_id"]), None)
        if record is None or value["source_index"] >= len(record["sources"]):
            fail()
        source = record["sources"][value["source_index"]]
        if any(
            value[key] != source[key] for key in ("provider", "data_sha256", "units", "adjustments")
        ):
            fail()


def _selection(selection, kind, section, evidence):
    if kind in {"saved_field", "prediction"}:
        shape(selection, {"operand", "rounding", "context_bindings"})
        _operand(selection["operand"], evidence)
        mode, context_keys = "saved_decimal_half_up", {"instrument", "row_date", "units"}
    else:
        shape(selection, {"operands", "rounding", "context_bindings"})
        if not isinstance(selection["operands"], list) or len(selection["operands"]) != 2:
            fail()
        for operand in selection["operands"]:
            _operand(operand, evidence)
        mode, context_keys = (
            "exact_fraction_half_up",
            {"instrument", "start_date", "end_date", "units", "basis"},
        )
    shape(selection["rounding"], {"mode", "places"})
    if selection["rounding"]["mode"] != mode:
        fail()
    integer(selection["rounding"]["places"], high=18)
    shape(selection["context_bindings"], context_keys)
    for binding in selection["context_bindings"].values():
        if binding is not None:
            span_text(section, binding)


def _claim(claim, report):
    shape(claim, {"claim_id", "kind", "target", "span", "selection", "note", "claim_sha256"})
    identifier(claim["claim_id"])
    if claim["kind"] not in KINDS:
        fail()
    if claim["note"] is not None:
        text(claim["note"], limit=4096)
    target = claim["target"]
    shape(
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
    owner, snapshot = report["report"], report.get("report_text_snapshot")
    if (
        target["task_id"] != owner["task_id"]
        or target["version_id"] != owner["id"]
        or target["run_id"] != owner.get("runId")
        or target["section_key"] not in REPORT_SECTION_KEYS
    ):
        fail()
    sha(target["report_snapshot_sha256"], nullable=True)
    if target["report_snapshot_sha256"] != (
        None if snapshot is None else snapshot["snapshot_sha256"]
    ):
        fail()
    section = owner["reportSections"].get(target["section_key"])
    if not isinstance(section, str) or target["section_utf8_sha256"] != section_sha(section):
        fail()
    span_text(section, claim["span"])
    _selection(claim["selection"], claim["kind"], section, report["evidence_bundle"])
    component(claim, "claim_sha256")


def _histories_compatible(a, b):
    short, long = sorted((a, b), key=len)
    if short != long[: len(short)]:
        fail()


def _authorities(cases):
    versions, runs, decisions = {}, {}, {}
    for case in cases:
        value, report = case["research_report"], case["research_report"]["report"]
        completion = {
            key: item
            for key, item in value.items()
            if key not in {"numeric_reviews", "evaluation_reviews"}
        }
        key = report["id"]
        if key in versions:
            old = versions[key]
            if canonical_json(completion) != canonical_json(old[0]):
                fail()
            for history in ("numeric_reviews", "evaluation_reviews"):
                _histories_compatible(value.get(history, []), old[1].get(history, []))
        else:
            versions[key] = completion, value
        run = (value["evidence_bundle"] or {}).get("run_id") or (
            report.get("runId") if has_run_authority(report) else None
        )
        if run is not None:
            # Saved version IDs and display clocks may differ for copied versions;
            # the complete as-generated research authority must remain identical.
            owner = {
                key: item
                for key, item in report.items()
                if key
                not in {"task_id", "id", "versionNumber", "createdAt", "legacy", "origin", "runId"}
            }
            authority = {
                "report": owner,
                **{
                    key: value.get(key)
                    for key in (
                        "evidence_bundle",
                        "report_text_snapshot",
                        "memory_bundle",
                        "research_readiness",
                        "effective_request_identity",
                    )
                },
            }
            if run in runs and canonical_json(runs[run]) != canonical_json(authority):
                fail()
            runs[run] = authority
        memory = value["memory_bundle"]
        if memory is not None:
            for snapshot in [
                *memory["input_snapshot"]["decisions"],
                memory["decision_snapshot"],
                *(r["snapshot"] for r in value["evaluation_reviews"]),
            ]:
                run_id = snapshot["run_id"]
                if run_id in decisions:
                    # Different later review tails may extend the same completion;
                    # contradictory facts/reflections never establish a new owner.
                    old = decisions[run_id]
                    try:
                        merged = merge_decision(old, snapshot)
                    except ValueError:
                        fail()
                    if merged not in (old, snapshot):
                        fail()
                    decisions[run_id] = merged
                else:
                    decisions[run_id] = snapshot


def _validate(value):
    captured = bounded(value)
    shape(
        captured,
        {
            "schema_version",
            "kind",
            "pack_id",
            "provenance",
            "distribution",
            "policy_sha256",
            "cases",
            "label_sets",
            "pack_sha256",
        },
    )
    if (
        type(captured["schema_version"]) is not int
        or captured["schema_version"] != 1
        or captured["kind"] != "frozen_claim_evaluation_pack"
    ):
        fail()
    uuid(captured["pack_id"])
    if captured["policy_sha256"] != POLICY_SHA256:
        fail()
    shape(captured["distribution"], {"status", "record"})
    if captured["distribution"]["status"] != "fictional_owned":
        fail()
    text(captured["distribution"]["record"], nonempty=True, limit=4096)
    provenance = captured["provenance"]
    shape(provenance, {"stratum", "labeler", "expert_labels"})
    if (
        provenance["stratum"] not in {"engineering", "independent_arithmetic"}
        or provenance["labeler"] is not None
        or provenance["expert_labels"] is not None
    ):
        fail()
    cases = captured["cases"]
    if not isinstance(cases, list) or not 1 <= len(cases) <= 32:
        fail()
    case_ids, claim_ids, total = set(), set(), 0
    for case in cases:
        shape(case, {"case_id", "research_report", "report_sha256", "claims", "case_sha256"})
        identifier(case["case_id"])
        if case["case_id"] in case_ids:
            fail()
        case_ids.add(case["case_id"])
        case["research_report"] = validate_research_report(case["research_report"])
        if case["report_sha256"] != hash_value(case["research_report"]):
            fail()
        claims = case["claims"]
        if not isinstance(claims, list) or not 1 <= len(claims) <= 100:
            fail()
        ids = set()
        for claim in claims:
            _claim(claim, case["research_report"])
            if claim["claim_id"] in ids or claim["claim_id"] in claim_ids:
                fail()
            ids.add(claim["claim_id"])
            claim_ids.add(claim["claim_id"])
        total += len(claims)
        if total > 1000:
            fail()
        component(case, "case_sha256")
    _authorities(cases)
    _labels(captured["label_sets"], cases)
    component(captured, "pack_sha256")
    return deepcopy(captured)


def _labels(label_sets, cases):
    if not isinstance(label_sets, list) or len(label_sets) > 2 * len(cases):
        fail()
    owners = {case["case_id"]: case for case in cases}
    ids, strata = set(), set()
    for labels in label_sets:
        shape(
            labels,
            {
                "schema_version",
                "label_set_id",
                "provenance",
                "method_record",
                "revision",
                "case_id",
                "case_sha256",
                "labels",
                "label_set_sha256",
            },
        )
        if type(labels["schema_version"]) is not int or labels["schema_version"] != 1:
            fail()
        identifier(labels["label_set_id"])
        if labels["label_set_id"] in ids or labels["provenance"] not in {
            "engineering",
            "independent_arithmetic",
        }:
            fail()
        ids.add(labels["label_set_id"])
        text(labels["method_record"], nonempty=True, limit=4096)
        integer(labels["revision"], low=1)
        case = owners.get(labels["case_id"])
        if case is None or labels["case_sha256"] != case["case_sha256"]:
            fail()
        key = labels["case_id"], labels["provenance"]
        if key in strata:
            fail()
        strata.add(key)
        claims = {claim["claim_id"]: claim for claim in case["claims"]}
        indices = {claim["claim_id"]: index for index, claim in enumerate(case["claims"])}
        selected, previous_index = set(), -1
        if not isinstance(labels["labels"], list) or len(labels["labels"]) > len(claims):
            fail()
        for label in labels["labels"]:
            shape(label, {"claim_id", "claim_sha256", "expected"})
            claim = claims.get(label["claim_id"])
            if (
                claim is None
                or label["claim_id"] in selected
                or label["claim_sha256"] != claim["claim_sha256"]
                or indices[label["claim_id"]] <= previous_index
            ):
                fail()
            selected.add(label["claim_id"])
            previous_index = indices[label["claim_id"]]
            expected = label["expected"]
            shape(expected, {"status", "rounded_decimal", "reason"})
            if expected["status"] not in FROZEN_CLAIM_EVALUATION_POLICY["statuses"]:
                fail()
            if expected["rounded_decimal"] is not None:
                text(expected["rounded_decimal"], nonempty=True, limit=1200)
                if not re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", expected["rounded_decimal"]):
                    fail()
            text(expected["reason"], nonempty=True, limit=4096)
        component(labels, "label_set_sha256")


def validate_pack(value):
    """Validate every declared claim and run owner before any arithmetic."""
    return checked(lambda: _validate(value))
