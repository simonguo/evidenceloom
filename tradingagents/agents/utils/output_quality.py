"""Safe, mergeable evidence of output-format validation, not research accuracy."""

from collections.abc import Mapping

OUTPUT_SCHEMAS = {
    "research_manager": "ResearchPlan",
    "trader": "TraderProposal",
    "portfolio_manager": "PortfolioDecision",
    "sentiment": "SentimentReport",
}
OUTPUT_REASONS = frozenset(
    {"structured_unavailable", "no_tool_call", "schema_validation_failed", "unsupported_format"}
)


def sanitize_output_quality(value) -> dict:
    """Drop unknown fields and contradictory records before saving or displaying."""
    if not isinstance(value, Mapping):
        return {}
    safe = {}
    for agent, schema in OUTPUT_SCHEMAS.items():
        record = value.get(agent)
        if not isinstance(record, Mapping) or record.get("schema") != schema:
            continue
        status, source, reason = record.get("status"), record.get("source"), record.get("reason")
        if status == "validated_schema":
            if source != "structured" or reason is not None:
                continue
        elif status == "unvalidated_text":
            if (
                source not in ("raw_response", "plain_generation")
                or not isinstance(reason, str)
                or reason not in OUTPUT_REASONS
            ):
                continue
        else:
            continue
        safe[agent] = {"status": status, "schema": schema, "source": source}
        if reason is not None:
            safe[agent]["reason"] = reason
    return safe


def merge_output_quality(previous, update) -> dict:
    """Keep each analyst's record when independent graph branches join or resume."""
    return {**sanitize_output_quality(previous), **sanitize_output_quality(update)}
