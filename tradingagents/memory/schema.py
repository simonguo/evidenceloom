"""Strict, independently hashable research memory contracts (no provider imports)."""

from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
import re
from uuid import UUID

from tradingagents.evidence import sanitize_diagnostic

SCHEMA_VERSION = 1
MAX_BYTES = 64 * 1024 * 1024
MAX_TEXT_BYTES = 8 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
MAX_CONTEXT_DECISIONS = 128
SELECTOR_VERSION = "recent-reflections-v1"
TARGET_SELECTOR_VERSION = "recent-reflections-v2"
FORBIDDEN_FIELDS = frozenset(
    {
        "api_key",
        "apikey",
        "access_token",
        "authorization",
        "password",
        "secret",
        "headers",
        "cookies",
        "raw_response",
        "backend_url",
        "__proto__",
        "constructor",
        "prototype",
    }
)
_SHA = re.compile(r"[a-f0-9]{64}\Z")
_UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\Z")
_OFFSET = re.compile(r"([+-])([0-9]{2}):([0-9]{2})\Z")
_REASON = re.compile(r"[a-z][a-z0-9_]{0,79}\Z")
HISTORY_PARAMETERS = {
    "interval": "1d",
    "auto_adjust": False,
    "back_adjust": False,
    "actions": True,
    "repair": False,
    "rounding": False,
    "keepna": True,
    "prepost": False,
}
CONTRACT_POLICIES = {
    "holding_period_unit": "common_complete_provider_daily_rows",
    "policy_version": "common-daily-close-v1",
    "entry_policy": "first_common_complete_date_after_recorded_source_and_utc_dates",
    "exit_policy": "holding_count_common_row_transitions",
    "alignment_policy": "identical_session_date_no_fill",
    "session_policy": "provider_daily_rows_timezone_required",
    "completion_policy": "date_elapsed_in_source_timezone_and_utc",
    "price_basis": "provider_adjusted_close",
    "return_policy": "simple_return_difference_no_fx",
}


class MemoryValidationError(ValueError):
    """A fixed diagnostic that never exposes an artifact or filesystem path."""

    def __init__(self):
        super().__init__("Invalid or conflicting research memory")


def _fail():
    raise MemoryValidationError()


def canonical_json(value) -> str:
    """Canonical JSON; numeric facts belong inside a canonical_json artifact."""
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        )
    except (TypeError, ValueError, OverflowError):
        raise MemoryValidationError() from None


def hash_value(value) -> str:
    try:
        return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()
    except UnicodeError:
        raise MemoryValidationError() from None


def hash_component(value: dict, own_hash_key: str) -> str:
    if not isinstance(value, dict):
        _fail()
    return hash_value({key: item for key, item in value.items() if key != own_hash_key})


def make_component(value: dict, own_hash_key: str) -> dict:
    result = deepcopy(value)
    result[own_hash_key] = hash_component(result, own_hash_key)
    return result


def _duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail()
        result[key] = value
    return result


def parse_json(payload: str | bytes):
    """Reject duplicate keys/non-finite numbers before validating saved state."""
    try:
        if len(payload if isinstance(payload, bytes) else payload.encode("utf-8")) > MAX_BYTES:
            _fail()
        return json.loads(payload, object_pairs_hook=_duplicates, parse_constant=lambda _: _fail())
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise MemoryValidationError() from None


def _text(value, *, nonempty=False, sanitized=True):
    if not isinstance(value, str) or (nonempty and not value):
        _fail()
    try:
        if len(value.encode("utf-8")) > MAX_TEXT_BYTES:
            _fail()
    except UnicodeError:
        raise MemoryValidationError() from None
    if sanitized and sanitize_diagnostic(value) != value:
        _fail()
    return value


