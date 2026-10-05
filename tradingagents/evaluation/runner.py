"""Deterministic selected-claim evaluation and complete replay verification."""

from __future__ import annotations

from copy import deepcopy
import hashlib
from pathlib import Path
import platform
import sys

from cli.research_manifest import context_sha256, source_code_sha256
from tradingagents.memory.schema import canonical_json, hash_value, make_component

from .guards import bounded, checked, fail
from .oracle import price_change_percent, saved_field
from .pack import validate_pack
from .policy import FROZEN_CLAIM_EVALUATION_POLICY, POLICY_SHA256
from .report import has_run_authority


def implementation_manifest():
    """Complete readable core, own entry point/helper and interpreter identity.

    These are local implementation bytes, not attestation of source correctness,
    cross-language canonicalization, expert acceptance or research truth.
    """
    root = Path(__file__).resolve().parents[2]
    package = root / "tradingagents"
    source_files = [
        {
            "path": path.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
        for path in sorted(package.rglob("*.py"))
    ]
    if not source_files:
        fail()
    extras = [
        {"path": name, "sha256": hashlib.sha256((root / name).read_bytes()).hexdigest()}
        for name in (
            "scripts/evaluate_frozen_research.py",
            "cli/research_manifest.py",
            "cli/__init__.py",
        )
    ]
    return {
        "scope": "complete_readable_core_and_evaluation_entrypoint",
        "core_source_sha256": source_code_sha256(package),
        "source_file_count": len(source_files),
        "source_files": source_files,
        "source_files_sha256": context_sha256(source_files),
        "entrypoint_and_manifest_helper": extras,
        "dependency_files": [
            {"path": name, "sha256": hashlib.sha256((root / name).read_bytes()).hexdigest()}
            for name in ("pyproject.toml", "uv.lock")
        ],
        "dependency_identity_scope": "declared_files_only_no_installed_environment_attestation",
        "execution_import_scope": "stdlib_and_saved_receipt_modules_only",
        "python": {
            "implementation": platform.python_implementation(),
            "version": platform.python_version(),
            "cache_tag": sys.implementation.cache_tag,
        },
    }


def _engineering(report):
    def present(key):
        return "PRESENT" if report.get(key) is not None else "ABSENT"

    return {
        "status": "VALIDATED_SAVED_RECEIPTS",
        "scope": "structure_references_hashes_and_owner",
        "evidence": present("evidence_bundle"),
        "report_snapshot": present("report_text_snapshot"),
        "report_run_owner": "PRESENT" if has_run_authority(report["report"]) else "UNKNOWN",
        "numeric_history_count": len(report.get("numeric_reviews", [])),
        "memory": present("memory_bundle"),
        "memory_arithmetic_replay": "NOT_PERFORMED",
        "readiness": present("research_readiness"),
        "identity": present("effective_request_identity"),
        "expert_status": "NOT_EVALUATED",
    }


def _evaluate(pack):
    cases = []
    counts = dict.fromkeys(FROZEN_CLAIM_EVALUATION_POLICY["statuses"], 0)
    for case in pack["cases"]:
        report, claims = case["research_report"], []
        for claim in case["claims"]:
            if (
                report.get("report_text_snapshot") is None
                or report["evidence_bundle"] is None
                or not has_run_authority(report["report"])
            ):
                status, reason, witness = (
                    "UNKNOWN_LEGACY",
                    "original_numeric_authority_absent"
                    if report.get("report_text_snapshot") is None
                    or report["evidence_bundle"] is None
                    else "report_run_owner_absent",
                    None,
                )
            elif claim["kind"] in {"saved_field", "prediction"}:
                status, reason, witness = saved_field(report, claim, case["case_id"])
            else:
                status, reason, witness = price_change_percent(report, claim)
            if claim["kind"] == "prediction":
                witness = {
                    "usage": "prediction",
                    "baseline": {"status": status, "reason": reason, "review": witness},
                }
                status, reason = "MANUAL", "prediction_not_evaluated"
            counts[status] += 1
            claims.append(
                {
                    "claim_id": claim["claim_id"],
                    "claim_sha256": claim["claim_sha256"],
                    "kind": claim["kind"],
                    "target": deepcopy(claim["target"]),
                    "span": deepcopy(claim["span"]),
                    "status": status,
                    "reason": reason,
                    "witness": witness,
                }
            )
        cases.append(
            {
                "case_id": case["case_id"],
                "case_sha256": case["case_sha256"],
                "research_report_sha256": hash_value(report),
                "engineering": _engineering(report),
                "claims": claims,
            }
        )
    label_evaluations, strata = _compare_labels(pack, cases)
    return make_component(
        {
            "schema_version": 1,
            "kind": "frozen_claim_evaluation_result",
            "pack_id": pack["pack_id"],
            "pack_sha256": pack["pack_sha256"],
            "policy_version": FROZEN_CLAIM_EVALUATION_POLICY["policy_version"],
            "policy_sha256": POLICY_SHA256,
            "provenance": deepcopy(pack["provenance"]),
            "provenance_verification": "DECLARED_NOT_INDEPENDENTLY_VERIFIED",
            "distribution": deepcopy(pack["distribution"]),
            "distribution_verification": "DECLARED_NOT_INDEPENDENTLY_VERIFIED",
            "implementation": implementation_manifest(),
            "cases": cases,
            "label_evaluations": label_evaluations,
            "summary": {
                "denominator": sum(counts.values()),
                "counts": counts,
                "arithmetic_comparable_count": counts["MATCH"] + counts["MISMATCH"],
                "expert_status": "NOT_EVALUATED",
                "strata": strata,
                "external_expert": {
                    "approved_claim_denominator": 0,
                    "dimensions": {
                        key: "NOT_EVALUATED"
                        for key in (
                            "semantic_support",
                            "temporal_validity",
                            "inference_classification",
                            "abstention_appropriateness",
                        )
                    },
                },
            },
        },
        "result_sha256",
    )


def _actual(claim):
    witness = claim["witness"]
    if claim["kind"] == "prediction" and witness is not None:
        witness = witness["baseline"]["review"]
    if witness is None:
        rounded = None
    elif "result" in witness:
        rounded = witness["result"]["rounded_decimal"]
    else:
        rounded = witness["rounded_decimal"]
    return {"status": claim["status"], "rounded_decimal": rounded, "reason": claim["reason"]}


def _compare_labels(pack, cases):
    denominator = sum(len(case["claims"]) for case in cases)
    strata = {
        key: {
            "annotated_claim_denominator": denominator,
            "labels_present": 0,
            "agreement": 0,
            "disagreement": 0,
            "unlabeled": denominator,
        }
        for key in ("engineering", "independent_arithmetic")
    }
    outputs = {
        case["case_id"]: {claim["claim_id"]: claim for claim in case["claims"]} for case in cases
    }
    evaluations = []
    for label_set in pack["label_sets"]:
        evaluated = []
        metric = strata[label_set["provenance"]]
        for label in label_set["labels"]:
            actual = _actual(outputs[label_set["case_id"]][label["claim_id"]])
            agreement = actual == label["expected"]
            metric["labels_present"] += 1
            metric["unlabeled"] -= 1
            metric["agreement" if agreement else "disagreement"] += 1
            evaluated.append(
                {
                    "claim_id": label["claim_id"],
                    "claim_sha256": label["claim_sha256"],
                    "expected": deepcopy(label["expected"]),
                    "actual": actual,
                    "comparison": "AGREEMENT" if agreement else "DISAGREEMENT",
                }
            )
        evaluations.append(
            {
                "label_set_id": label_set["label_set_id"],
                "provenance": label_set["provenance"],
                "revision": label_set["revision"],
                "case_id": label_set["case_id"],
                "label_set_sha256": label_set["label_set_sha256"],
                "labels": evaluated,
            }
        )
    return evaluations, strata


def evaluate_pack(pack):
    """Evaluate the full denominator; every output is derived from frozen inputs."""
    return checked(lambda: _evaluate(validate_pack(pack)))


def validate_evaluation_result(result, pack):
    """Recompute every claim, receipt, count and implementation identity.

    A coherently rehashed false result remains invalid. Replaying an older
    artifact under another interpreter/source revision requires its recorded
    implementation, rather than replacing that historical identity silently.
    """

    def validate():
        captured = bounded(result)
        expected = _evaluate(validate_pack(pack))
        if canonical_json(captured) != canonical_json(expected):
            fail()
        return deepcopy(captured)

    return checked(validate)
