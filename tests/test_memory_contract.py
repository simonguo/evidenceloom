"""Memory authority and historical availability are independent of model prose."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest

from cli.research_manifest import context_sha256
from tradingagents.memory import (
    MemoryStore,
    MemoryValidationError,
    build_decision_snapshot,
    build_review_attachment,
    hash_value,
    make_artifact,
    make_component,
    merge_decision,
    validate_artifact,
    validate_bundle,
    validate_context_snapshot,
    validate_decision,
    validate_review_attachment,
)
from tradingagents.memory.schema import CONTRACT_POLICIES, HISTORY_PARAMETERS, parse_json

FIXTURES = Path(__file__).parent / "fixtures"


def snapshot(
    index=1,
    *,
    instrument="EVDM.TEST",
    analysis_date="2025-02-14",
    calendar_date=None,
    recorded_at=None,
    text="Rating: Hold\nFictional decision.",
):
    calendar_date = calendar_date or analysis_date
    contract = make_component(
        {
            "schema_version": 1,
            "analysis_date": analysis_date,
            "research_calendar_date": calendar_date,
            "host_utc_offset": "+00:00",
            "resolved_benchmark": "FICTIONAL.TEST",
            "holding_period_days": 2,
            "evaluation_mode": "prospective_reference"
            if calendar_date == analysis_date
            else "not_evaluable",
            "not_evaluable_reason": None
            if calendar_date == analysis_date
            else "historical_decision_availability_unknown",
            "evaluator_version": "common-daily-adjusted-close-v1",
            "evaluator_code_sha256": "b" * 64,
            "effective_history_parameters": deepcopy(HISTORY_PARAMETERS),
            "decision_text_sha256": make_artifact("text", text)["sha256"],
            **CONTRACT_POLICIES,
        },
        "contract_sha256",
    )
    return build_decision_snapshot(
        run_id=f"{index:08x}-1111-4111-8111-{index:012x}",
        instrument=instrument,
        asset_type="stock",
        analysis_date=analysis_date,
        research_started_at=f"{calendar_date}T11:59:00.000000Z",
        research_as_of=f"{analysis_date}T23:59:59.999999Z",
        recorded_at=recorded_at or f"{calendar_date}T12:05:00.000000Z",
        analysis_calendar_date=calendar_date,
        host_utc_offset="+00:00",
        rating="Hold",
        decision_text=text,
        contract=contract,
        evidence_bundle_sha256="c" * 64,
    )


def outcome(snapshot, observed_at="2025-02-20T12:00:00.000000Z"):
    facts = make_artifact(
        "canonical_json",
        {
            "fixture": "Fictional saved observations, no provider retrieval",
            "prices": [123.45678901234567, 1.0, 1e-07],
            "endpoint_date": "2025-02-19",
            "timezone": "UTC",
        },
    )
    calculation = make_artifact(
        "canonical_json",
        {
            "raw_return": 0.012345678901234567,
            "benchmark_return": 0.0012345678901234567,
            "excess_return": 0.011111111011111111,
        },
    )
    value = make_component(
        {
            "schema_version": 1,
            "contract_sha256": snapshot["contract"]["contract_sha256"],
            "observed_at": observed_at,
            "status": "available",
            "reason": None,
            "facts_sha256": facts["sha256"],
            "calculation_sha256": calculation["sha256"],
        },
        "outcome_sha256",
    )
    return value, {item["sha256"]: item for item in (facts, calculation)}


def reflected(
    snapshot,
    *,
    observed_at="2025-02-20T12:00:00.000000Z",
    reflected_at="2025-02-21T12:00:00.000000Z",
):
    store = MemoryStore()
    store.record_decision(snapshot)
    value, artifacts = outcome(snapshot, observed_at)
    store.attach_outcome(snapshot["run_id"], value, artifacts)
    prompt = make_artifact("text", "Review the fictional saved outcome exactly.")
    model = make_artifact("canonical_json", {"llm_provider": "fictional", "model": "offline"})
    response = make_artifact("text", "Fictional reflection. No real research claim.")
    reflection = make_component(
        {
            "schema_version": 1,
            "outcome_sha256": value["outcome_sha256"],
            "reflected_at": reflected_at,
            "model_context_sha256": model["sha256"],
            "prompt_sha256": prompt["sha256"],
            "response_sha256": response["sha256"],
        },
        "reflection_sha256",
    )
    return store.attach_reflection(
        snapshot["run_id"], reflection, {item["sha256"]: item for item in (prompt, model, response)}
    )


def rehash_snapshot(value):
    value["decision"] = make_component(value["decision"], "decision_sha256")
    value["contract"] = make_component(value["contract"], "contract_sha256")
    if value["outcome"] is not None:
        value["outcome"] = make_component(value["outcome"], "outcome_sha256")
    if value["reflection"] is not None:
        value["reflection"] = make_component(value["reflection"], "reflection_sha256")
    return make_component(value, "snapshot_sha256")


def independent_hash(value, own_key):
    body = {key: item for key, item in value.items() if key != own_key}
    encoded = json.dumps(
        body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()
    return hashlib.sha256(encoded).hexdigest()


def write_fixture_bundles():
    """Regenerate cross-language fixtures from the current offline evaluator."""
    import pandas as pd
    from tradingagents.evidence import validate_evidence_bundle
    from tradingagents.memory.evaluation import evaluate_decision, evaluator_code_sha256

    def actual_snapshot(run_id, analysis_date, evidence_sha="c" * 64):
        value = snapshot(analysis_date=analysis_date)
        value["run_id"] = run_id
        value["contract"]["evaluator_code_sha256"] = evaluator_code_sha256()
        value["contract"] = make_component(value["contract"], "contract_sha256")
        value["decision"].update(
            run_id=run_id,
            decision_id=run_id,
            contract_sha256=value["contract"]["contract_sha256"],
            evidence_bundle_sha256=evidence_sha,
        )
        return rehash_snapshot(value)

    store = MemoryStore()
    prior = actual_snapshot("22222222-2222-4222-8222-222222222222", "2025-02-07")
    dates = pd.to_datetime(["2025-02-10", "2025-02-11", "2025-02-12"], utc=True)
    asset = pd.DataFrame(
        {
            "Close": [123.45678901234567, 124.5, 126.25],
            "Adj Close": [123.45678901234567, 124.5, 126.25],
            "Dividends": [0.0, 1e-07, 0.0],
            "Stock Splits": [0.0] * 3,
        },
        index=dates,
    )
    benchmark = pd.DataFrame(
        {
            "Close": [1.0, 1.01, 1.02],
            "Adj Close": [1.0, 1.01, 1.02],
            "Dividends": [0.0] * 3,
            "Stock Splits": [0.0] * 3,
        },
        index=dates,
    )
    evaluated = evaluate_decision(
        prior,
        observed_at="2025-02-13T12:00:00.000000Z",
        history_fetcher=lambda symbol, **_kwargs: (
            benchmark if symbol == "FICTIONAL.TEST" else asset
        ).copy(),
    )
    assert evaluated["status"] == "available"
    store.record_decision(prior)
    saved = store.attach_outcome(prior["run_id"], evaluated["outcome"], evaluated["artifacts"])
    prompt = make_artifact(
        "text",
        "Review the exact fictional saved reference-price outcome. No actual securities or external retrieval.",
    )
    model = make_artifact(
        "canonical_json", {"llm_provider": "fictional", "model": "offline-scripted"}
    )
    response = make_artifact(
        "text",
        "Entirely fictional fixture reflection. Reference return difference does not establish execution or thesis causality.",
    )
    reflection = make_component(
        {
            "schema_version": 1,
            "outcome_sha256": saved["outcome"]["outcome_sha256"],
            "reflected_at": "2025-02-13T12:01:00.000000Z",
            "model_context_sha256": model["sha256"],
            "prompt_sha256": prompt["sha256"],
            "response_sha256": response["sha256"],
        },
        "reflection_sha256",
    )
    store.attach_reflection(
        prior["run_id"], reflection, {item["sha256"]: item for item in (prompt, model, response)}
    )
    context = store.context_snapshot(
        "EVDM.TEST",
        research_cutoff="2025-02-14T23:59:59.999999Z",
        selected_at="2025-02-14T12:00:00.000000Z",
    )
    evidence = json.loads((FIXTURES / "evidence_bundle_v1.json").read_text())
    evidence["manifest"].update(
        memory_input_sha256=context["context_sha256"],
        holding_period_days=2,
        benchmark_ticker="FICTIONAL.TEST",
    )
    evidence["manifest_sha256"] = hash_value(evidence["manifest"])
    evidence = make_component(evidence, "bundle_sha256")
    validate_evidence_bundle(evidence)
    current = actual_snapshot(evidence["run_id"], "2025-02-14", evidence["bundle_sha256"])
    store.record_decision(current)
    bundle = store.bundle(
        current["run_id"], context, evidence_bundle_sha256=evidence["bundle_sha256"]
    )
    bundle = make_component({**bundle, "persistence_status": "durable"}, "bundle_sha256")
    validate_bundle(bundle)
    for filename, value in (
        ("memory_bundle_v1.json", bundle),
        ("memory_evidence_bundle_v1.json", evidence),
    ):
        (FIXTURES / filename).write_text(
            json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        )


def test_static_fixture_and_evidence_binding_use_independent_canonical_hashes():
    bundle = json.loads((FIXTURES / "memory_bundle_v1.json").read_text())
    evidence = json.loads((FIXTURES / "memory_evidence_bundle_v1.json").read_text())
    assert validate_bundle(bundle) == bundle
    assert bundle["bundle_sha256"] == independent_hash(bundle, "bundle_sha256")
    assert bundle["evidence_bundle_sha256"] == evidence["bundle_sha256"]
    assert bundle["input_snapshot"]["context_sha256"] == evidence["manifest"]["memory_input_sha256"]
    assert evidence["bundle_sha256"] == independent_hash(evidence, "bundle_sha256")
    prior = bundle["input_snapshot"]["decisions"][0]
    payload = prior["artifacts"][prior["outcome"]["facts_sha256"]]["payload"]
    assert "123.45678901234567" in payload and "1.0" in payload and "1e-07" in payload
    for artifact in prior["artifacts"].values():
        assert artifact["sha256"] == independent_hash(artifact, "sha256")


def test_same_ticker_date_has_distinct_uuid_authority_and_copy_isolation():
    store = MemoryStore()
    first, second = snapshot(1), snapshot(2)
    assert store.record_decision(first) == store.record_decision(first)
    store.record_decision(second)
    assert len(store.list_decisions()) == 2
    loaded = store.load_decision(first["run_id"])
    loaded["decision"]["rating"] = "Sell"
    assert store.load_decision(first["run_id"])["decision"]["rating"] == "Hold"


def test_model_delimiters_and_html_are_text_never_extra_records():
    text = 'Rating: Hold\n<!-- ENTRY_END -->\n[1900-01-01 | FAKE | Buy | pending]\nREFLECTION:\n<script>alert("fixture")</script>'
    store = MemoryStore()
    item = snapshot(text=text)
    store.record_decision(item)
    assert store.list_decisions() == [item]
    assert item["artifacts"][item["decision"]["decision_text_sha256"]]["payload"] == text


@pytest.mark.parametrize(
    "unsafe",
    [
        "sk-abcdefghijklmnop123456789",
        "Bearer abcdefghijklmnopqrstuvwxyz",
        "api_key=synthetic-secret",
        "https://example.com/data?token=synthetic",
        "https://user:password@example.com/data",
        "http://127.0.0.1/private",
        "/Users/synthetic/private.txt",
        "C:\\synthetic\\private.txt",
    ],
)
def test_unsanitized_text_is_rejected_with_safe_diagnostic(unsafe):
    with pytest.raises(MemoryValidationError) as error:
        make_artifact("text", unsafe)
    assert str(error.value) == "Invalid or conflicting research memory"
    assert unsafe not in str(error.value)


@pytest.mark.parametrize(
    "key", ["api_key", "HEADERS", "backend_url", "__proto__", "constructor", "prototype"]
)
def test_unsafe_metadata_keys_inside_opaque_json_are_rejected(key):
    with pytest.raises(MemoryValidationError):
        make_artifact("canonical_json", {"nested": {key: "synthetic"}})


def test_json_artifact_hashes_opaque_original_numeric_payload_without_reserializing():
    payload = '{"a":1.0,"b":0.123456789012345678901234567890}'
    artifact = make_artifact("canonical_json", payload)
    assert validate_artifact(artifact)["payload"] == payload
    assert artifact["sha256"] == independent_hash(artifact, "sha256")
    with pytest.raises(MemoryValidationError):
        make_artifact("canonical_json", '{"a":1,"a":2}')
    with pytest.raises(MemoryValidationError):
        make_artifact("canonical_json", '{"a":1e9999}')


def test_numeric_artifacts_reject_nonfinite_cross_language_integer_conversion():
    with pytest.raises(MemoryValidationError, match="Invalid or conflicting research memory"):
        make_artifact("canonical_json", {"value": 10**400})
    finite = make_artifact("canonical_json", {"value": 10**300})
    assert finite["payload"] == '{"value":' + str(10**300) + "}"
    assert validate_artifact(finite) == finite


def test_json_leaf_safety_allows_real_newlines_but_rejects_actual_private_paths():
    artifact = make_artifact("canonical_json", {"text": "Recorded decision:\nFictional"})
    assert validate_artifact(artifact) == artifact
    for value in (
        "C:\\private\\fixture.txt",
        "Bearer syntheticcredential",
        "api_key=synthetic-secret",
    ):
        with pytest.raises(MemoryValidationError):
            make_artifact("canonical_json", {"text": value})


@pytest.mark.parametrize(
    "field,value",
    [
        ("rating", "Maybe"),
        ("recorded_at", "2025-02-13T12:00:00Z"),
        ("host_utc_offset", "+99:00"),
        ("research_as_of", "2025-02-14T12:00:00Z"),
        ("decision_id", "00000002-1111-4111-8111-000000000002"),
    ],
)
def test_rehashed_malformed_decision_is_still_rejected(field, value):
    item = snapshot()
    item["decision"][field] = value
    with pytest.raises(MemoryValidationError):
        validate_decision(rehash_snapshot(item))


def test_rehashed_unicode_offset_rejected_in_both_frozen_components():
    item = snapshot()
    item["contract"]["host_utc_offset"] = "+٠٨:٠٠"
    item["contract"] = make_component(item["contract"], "contract_sha256")
    item["decision"]["contract_sha256"] = item["contract"]["contract_sha256"]
    item["decision"]["host_utc_offset"] = "+٠٨:٠٠"
    with pytest.raises(MemoryValidationError):
        validate_decision(rehash_snapshot(item))


def test_calendar_offset_overflow_has_fixed_safe_diagnostic():
    item = snapshot(analysis_date="9999-12-31")
    item["contract"]["host_utc_offset"] = "+23:59"
    item["contract"] = make_component(item["contract"], "contract_sha256")
    item["decision"]["contract_sha256"] = item["contract"]["contract_sha256"]
    item["decision"]["host_utc_offset"] = "+23:59"
    with pytest.raises(MemoryValidationError, match="Invalid or conflicting research memory"):
        validate_decision(rehash_snapshot(item))


@pytest.mark.parametrize(
    "key,value", [("auto_adjust", 0), ("actions", 1), ("holding_period_days", True)]
)
def test_exact_policy_types_and_safe_numeric_envelopes(key, value):
    item = snapshot()
    if key == "holding_period_days":
        item["contract"][key] = value
    else:
        item["contract"]["effective_history_parameters"][key] = value
    item["contract"] = make_component(item["contract"], "contract_sha256")
    item["decision"]["contract_sha256"] = item["contract"]["contract_sha256"]
    with pytest.raises(MemoryValidationError):
        validate_decision(rehash_snapshot(item))
    for unsafe in (0.5, 2**53):
        item = snapshot()
        item["decision"]["rating"] = unsafe
        with pytest.raises(MemoryValidationError):
            validate_decision(rehash_snapshot(item))


def test_full_completed_outcome_and_reflection_are_monotonic_immutable_components():
    base, completed = snapshot(), reflected(snapshot())
    assert merge_decision(base, completed) == completed
    assert merge_decision(completed, base) == completed
    conflicting = deepcopy(completed)
    conflicting["outcome"]["observed_at"] = "2025-02-20T12:01:00Z"
    conflicting = rehash_snapshot(conflicting)
    with pytest.raises(MemoryValidationError):
        merge_decision(completed, conflicting)
    cross_run = snapshot(2)
    with pytest.raises(MemoryValidationError):
        merge_decision(base, cross_run)


def test_missing_or_orphan_artifact_and_wrong_outcome_reference_are_rejected():
    completed = reflected(snapshot())
    for mutation in ("missing", "orphan", "wrong_contract", "early_reflection"):
        item = deepcopy(completed)
        if mutation == "missing":
            item["artifacts"].pop(item["outcome"]["facts_sha256"])
        elif mutation == "orphan":
            extra = make_artifact("text", "Unreferenced synthetic text")
            item["artifacts"][extra["sha256"]] = extra
        elif mutation == "wrong_contract":
            item["outcome"]["contract_sha256"] = "d" * 64
        else:
            item["reflection"]["reflected_at"] = "2025-02-19T12:00:00Z"
        with pytest.raises(MemoryValidationError):
            validate_decision(rehash_snapshot(item))


def test_historical_context_filters_actual_observed_and_reflected_times_not_endpoint():
    store = MemoryStore()
    item = reflected(
        snapshot(analysis_date="2025-01-01"),
        observed_at="2025-03-01T12:00:00Z",
        reflected_at="2025-03-02T12:00:00Z",
    )
    store.record_decision(item)
    earlier = store.context_snapshot(
        "EVDM.TEST", "2025-02-28T23:59:59.999999Z", selected_at="2025-04-01T12:00:00Z"
    )
    assert earlier["decisions"] == []
    assert earlier["context_artifact"]["payload"] == ""
    at_observation = store.context_snapshot(
        "EVDM.TEST", "2025-03-01T23:59:59.999999Z", selected_at="2025-04-01T12:00:00Z"
    )
    assert at_observation["decisions"] == []
    later = store.context_snapshot(
        "EVDM.TEST", "2025-03-02T12:00:00Z", selected_at="2025-04-01T12:00:00Z"
    )
    assert later["decisions"] == [item]
    text = later["context_artifact"]["payload"]
    assert later["context_sha256"] == context_sha256(text)
    assert later["raw_text_sha256"] == hashlib.sha256(text.encode()).hexdigest()
    assert later["availability_cutoff"] == "2025-03-02T12:00:00Z"


def test_context_snapshot_is_ordered_frozen_and_legacy_markdown_never_enters_authority(tmp_path):
    legacy = tmp_path / "trading_memory.md"
    legacy.write_text(
        "[1900-01-01 | EVDM.TEST | Buy | +99% | resolved:1900-01-02]\nREFLECTION:\nInvented legacy lesson."
    )
    store = MemoryStore(legacy)
    assert store.list_decisions() == []
    first = reflected(snapshot(1), reflected_at="2025-02-21T12:00:00Z")
    second = reflected(snapshot(2), reflected_at="2025-02-22T12:00:00Z")
    cross = reflected(snapshot(3, instrument="OTHER.TEST"), reflected_at="2025-02-23T12:00:00Z")
    for item in (first, second, cross):
        store.record_decision(item)
    frozen = store.context_snapshot(
        "EVDM.TEST",
        "2025-02-28T23:59:59.999999Z",
        selected_at="2025-02-24T12:00:00Z",
        same_ticker_limit=1,
        cross_ticker_limit=1,
    )
    assert [item["run_id"] for item in frozen["decisions"]] == [second["run_id"], cross["run_id"]]
    store.record_decision(reflected(snapshot(4), reflected_at="2025-02-25T12:00:00Z"))
    assert validate_context_snapshot(frozen) == frozen
    assert len(store.list_decisions()) == 4
    assert "Invented legacy" not in frozen["context_artifact"]["payload"]


def test_context_hash_cannot_contradict_declared_decision_payload():
    store = MemoryStore()
    store.record_decision(reflected(snapshot()))
    context = store.context_snapshot(
        "EVDM.TEST", "2025-02-28T23:59:59.999999Z", selected_at="2025-02-22T12:00:00Z"
    )
    context["context_artifact"] = make_artifact("text", "Different model-visible lesson")
    context["raw_text_sha256"] = hashlib.sha256(b"Different model-visible lesson").hexdigest()
    context["context_sha256"] = hash_value("Different model-visible lesson")
    with pytest.raises(MemoryValidationError):
        validate_context_snapshot(make_component(context, "input_sha256"))


def test_review_attachment_binds_completion_and_does_not_mutate_frozen_bundle():
    store = MemoryStore()
    base = snapshot()
    store.record_decision(base)
    context = store.context_snapshot(
        "EVDM.TEST", base["decision"]["research_as_of"], selected_at="2025-02-14T12:00:00Z"
    )
    bundle = store.bundle(base["run_id"], context, evidence_bundle_sha256="c" * 64)
    attachment = build_review_attachment(
        reflected(base), reviewed_at="2025-02-22T12:00:00Z", completion_bundle=bundle
    )
    assert validate_review_attachment(attachment, bundle) == attachment
    assert bundle["decision_snapshot"]["outcome"] is None
    assert bundle["persistence_status"] == "memory_only"
    with pytest.raises(MemoryValidationError):
        build_review_attachment(
            reflected(snapshot(2)), reviewed_at="2025-02-22T12:00:00Z", completion_bundle=bundle
        )
    with pytest.raises(MemoryValidationError):
        build_review_attachment(reflected(base), reviewed_at="2025-02-20T12:00:00Z")


def test_strict_json_parsing_and_bundle_identity_reject_silent_metadata_changes():
    with pytest.raises(MemoryValidationError):
        parse_json('{"schema_version":1,"schema_version":2}')
    with pytest.raises(MemoryValidationError):
        parse_json('{"price":NaN}')
    bundle = json.loads((FIXTURES / "memory_bundle_v1.json").read_text())
    bundle["instrument"] = "OTHER.TEST"
    with pytest.raises(MemoryValidationError):
        validate_bundle(make_component(bundle, "bundle_sha256"))
