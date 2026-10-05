"""Bind a completed report's Memory to its saved Evidence before publication."""

from .schema import MemoryValidationError, validate_bundle


def validate_completed_memory(memory, evidence, *, owner=None):
    """Require target receipts both ways; do not reassess historical contexts."""
    manifest = evidence.get("manifest", {}) if isinstance(evidence, dict) else {}
    if not isinstance(manifest, dict):
        raise MemoryValidationError()
    marked = "memory_target_binding_sha256" in manifest
    if memory is None:
        if marked:
            raise MemoryValidationError()
        return None
    from tradingagents.evidence import validate_evidence_bundle

    try:
        evidence = validate_evidence_bundle(evidence)
    except (ValueError, TypeError):
        raise MemoryValidationError() from None
    bundle = validate_bundle(memory)
    contract = bundle["decision_snapshot"]["contract"]
    decision = bundle["decision_snapshot"]["decision"]
    if (contract["schema_version"] == 2) != marked:
        raise MemoryValidationError()
    if (
        not isinstance(evidence, dict)
        or bundle["run_id"] != evidence.get("run_id")
        or bundle["instrument"] != evidence.get("instrument")
        or bundle["analysis_date"] != evidence.get("analysis_date")
        or bundle["evidence_bundle_sha256"] != evidence.get("bundle_sha256")
        or bundle["input_snapshot"]["context_sha256"] != manifest.get("memory_input_sha256")
        or contract["holding_period_days"] != manifest.get("holding_period_days")
        or contract["resolved_benchmark"] != manifest.get("benchmark_ticker")
        or ("asset_type" in manifest and decision["asset_type"] != manifest["asset_type"])
    ):
        raise MemoryValidationError()
    if marked and (
        contract["target_binding"]["binding_sha256"] != manifest["memory_target_binding_sha256"]
        or contract["target_binding"]["research_started_at"] != decision["research_started_at"]
        or contract["target_binding"]["targets"][0]["requested_symbol"] != bundle["instrument"]
    ):
        raise MemoryValidationError()
    if owner is not None:
        from tradingagents.agents.utils.rating import normalize_rating, run_rating

        text = bundle["decision_snapshot"]["artifacts"][decision["decision_text_sha256"]]["payload"]
        if (
            not isinstance(owner, dict)
            or owner.get("final_trade_decision") != text
            or (
                "final_rating" in owner
                and normalize_rating(owner["final_rating"]) != decision["rating"]
            )
            or run_rating(owner) != decision["rating"]
        ):
            raise MemoryValidationError()
    return bundle
