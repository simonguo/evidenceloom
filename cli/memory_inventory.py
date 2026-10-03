"""Read completed memory reviews without loading models, providers or dotenv."""

from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

from tradingagents.memory.schema import MAX_BYTES, build_review_attachment, canonical_json
from tradingagents.memory.store import MemoryStore


def validate_decision_ids(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        raise ValueError("Invalid research memory inventory request")
    for item in value:
        try:
            if not isinstance(item, str) or str(UUID(item)) != item:
                raise ValueError()
        except (ValueError, AttributeError):
            raise ValueError("Invalid research memory inventory request") from None
    if len(set(value)) != len(value):
        raise ValueError("Invalid research memory inventory request")
    return list(value)


def inventory(payload):
    requested = validate_decision_ids(payload.get("decisionIds"))
    configured_path = os.environ.get("TRADINGAGENTS_MEMORY_LOG_PATH")
    if configured_path is None:
        configured_path = Path.home() / ".tradingagents" / "memory" / "trading_memory.md"
    store = MemoryStore(configured_path)
    reviews, missing = [], []
    for run_id in requested:
        snapshot = store.load_decision(run_id)
        completed = store.load_bundle(run_id)
        if snapshot is None or completed is None:
            missing.append(run_id)
            continue
        reviews.append(build_review_attachment(snapshot, completion_bundle=completed))
    result = {
        "type": "memory_inventory",
        "schema_version": 1,
        "requested_ids": requested,
        "reviews": reviews,
        "missing_ids": missing,
    }
    if len(canonical_json(result).encode("utf-8")) > MAX_BYTES - 1024:
        raise ValueError("Research memory inventory exceeds its size limit")
    return result