def _shape(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        _fail()


def _safe(value, depth=0):
    if depth > 64:
        _fail()
    if value is None or isinstance(value, bool):
        return
    if type(value) is int:
        if abs(value) > MAX_SAFE_INTEGER:
            _fail()
        return
    if isinstance(value, str):
        _text(value)
        return
    if isinstance(value, list):
        for item in value:
            _safe(item, depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in FORBIDDEN_FIELDS:
                _fail()
            _text(key)
            if (
                key == "payload"
                and set(value) == {"kind", "payload", "sha256"}
                and value["kind"] == "canonical_json"
            ):
                # Escaped JSON syntax is not a literal text input; validate its
                # parsed leaf strings in validate_artifact instead.
                _text(item, sanitized=False)
            else:
                _safe(item, depth + 1)
        return
    _fail()


def _safe_payload(value, depth=0):
    """Opaque JSON payloads may contain finite numerical facts, never secrets."""
    if depth > 64:
        _fail()
    if value is None or isinstance(value, bool):
        return
    if type(value) is int:
        try:
            if not math.isfinite(float(value)):
                _fail()
        except OverflowError:
            _fail()
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            _fail()
        return
    if isinstance(value, str):
        _text(value)
        return
    if isinstance(value, list):
        for item in value:
            _safe_payload(item, depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or key.lower() in FORBIDDEN_FIELDS:
                _fail()
            _text(key)
            _safe_payload(item, depth + 1)
        return
    _fail()


def _bounded(value):
    _safe(value)
    size = 0
    for chunk in json.JSONEncoder(
        sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).iterencode(value):
        size += len(chunk.encode("utf-8"))
        if size > MAX_BYTES:
            _fail()


def _sha(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        _fail()
    return value


def _hash(value, key):
    if _sha(value.get(key)) != hash_component(value, key):
        _fail()


def _uuid(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            _fail()
    except (ValueError, AttributeError):
        raise MemoryValidationError() from None
    return value


def utc_timestamp(value) -> datetime:
    if not isinstance(value, str) or not _UTC.fullmatch(value):
        _fail()
    try:
        return datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        raise MemoryValidationError() from None


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def instrument_key(value: str) -> str:
    """ASCII case-insensitive symbols; other Unicode codepoints compare exactly."""
    return value.translate(
        str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")
    )


def _day(value):
    try:
        if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
            _fail()
    except ValueError:
        raise MemoryValidationError() from None
    return value


def _offset(value):
    match = _OFFSET.fullmatch(value) if isinstance(value, str) else None
    if not match or int(match[2]) > 23 or int(match[3]) > 59:
        _fail()
    minutes = int(match[2]) * 60 + int(match[3])
    return timedelta(minutes=minutes if match[1] == "+" else -minutes)


def make_artifact(kind: str, payload) -> dict:
    if kind == "canonical_json" and not isinstance(payload, str):
        payload = canonical_json(payload)
    artifact = make_component({"kind": kind, "payload": payload}, "sha256")
    validate_artifact(artifact)
    return artifact


def validate_artifact(value) -> dict:
    _shape(value, ("kind", "payload", "sha256"))
    if value["kind"] not in ("text", "canonical_json"):
        _fail()
    _text(value["payload"], sanitized=value["kind"] == "text")
    if value["kind"] == "canonical_json":
        # Hash the exact payload string. Re-serialization loses cross-language
        # lexical precision (e.g. Python 1.0 vs JavaScript 1).
        _safe_payload(parse_json(value["payload"]))
    _hash(value, "sha256")
    return deepcopy(value)


def validate_contract(value) -> dict:
    from .targets import validate_binding

    contract_version = value.get("schema_version") if isinstance(value, dict) else None
    _shape(
        value,
        [
            "schema_version",
            "analysis_date",
            "research_calendar_date",
            "host_utc_offset",
            "resolved_benchmark",
            "holding_period_days",
            "evaluation_mode",
            "not_evaluable_reason",
            "evaluator_version",
            "evaluator_code_sha256",
            "effective_history_parameters",
            "decision_text_sha256",
            "contract_sha256",
            *CONTRACT_POLICIES,
            *(["target_binding"] if contract_version == 2 else []),
        ],
    )
    _bounded(value)
    if contract_version not in (1, 2) or type(contract_version) is not int:
        _fail()
    _day(value["analysis_date"])
    _day(value["research_calendar_date"])
    _offset(value["host_utc_offset"])
    _text(value["resolved_benchmark"], nonempty=True)
    if (
        type(value["holding_period_days"]) is not int
        or not 1 <= value["holding_period_days"] <= 10000
    ):
        _fail()
    _text(value["evaluator_version"], nonempty=True)
    _sha(value["evaluator_code_sha256"])
    _sha(value["decision_text_sha256"])
    if any(value[key] != policy for key, policy in CONTRACT_POLICIES.items()):
        _fail()
    if (
        value["effective_history_parameters"] != HISTORY_PARAMETERS
        or not isinstance(value["effective_history_parameters"], dict)
        or any(
            type(value["effective_history_parameters"][key]) is not type(expected)
            for key, expected in HISTORY_PARAMETERS.items()
        )
    ):
        _fail()
    unknown_target = False
    if contract_version == 2:
        binding = validate_binding(value["target_binding"])
        if binding["targets"][1]["request_symbol"] != value["resolved_benchmark"]:
            _fail()
        if (
            utc_timestamp(binding["research_started_at"]) + _offset(value["host_utc_offset"])
        ).date().isoformat() != value["research_calendar_date"]:
            _fail()
        unknown_target = any(target["relation"] == "unknown" for target in binding["targets"])
    if value["analysis_date"] == value["research_calendar_date"] and unknown_target:
        if (
            value["evaluation_mode"] != "not_evaluable"
            or value["not_evaluable_reason"] != "target_resolution_unknown"
        ):
            _fail()
    elif value["analysis_date"] == value["research_calendar_date"]:
        if (
            value["evaluation_mode"] != "prospective_reference"
            or value["not_evaluable_reason"] is not None
        ):
            _fail()
    elif value["analysis_date"] < value["research_calendar_date"]:
        if (
            value["evaluation_mode"] != "not_evaluable"
            or value["not_evaluable_reason"] != "historical_decision_availability_unknown"
        ):
            _fail()
    else:
        _fail()
    _hash(value, "contract_sha256")
    return deepcopy(value)


def _artifact_ref(artifacts, reference, kind):
    _sha(reference)
    artifact = artifacts.get(reference)
    if artifact is None or artifact["kind"] != kind:
        _fail()
    return reference


def validate_decision(value) -> dict:
    """Validate a complete immutable decision snapshot, including every reference."""
    try:
        _bounded(value)
        _shape(
            value,
            (
                "schema_version",
                "run_id",
                "decision",
                "contract",
                "outcome",
                "reflection",
                "artifacts",
                "snapshot_sha256",
            ),
        )
        if type(value["schema_version"]) is not int or value["schema_version"] != 1:
            _fail()
        run_id = _uuid(value["run_id"])
        decision, contract = value["decision"], validate_contract(value["contract"])
        _shape(
            decision,
            (
                "schema_version",
                "decision_id",
                "run_id",
                "instrument",
                "asset_type",
                "analysis_date",
                "research_started_at",
                "research_as_of",
                "recorded_at",
                "analysis_calendar_date",
                "host_utc_offset",
                "rating",
                "decision_text_sha256",
                "contract_sha256",
                "evidence_bundle_sha256",
                "decision_sha256",
            ),
        )
        if type(decision["schema_version"]) is not int or decision["schema_version"] != 1:
            _fail()
        if _uuid(decision["decision_id"]) != run_id or _uuid(decision["run_id"]) != run_id:
            _fail()
        _text(decision["instrument"], nonempty=True)
        _text(decision["asset_type"], nonempty=True)
        _day(decision["analysis_date"])
        _day(decision["analysis_calendar_date"])
        started, recorded = (
            utc_timestamp(decision["research_started_at"]),
            utc_timestamp(decision["recorded_at"]),
        )
        utc_timestamp(decision["research_as_of"])
        if decision["research_as_of"] != decision["analysis_date"] + "T23:59:59.999999Z":
            _fail()
        if (
            recorded < started
            or (started + _offset(decision["host_utc_offset"])).date().isoformat()
            != decision["analysis_calendar_date"]
        ):
            _fail()
        if decision["rating"] not in ("Buy", "Overweight", "Hold", "Underweight", "Sell", "REVIEW"):
            _fail()
        _sha(decision["evidence_bundle_sha256"])
        if (
            decision["contract_sha256"] != contract["contract_sha256"]
            or decision["decision_text_sha256"] != contract["decision_text_sha256"]
            or decision["analysis_date"] != contract["analysis_date"]
            or decision["analysis_calendar_date"] != contract["research_calendar_date"]
            or decision["host_utc_offset"] != contract["host_utc_offset"]
        ):
            _fail()
        _hash(decision, "decision_sha256")
        if contract["schema_version"] == 2:
            binding = contract["target_binding"]
            if (
                binding["research_started_at"] != decision["research_started_at"]
                or binding["targets"][0]["requested_symbol"] != decision["instrument"]
            ):
                _fail()
        artifacts = value["artifacts"]
        if not isinstance(artifacts, dict) or len(artifacts) > 16:
            _fail()
        for key, artifact in artifacts.items():
            if _sha(key) != validate_artifact(artifact)["sha256"]:
                _fail()
        references = {_artifact_ref(artifacts, decision["decision_text_sha256"], "text")}
        if contract["schema_version"] == 2:
            from .targets import policy_artifact

            reference = _artifact_ref(
                artifacts, contract["target_binding"]["policy_artifact_sha256"], "canonical_json"
            )
            if artifacts[reference] != policy_artifact():
                _fail()
            references.add(reference)
        if not artifacts[decision["decision_text_sha256"]]["payload"]:
            _fail()
        outcome, reflection = value["outcome"], value["reflection"]
        if outcome is not None:
            _shape(
                outcome,
                (
                    "schema_version",
                    "contract_sha256",
                    "observed_at",
                    "status",
                    "reason",
                    "facts_sha256",
                    "calculation_sha256",
                    "outcome_sha256",
                ),
            )
            if type(outcome["schema_version"]) is not int or outcome["schema_version"] != 1:
                _fail()
            if (
                outcome["contract_sha256"] != contract["contract_sha256"]
                or utc_timestamp(outcome["observed_at"]) < recorded
            ):
                _fail()
            if outcome["status"] == "available":
                if (
                    contract["evaluation_mode"] != "prospective_reference"
                    or outcome["reason"] is not None
                ):
                    _fail()
                references.add(_artifact_ref(artifacts, outcome["facts_sha256"], "canonical_json"))
                references.add(
                    _artifact_ref(artifacts, outcome["calculation_sha256"], "canonical_json")
                )
            elif outcome["status"] == "not_evaluable":
                if not isinstance(outcome["reason"], str) or not _REASON.fullmatch(
                    outcome["reason"]
                ):
                    _fail()
                if outcome["facts_sha256"] is not None:
                    references.add(
                        _artifact_ref(artifacts, outcome["facts_sha256"], "canonical_json")
                    )
                if outcome["calculation_sha256"] is not None or reflection is not None:
                    _fail()
                if (
                    contract["evaluation_mode"] == "not_evaluable"
                    and outcome["reason"] != contract["not_evaluable_reason"]
                ):
                    _fail()
            else:
                _fail()
            _hash(outcome, "outcome_sha256")
        if reflection is not None:
            _shape(
                reflection,
                (
                    "schema_version",
                    "outcome_sha256",
                    "reflected_at",
                    "model_context_sha256",
                    "prompt_sha256",
                    "response_sha256",
                    "reflection_sha256",
                ),
            )
            if type(reflection["schema_version"]) is not int or reflection["schema_version"] != 1:
                _fail()
            if (
                outcome is None
                or outcome["status"] != "available"
                or reflection["outcome_sha256"] != outcome["outcome_sha256"]
            ):
                _fail()
            if utc_timestamp(reflection["reflected_at"]) < utc_timestamp(outcome["observed_at"]):
                _fail()
            for key, kind in (
                ("model_context_sha256", "canonical_json"),
                ("prompt_sha256", "text"),
                ("response_sha256", "text"),
            ):
                references.add(_artifact_ref(artifacts, reflection[key], kind))
            if not artifacts[reflection["response_sha256"]]["payload"]:
                _fail()
            _hash(reflection, "reflection_sha256")
        if set(artifacts) != references:
            _fail()
        if contract["schema_version"] == 2:
            from .targets import validate_saved_subjects

            validate_saved_subjects(decision, contract, outcome, artifacts)
        _hash(value, "snapshot_sha256")
        return deepcopy(value)
    except (KeyError, TypeError, ValueError, UnicodeError, RecursionError, OverflowError):
        raise MemoryValidationError() from None


def build_decision_snapshot(
    *,
    run_id,
    instrument,
    asset_type,
    analysis_date,
    research_started_at,
    research_as_of,
    recorded_at,
    analysis_calendar_date,
    host_utc_offset,
    rating,
    decision_text,
    contract,
    evidence_bundle_sha256,
) -> dict:
    artifact = make_artifact("text", decision_text)
    contract = validate_contract(contract)
    artifacts = {artifact["sha256"]: artifact}
    if contract["schema_version"] == 2:
        from .targets import policy_artifact

        policy = policy_artifact()
        artifacts[policy["sha256"]] = policy
    decision = make_component(
        {
            "schema_version": 1,
            "decision_id": run_id,
            "run_id": run_id,
            "instrument": instrument,
            "asset_type": asset_type,
            "analysis_date": analysis_date,
            "research_started_at": research_started_at,
            "research_as_of": research_as_of,
            "recorded_at": recorded_at,
            "analysis_calendar_date": analysis_calendar_date,
            "host_utc_offset": host_utc_offset,
            "rating": rating,
            "decision_text_sha256": artifact["sha256"],
            "contract_sha256": contract["contract_sha256"],
            "evidence_bundle_sha256": evidence_bundle_sha256,
        },
        "decision_sha256",
    )
    return validate_decision(
        make_component(
            {
                "schema_version": 1,
                "run_id": run_id,
                "decision": decision,
                "contract": contract,
                "outcome": None,
                "reflection": None,
                "artifacts": artifacts,
            },
            "snapshot_sha256",
        )
    )


def merge_decision(first, second) -> dict:
    """Strict monotonic union; no completed component can be replaced or removed."""
    first, second = validate_decision(first), validate_decision(second)
    for key in ("schema_version", "run_id", "decision", "contract"):
        if first[key] != second[key]:
            _fail()
    result = deepcopy(first)
    for key in ("outcome", "reflection"):
        if first[key] is not None and second[key] is not None and first[key] != second[key]:
            _fail()
        result[key] = first[key] if first[key] is not None else second[key]
    for key, artifact in second["artifacts"].items():
        if key in result["artifacts"] and result["artifacts"][key] != artifact:
            _fail()
        result["artifacts"][key] = artifact
    return validate_decision(make_component(result, "snapshot_sha256"))


def render_context(
    instrument: str, decisions: list[dict], *, selector_version=SELECTOR_VERSION
) -> str:
    """Render frozen records; model prose never supplies record boundaries."""
    same = [
        item
        for item in decisions
        if instrument_key(item["decision"]["instrument"]) == instrument_key(instrument)
    ]
    cross = [item for item in decisions if item not in same]
    sections = []
    for records, heading, full in (
        (same, f"Past analyses of {instrument} (most recent first):", True),
        (cross, "Recent cross-instrument lessons:", False),
    ):
        if not records:
            continue
        entries = [heading]
        for item in records:
            decision, outcome, reflection, artifacts = (
                item["decision"],
                item["outcome"],
                item["reflection"],
                item["artifacts"],
            )
            lines = [
                f"Memory decision {item['run_id']} | {decision['instrument']} | {decision['analysis_date']} | {decision['rating']}",
                "Research reference evaluation; not execution or realized strategy profit.",
            ]
            if full:
                lines += ["Decision:", artifacts[decision["decision_text_sha256"]]["payload"]]
            if selector_version == TARGET_SELECTOR_VERSION:
                if item["contract"]["schema_version"] == 1:
                    lines.append(
                        "Legacy completed reference: target was not frozen at research start; request/entity alignment is unknown."
                    )
                else:
                    for target in item["contract"]["target_binding"]["targets"]:
                        lines.append(
                            f"Frozen {target['role']} request: yfinance/yahoo_finance_ticker/{target['request_symbol']}; relation: {target['relation']}; request only, not provider/entity confirmation."
                        )
            lines += [
                f"Frozen benchmark: {item['contract']['resolved_benchmark']}; horizon: {item['contract']['holding_period_days']} common complete provider daily rows.",
                f"Outcome observed at: {outcome['observed_at']}",
                "Saved calculation:",
                artifacts[outcome["calculation_sha256"]]["payload"],
                f"Reflection completed at: {reflection['reflected_at']}",
                artifacts[reflection["response_sha256"]]["payload"],
            ]
            entries.append("\n".join(lines))
        sections.append("\n\n".join(entries))
    return "\n\n".join(sections)


def validate_context_snapshot(value) -> dict:
    try:
        _bounded(value)
        _shape(
            value,
            (
                "schema_version",
                "instrument",
                "selected_at",
                "research_cutoff",
                "availability_cutoff",
                "selector_version",
                "same_ticker_limit",
                "cross_ticker_limit",
                "decisions",
                "context_artifact",
                "raw_text_sha256",
                "context_sha256",
                "input_sha256",
            ),
        )
        if (
            type(value["schema_version"]) is not int
            or value["schema_version"] != 1
            or value["selector_version"] not in (SELECTOR_VERSION, TARGET_SELECTOR_VERSION)
        ):
            _fail()
        _text(value["instrument"], nonempty=True)
        selected, research, cutoff = (
            utc_timestamp(value[key])
            for key in ("selected_at", "research_cutoff", "availability_cutoff")
        )
        if cutoff != min(selected, research):
            _fail()
        for key in ("same_ticker_limit", "cross_ticker_limit"):
            if type(value[key]) is not int or not 0 <= value[key] <= MAX_CONTEXT_DECISIONS:
                _fail()
        if (
            not isinstance(value["decisions"], list)
            or len(value["decisions"]) > MAX_CONTEXT_DECISIONS
        ):
            _fail()
        ids, same, cross = set(), 0, 0
        for item in value["decisions"]:
            item = validate_decision(item)
            if (
                item["run_id"] in ids
                or item["outcome"] is None
                or item["reflection"] is None
                or item["outcome"]["status"] != "available"
            ):
                _fail()
            ids.add(item["run_id"])
            for timestamp in (
                item["decision"]["recorded_at"],
                item["outcome"]["observed_at"],
                item["reflection"]["reflected_at"],
            ):
                if utc_timestamp(timestamp) > cutoff:
                    _fail()
            if instrument_key(item["decision"]["instrument"]) == instrument_key(
                value["instrument"]
            ):
                same += 1
            else:
                cross += 1
        if same > value["same_ticker_limit"] or cross > value["cross_ticker_limit"]:
            _fail()

        def order(item):
            return (
                utc_timestamp(item["reflection"]["reflected_at"]),
                utc_timestamp(item["decision"]["recorded_at"]),
                item["run_id"],
            )

        same_items = [
            item
            for item in value["decisions"]
            if instrument_key(item["decision"]["instrument"]) == instrument_key(value["instrument"])
        ]
        cross_items = [item for item in value["decisions"] if item not in same_items]
        expected = sorted(same_items, key=order, reverse=True) + sorted(
            cross_items, key=order, reverse=True
        )
        if value["decisions"] != expected:
            _fail()
        artifact = validate_artifact(value["context_artifact"])
        if value["selector_version"] == SELECTOR_VERSION and any(
            item["contract"]["schema_version"] != 1 for item in value["decisions"]
        ):
            _fail()
        if artifact["kind"] != "text" or artifact["payload"] != render_context(
            value["instrument"], value["decisions"], selector_version=value["selector_version"]
        ):
            _fail()
        if value["raw_text_sha256"] != hashlib.sha256(
            artifact["payload"].encode("utf-8")
        ).hexdigest() or value["context_sha256"] != hash_value(artifact["payload"]):
            _fail()
        _hash(value, "input_sha256")
        return deepcopy(value)
    except (KeyError, TypeError, ValueError, UnicodeError, RecursionError, OverflowError):
        raise MemoryValidationError() from None


def validate_bundle(value) -> dict:
    try:
        _bounded(value)
        _shape(
            value,
            (
                "schema_version",
                "run_id",
                "instrument",
                "analysis_date",
                "evidence_bundle_sha256",
                "persistence_status",
                "input_snapshot",
                "decision_snapshot",
                "bundle_sha256",
            ),
        )
        if type(value["schema_version"]) is not int or value["schema_version"] != 1:
            _fail()
        _uuid(value["run_id"])
        _text(value["instrument"], nonempty=True)
        _day(value["analysis_date"])
        _sha(value["evidence_bundle_sha256"])
        if value["persistence_status"] not in ("durable", "memory_only"):
            _fail()
        context = validate_context_snapshot(value["input_snapshot"])
        decision = validate_decision(value["decision_snapshot"])
        if (
            decision["run_id"] != value["run_id"]
            or decision["decision"]["instrument"] != value["instrument"]
            or context["instrument"] != value["instrument"]
            or decision["decision"]["analysis_date"] != value["analysis_date"]
            or decision["decision"]["evidence_bundle_sha256"] != value["evidence_bundle_sha256"]
            or decision["decision"]["research_as_of"] != context["research_cutoff"]
            or utc_timestamp(context["selected_at"])
            < utc_timestamp(decision["decision"]["research_started_at"])
            or utc_timestamp(context["selected_at"])
            > utc_timestamp(decision["decision"]["recorded_at"])
            or any(item["run_id"] == value["run_id"] for item in context["decisions"])
        ):
            _fail()
        _hash(value, "bundle_sha256")
        return deepcopy(value)
    except (KeyError, TypeError, ValueError, UnicodeError, RecursionError, OverflowError):
        raise MemoryValidationError() from None


def validate_review_attachment(value, completion_bundle=None) -> dict:
    """A later snapshot never changes the immutable as-generated memory bundle."""
    try:
        _bounded(value)
        _shape(
            value, ("schema_version", "decision_id", "reviewed_at", "snapshot", "attachment_sha256")
        )
        if type(value["schema_version"]) is not int or value["schema_version"] != 1:
            _fail()
        snapshot = validate_decision(value["snapshot"])
        if _uuid(value["decision_id"]) != snapshot["run_id"]:
            _fail()
        reviewed = utc_timestamp(value["reviewed_at"])
        times = [snapshot["decision"]["recorded_at"]]
        if snapshot["outcome"] is not None:
            times.append(snapshot["outcome"]["observed_at"])
        if snapshot["reflection"] is not None:
            times.append(snapshot["reflection"]["reflected_at"])
        if any(utc_timestamp(timestamp) > reviewed for timestamp in times):
            _fail()
        if completion_bundle is not None:
            original = validate_bundle(completion_bundle)["decision_snapshot"]
            if (
                original["run_id"] != snapshot["run_id"]
                or original["decision"]["decision_sha256"]
                != snapshot["decision"]["decision_sha256"]
                or original["contract"]["contract_sha256"]
                != snapshot["contract"]["contract_sha256"]
            ):
                _fail()
            if merge_decision(original, snapshot) != snapshot:
                _fail()
        _hash(value, "attachment_sha256")
        return deepcopy(value)
    except (KeyError, TypeError, ValueError, UnicodeError, RecursionError, OverflowError):
        raise MemoryValidationError() from None


def build_review_attachment(snapshot, *, reviewed_at=None, completion_bundle=None) -> dict:
    snapshot = validate_decision(snapshot)
    return validate_review_attachment(
        make_component(
            {
                "schema_version": 1,
                "decision_id": snapshot["run_id"],
                "reviewed_at": reviewed_at if reviewed_at is not None else now_utc(),
                "snapshot": snapshot,
            },
            "attachment_sha256",
        ),
        completion_bundle,
    )
