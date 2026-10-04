"""Offline consumer, shared-observation and durable scheduler boundaries."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from tradingagents.evidence.ledger import validate_evidence_bundle
from tradingagents.graph import research_memory, trading_graph
from tradingagents.memory import evaluation, targets
from tradingagents.memory.schema import (
    MemoryValidationError,
    TARGET_SELECTOR_VERSION,
    canonical_json,
    hash_value,
    make_artifact,
    make_component,
    render_context,
    validate_context_snapshot,
    validate_decision,
)
from tradingagents.memory.store import MemoryStore
from tests.test_memory_target_binding import (
    FIXTURES,
    OBSERVED,
    history,
    prices,
    rehash_contract,
    saved,
    snapshot,
)


@pytest.fixture(autouse=True)
def no_real_provider(monkeypatch):
    import yfinance

    monkeypatch.setattr(yfinance, "Ticker", Mock(side_effect=AssertionError("offline only")))


def fixture():
    return json.loads((FIXTURES / "memory_target_binding_v2.json").read_text())


def reflected(item):
    item = deepcopy(item)
    artifacts = [
        make_artifact("canonical_json", {"model": "fictional-offline"}),
        make_artifact("text", "Fictional offline reference prompt."),
        make_artifact("text", "Fictional saved reference; no causal inference."),
    ]
    item["artifacts"].update({artifact["sha256"]: artifact for artifact in artifacts})
    item["reflection"] = make_component(
        {
            "schema_version": 1,
            "outcome_sha256": item["outcome"]["outcome_sha256"],
            "reflected_at": "2025-02-26T12:00:00.000000Z",
            "model_context_sha256": artifacts[0]["sha256"],
            "prompt_sha256": artifacts[1]["sha256"],
            "response_sha256": artifacts[2]["sha256"],
        },
        "reflection_sha256",
    )
    return validate_decision(make_component(item, "snapshot_sha256"))


def context_for(item, *, selector_version=TARGET_SELECTOR_VERSION):
    text = render_context("EVDM.TEST", [item], selector_version=selector_version)
    return make_component(
        {
            "schema_version": 1,
            "instrument": "EVDM.TEST",
            "selected_at": "2025-02-28T12:00:00.000000Z",
            "research_cutoff": "2025-02-28T23:59:59.999999Z",
            "availability_cutoff": "2025-02-28T12:00:00.000000Z",
            "selector_version": selector_version,
            "same_ticker_limit": 5,
            "cross_ticker_limit": 3,
            "decisions": [item],
            "context_artifact": make_artifact("text", text),
            "raw_text_sha256": hashlib.sha256(text.encode()).hexdigest(),
            "context_sha256": hash_value(text),
        },
        "input_sha256",
    )


def false_math_context(*, legacy=False):
    prior = (
        fixture()["legacy_completed_snapshot"]
        if legacy
        else reflected(fixture()["available_snapshot"])
    )
    digest = prior["outcome"]["calculation_sha256"]
    body = json.loads(prior["artifacts"].pop(digest)["payload"])
    body["raw_return"] = 0.5
    artifact = make_artifact("canonical_json", body)
    prior["artifacts"][artifact["sha256"]] = artifact
    prior["outcome"]["calculation_sha256"] = artifact["sha256"]
    prior["outcome"] = make_component(prior["outcome"], "outcome_sha256")
    prior["reflection"]["outcome_sha256"] = prior["outcome"]["outcome_sha256"]
    prior["reflection"] = make_component(prior["reflection"], "reflection_sha256")
    return context_for(
        validate_decision(make_component(prior, "snapshot_sha256")),
        selector_version="recent-reflections-v1" if legacy else TARGET_SELECTOR_VERSION,
    )


def completion_state(*, legacy=False, context=None):
    item = fixture()
    if legacy:
        bundle = json.loads((FIXTURES / "memory_bundle_v1.json").read_text())
        evidence = json.loads((FIXTURES / "memory_evidence_bundle_v1.json").read_text())
    else:
        bundle, evidence = item["bundle"], item["evidence"]
    decision = bundle["decision_snapshot"]["decision"]
    plan = {
        key: value
        for key, value in bundle["decision_snapshot"]["contract"].items()
        if key not in ("decision_text_sha256", "contract_sha256")
    }
    started = decision["research_started_at"]
    frozen_context = bundle["input_snapshot"]
    if context is not None:
        frozen_context = context
        started = "2025-02-28T09:00:00.000000Z"
        common = {
            "analysis_date": "2025-02-28",
            "holding_period_days": 2,
            "host_local_calendar_at_start": "2025-02-28",
            "host_utc_offset": "+00:00",
        }
        plan = (
            evaluation.make_evaluation_plan(resolved_benchmark="FICTIONAL.TEST", **common)
            if legacy
            else evaluation.make_target_evaluation_plan(
                instrument="EVDM.TEST",
                benchmark="FICTIONAL.TEST",
                research_started_at=started,
                **common,
            )
        )
        evidence["analysis_date"] = "2025-02-28"
        evidence["research_as_of"] = frozen_context["research_cutoff"]
        evidence["manifest"]["trade_date"] = "2025-02-28"
        evidence["manifest"]["memory_input_sha256"] = frozen_context["context_sha256"]
        if not legacy:
            evidence["manifest"]["memory_target_binding_sha256"] = plan["target_binding"][
                "binding_sha256"
            ]
    record = deepcopy(evidence["records"][0])
    record.update(
        id="ev-33333333333333333333333333333333",
        analyst="identity",
        tool="resolve_instrument_context",
        parameters={"ticker": evidence["instrument"]},
        sources=[],
        attempts=[],
    )
    raw_identity = "Fictional saved instrument context; provider identity unknown."
    artifact = {"kind": "tool_text", "payload": f"[E:{record['id']}]\n{raw_identity}"}
    record["output_sha256"] = hash_value(artifact)
    evidence["artifacts"][record["output_sha256"]] = artifact
    evidence["records"].append(record)
    evidence["manifest"]["instrument_identity_context_sha256"] = hash_value(raw_identity)
    evidence["manifest_sha256"] = hash_value(evidence["manifest"])
    evidence = validate_evidence_bundle(make_component(evidence, "bundle_sha256"))
    state = {
        "asset_type": decision["asset_type"],
        "final_trade_decision": bundle["decision_snapshot"]["artifacts"][
            decision["decision_text_sha256"]
        ]["payload"],
        "company_of_interest": evidence["instrument"],
        "trade_date": evidence["analysis_date"],
        "run_settings": evidence["manifest"],
        "evidence_bundle": evidence,
        "past_context": frozen_context["context_artifact"]["payload"],
        "instrument_context": artifact["payload"],
        "research_memory": {
            "research_started_at": started,
            "input_snapshot": frozen_context,
            "evaluation_plan": plan,
        },
    }
    return state, evidence, decision["rating"]


@pytest.mark.parametrize(
    "mode",
    [
        "marked_v1",
        "unmarked_v2",
        "missing_memory",
        "start",
        "instrument",
        "hash",
        "extra_plan",
        "extra_memory",
    ],
)
def test_target_binding_rejects_actual_checkpoint_and_completion_before_write(mode):
    state, evidence, rating = completion_state(legacy=mode == "marked_v1")
    if mode == "marked_v1":
        evidence["manifest"]["memory_target_binding_sha256"] = fixture()["bundle"][
            "decision_snapshot"
        ]["contract"]["target_binding"]["binding_sha256"]
    elif mode == "unmarked_v2":
        del evidence["manifest"]["memory_target_binding_sha256"]
    elif mode == "missing_memory":
        del state["research_memory"]
    elif mode == "start":
        state["research_memory"]["research_started_at"] = "2025-02-14T11:59:59.000000Z"
    elif mode == "instrument":
        binding = state["research_memory"]["evaluation_plan"]["target_binding"]
        binding["targets"][0] = targets.derive_target("instrument", "OTHER.TEST")
        state["research_memory"]["evaluation_plan"]["target_binding"] = make_component(
            binding, "binding_sha256"
        )
        evidence["manifest"]["memory_target_binding_sha256"] = state["research_memory"][
            "evaluation_plan"
        ]["target_binding"]["binding_sha256"]
    elif mode == "hash":
        evidence["manifest"]["memory_target_binding_sha256"] = "f" * 64
    elif mode == "extra_plan":
        state["research_memory"]["evaluation_plan"]["unrecognized"] = "fictional"
    else:
        state["research_memory"]["unrecognized"] = "fictional"
    evidence["manifest_sha256"] = hash_value(evidence["manifest"])
    evidence = validate_evidence_bundle(make_component(evidence, "bundle_sha256"))
    state.update(evidence_bundle=evidence, run_settings=evidence["manifest"])
    graph = trading_graph.TradingAgentsGraph.__new__(trading_graph.TradingAgentsGraph)
    with pytest.raises(ValueError):
        graph._validate_frozen_state(state)
    controller = research_memory.ResearchMemory({}, Mock(), lambda: {})
    with pytest.raises((ValueError, KeyError)):
        controller.record_final(state, evidence, rating)
    assert controller.store.list_decisions() == []


def test_target_binding_unmarked_legacy_and_valid_v2_checkpoint_remain_allowed():
    graph = trading_graph.TradingAgentsGraph.__new__(trading_graph.TradingAgentsGraph)
    for legacy in (True, False):
        state, evidence, _rating = completion_state(legacy=legacy)
        original = deepcopy(state)
        assert graph._validate_frozen_state(state) == evidence
        assert state == original


@pytest.mark.parametrize(
    "instrument,benchmark",
    [("FICT_SOURCE_A", "FICT_SOURCE_A"), ("GOLD", "GC=F"), ("XAUUSD", "GOLD")],
)
def test_same_request_uses_one_observation_preserving_roles_and_zero_difference(
    instrument, benchmark
):
    item = snapshot(instrument, benchmark=benchmark)
    fetch = Mock(
        side_effect=[
            prices([99, 100, 101, 102, 103, 104, 110, 111]),
            prices([99, 100, 105, 110, 120, 130, 150, 155]),
        ]
    )
    result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=fetch)
    assert fetch.call_count == 1
    assert result["status"] == "available"
    assert (
        result["calculation"]["raw_return"]
        == result["calculation"]["benchmark_return"]
        == pytest.approx(0.1)
    )
    assert result["calculation"]["return_difference"] == 0.0
    facts = next(
        json.loads(a["payload"])
        for a in result["artifacts"].values()
        if "sources" in json.loads(a["payload"])
    )
    assert [source["requested_symbol"] for source in facts["sources"]] == [instrument, benchmark]
    assert [source["relation"] for source in facts["sources"]] == [
        target["relation"] for target in item["contract"]["target_binding"]["targets"]
    ]
    assert facts["sources"][0]["rows"] == facts["sources"][1]["rows"]
    assert facts["sources"][0]["observed_at"] == facts["sources"][1]["observed_at"]
    assert evaluation.replay_evaluation(saved(item, result))["calculation"] == result["calculation"]


@pytest.mark.parametrize("field", ["rows", "observed_at", "currency", "issue"])
def test_same_request_coherently_rehashed_inconsistent_observations_reject(field):
    item = snapshot(benchmark="FICT_SOURCE_A")
    result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history())
    item = saved(item, result)
    digest = item["outcome"]["facts_sha256"]
    facts = json.loads(item["artifacts"].pop(digest)["payload"])
    changed = facts["sources"][1]
    if field == "rows":
        changed["rows"][1]["values"]["Adj Close"]["value"] += 1
    elif field == "observed_at":
        changed[field] = "2026-01-15T18:01:00.000000Z"
    elif field == "currency":
        changed[field] = "EUR"
    else:
        changed[field] = "no_price_rows"
    artifact = make_artifact("canonical_json", facts)
    item["artifacts"][artifact["sha256"]] = artifact
    item["outcome"]["facts_sha256"] = artifact["sha256"]
    item["outcome"] = make_component(item["outcome"], "outcome_sha256")
    item = make_component(item, "snapshot_sha256")
    with pytest.raises(MemoryValidationError):
        validate_decision(item)
    with pytest.raises(evaluation.EvaluationValidationError):
        evaluation.replay_evaluation(item)


@pytest.mark.parametrize("replacement", ["100", "1e2", "100.00000000000000001"])
def test_same_request_shared_saved_numeric_lexemes_must_be_identical(replacement):
    item = snapshot(benchmark="FICT_SOURCE_A")
    result = evaluation.evaluate_decision(
        item,
        observed_at=OBSERVED,
        history_fetcher=Mock(
            return_value=prices([99.0, 100.0, 101.0, 102.0, 103.0, 104.0, 110.0, 111.0])
        ),
    )
    item = saved(item, result)
    digest = item["outcome"]["facts_sha256"]
    payload = item["artifacts"].pop(digest)["payload"]
    prefix, second = payload.split('"role":"benchmark"', 1)
    assert '"value":100.0' in second
    second = second.replace('"value":100.0', f'"value":{replacement}', 1)
    changed = prefix + '"role":"benchmark"' + second
    # All three changes parse to the same binaryfloat. Raw payload equality still
    # detects altered int/float/exponent spelling and precision hidden by f64.
    assert json.loads(changed) == json.loads(payload)
    artifact = make_artifact("canonical_json", changed)
    item["artifacts"][artifact["sha256"]] = artifact
    item["outcome"]["facts_sha256"] = artifact["sha256"]
    item["outcome"] = make_component(item["outcome"], "outcome_sha256")
    item = make_component(item, "snapshot_sha256")
    with pytest.raises(MemoryValidationError):
        validate_decision(item)
    with pytest.raises(evaluation.EvaluationValidationError):
        evaluation.replay_evaluation(item)


def test_manually_expected_shared_fixture_selector_and_observation_vectors():
    for vector in fixture()["target_vectors"]:
        assert targets.derive_target("instrument", vector["requested_symbol"]) == {
            "role": "instrument",
            **vector,
        }
    for vector in fixture()["shared_observation_vectors"]:
        item = snapshot(vector["instrument"], benchmark=vector["benchmark"])
        fetch = Mock(return_value=prices([99, 100, 101, 102, 103, 104, 110, 111]))
        result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=fetch)
        assert fetch.call_count == vector["physical_request_count"] == 1
        assert fetch.call_args.args[0] == vector["request_symbol"]
        assert result["calculation"]["return_difference"] == float(vector["return_difference"])
        assert [
            target["relation"] for target in item["contract"]["target_binding"]["targets"]
        ] == vector["relations"]
        assert evaluation.replay_evaluation(saved(item, result))["status"] == "available"


def test_context_v2_false_math_archive_retained_but_actual_consumers_reject(tmp_path, monkeypatch):
    context = false_math_context()
    assert (
        validate_context_snapshot(context) == context
    )  # Hash/reference proof alone is not arithmetic.
    before = canonical_json(context)
    with pytest.raises(evaluation.EvaluationValidationError):
        evaluation.admit_research_context(context)
    state, evidence, rating = completion_state(context=context)
    graph = trading_graph.TradingAgentsGraph.__new__(trading_graph.TradingAgentsGraph)
    with pytest.raises(evaluation.EvaluationValidationError):
        graph._validate_frozen_state(state)
    controller = research_memory.ResearchMemory({}, Mock(), lambda: {})
    with pytest.raises(evaluation.EvaluationValidationError):
        controller.record_final(state, evidence, rating)
    assert controller.store.list_decisions() == []
    # Actual initial-state consumer must stop before identity/provider observation.
    graph.config = {"holding_period_days": 2, "benchmark_ticker": "FICTIONAL.TEST"}
    graph.selected_analysts = ["market"]
    graph._resolve_pending_entries = Mock()
    graph._research_memory = Mock(
        return_value=SimpleNamespace(
            store=SimpleNamespace(context_snapshot=Mock(return_value=context))
        )
    )
    forbidden_identity = Mock(side_effect=AssertionError("no identity/provider call"))
    monkeypatch.setattr(trading_graph, "resolve_instrument_identity", forbidden_identity)
    with pytest.raises(evaluation.EvaluationValidationError):
        graph.create_run_state("EVDM.TEST", "2025-02-28")
    forbidden_identity.assert_not_called()
    assert canonical_json(context) == before


def test_context_v2_valid_completed_archive_and_current_math_admit_without_provider(monkeypatch):
    item = fixture()
    context = context_for(reflected(item["available_snapshot"]))
    forbidden = Mock(side_effect=AssertionError("offline admission only"))
    monkeypatch.setattr(evaluation.history_adapter, "history", forbidden)
    assert evaluation.admit_research_context(context) == context
    old = json.loads((FIXTURES / "memory_bundle_v1.json").read_text())["input_snapshot"]
    assert evaluation.admit_research_context(old) == old
    new = context_for(item["legacy_completed_snapshot"])
    assert evaluation.admit_research_context(new) == new
    forbidden.assert_not_called()


def test_coherent_selector_downgrade_cannot_admit_marked_v2_run():
    context = context_for(
        fixture()["legacy_completed_snapshot"], selector_version="recent-reflections-v1"
    )
    assert validate_context_snapshot(context) == context
    assert evaluation.admit_research_context(context) == context
    state, evidence, rating = completion_state(context=context)
    graph = trading_graph.TradingAgentsGraph.__new__(trading_graph.TradingAgentsGraph)
    with pytest.raises(evaluation.EvaluationValidationError):
        graph._validate_frozen_state(state)
    controller = research_memory.ResearchMemory({}, Mock(), lambda: {})
    with pytest.raises(evaluation.EvaluationValidationError):
        controller.record_final(state, evidence, rating)
    assert controller.store.list_decisions() == []


def test_legacy_selector_false_math_is_preserved_for_archive_but_rejected_for_model_resume():
    context = false_math_context(legacy=True)
    assert validate_context_snapshot(context) == context
    with pytest.raises(evaluation.EvaluationValidationError):
        evaluation.admit_research_context(context)
    state, evidence, rating = completion_state(legacy=True, context=context)
    graph = trading_graph.TradingAgentsGraph.__new__(trading_graph.TradingAgentsGraph)
    with pytest.raises(evaluation.EvaluationValidationError):
        graph._validate_frozen_state(state)
    controller = research_memory.ResearchMemory({}, Mock(), lambda: {})
    with pytest.raises(evaluation.EvaluationValidationError):
        controller.record_final(state, evidence, rating)
    assert controller.store.list_decisions() == []


def test_legacy_selector_unknown_implementation_remains_archive_not_model_authority():
    prior = fixture()["legacy_completed_snapshot"]
    prior["contract"]["evaluator_code_sha256"] = "f" * 64
    prior["contract"] = make_component(prior["contract"], "contract_sha256")
    prior["decision"]["contract_sha256"] = prior["contract"]["contract_sha256"]
    prior["decision"] = make_component(prior["decision"], "decision_sha256")
    prior["outcome"]["contract_sha256"] = prior["contract"]["contract_sha256"]
    prior["outcome"] = make_component(prior["outcome"], "outcome_sha256")
    prior["reflection"]["outcome_sha256"] = prior["outcome"]["outcome_sha256"]
    prior["reflection"] = make_component(prior["reflection"], "reflection_sha256")
    prior = validate_decision(make_component(prior, "snapshot_sha256"))
    context = context_for(prior, selector_version="recent-reflections-v1")
    assert validate_context_snapshot(context) == context
    assert evaluation.replay_evaluation(prior)["status"] == "unverified"
    with pytest.raises(evaluation.EvaluationValidationError):
        evaluation.admit_research_context(context)


def test_fair_scheduler_restart_reaches_sixth_with_first_five_pending(tmp_path, monkeypatch):
    path = tmp_path / "memory.md"
    queued = [snapshot(run_id=f"{n:08d}-0000-4000-8000-000000000000") for n in range(1, 7)]
    store = MemoryStore(path)
    for item in queued:
        if item["run_id"] != queued[-1]["run_id"]:
            item = rehash_contract(
                item, lambda contract: contract.update(holding_period_days=10000)
            )
        store.record_decision(item)
    attempted = []

    def evaluate(item):
        attempted.append(item["run_id"])
        return evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history())

    monkeypatch.setattr(research_memory, "evaluate_decision", evaluate)
    for _ in range(2):
        reflector = Mock()
        reflector.reference_reflection_messages.side_effect = RuntimeError(
            "offline fixture stops before model"
        )
        controller = research_memory.ResearchMemory(
            {"memory_log_path": str(path)}, reflector, lambda: {}
        )
        controller.settle_pending("FICT_SOURCE_A")
        reflector.invoke_reference_reflection.assert_not_called()
    assert attempted[:5] == [item["run_id"] for item in queued[:5]]
    assert attempted[5] == queued[-1]["run_id"] and len(attempted) == 10
    assert MemoryStore(path).load_decision(queued[-1]["run_id"])["outcome"]["status"] == "available"
    assert all(
        MemoryStore(path).load_decision(item["run_id"])["outcome"] is None for item in queued[:5]
    )


def test_fair_scheduler_cursor_wrap_new_entries_and_nonblocking_shared_lock(tmp_path):
    path = tmp_path / "memory.md"
    first = MemoryStore(path)
    ids = [f"{n:08d}-0000-4000-8000-000000000000" for n in range(1, 7)]
    with first.review_batch("FICT", ids) as batch:
        assert batch == ids[:5]
        with MemoryStore(path).review_batch("fict", ids) as busy:
            assert busy == []
    with MemoryStore(path).review_batch("FICT", ids) as second:
        assert second == [ids[5], *ids[:4]]
    added = ["00000000-0000-4000-8000-000000000000", *ids, "00000007-0000-4000-8000-000000000000"]
    with MemoryStore(path).review_batch("FICT", added) as third:
        assert third == [ids[4], ids[5], added[-1], added[0], ids[0]]
    assert first.list_decisions() == []  # Scheduler metadata never becomes a decision.


def test_fair_scheduler_cursor_serializes_across_actual_processes(tmp_path):
    path = tmp_path / "memory.md"
    ids = [f"{n:08d}-0000-4000-8000-000000000000" for n in range(1, 7)]
    program = """import json,sys
from tradingagents.memory.store import MemoryStore
with MemoryStore(sys.argv[1]).review_batch('FICT',json.loads(sys.argv[2])) as ids:
    print(json.dumps(ids),flush=True)
"""
    environment = dict(
        os.environ,
        PYTHONPATH=str(Path(__file__).resolve().parents[1]),
        EVIDENCELOOM_BOOTSTRAP_ONLY="1",
    )
    with MemoryStore(path).review_batch("FICT", ids):
        result = subprocess.run(
            [sys.executable, "-c", program, str(path), json.dumps(ids)],
            capture_output=True,
            text=True,
            env=environment,
            timeout=10,
        )
        assert result.returncode == 0 and json.loads(result.stdout) == []
    result = subprocess.run(
        [sys.executable, "-c", program, str(path), json.dumps(ids)],
        capture_output=True,
        text=True,
        env=environment,
        timeout=10,
    )
    assert result.returncode == 0 and json.loads(result.stdout) == [ids[5], *ids[:4]]


def test_fair_scheduler_reloads_after_delayed_prelock_list_before_reflection(tmp_path):
    item = snapshot()
    item = saved(
        item, evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history())
    )

    def reflector(label):
        value = Mock()
        value.reference_reflection_messages.return_value = [
            ("system", "Fictional offline reflection."),
            ("user", "Fictional saved observations only."),
        ]
        value.reference_prompt_text.return_value = "Fictional offline prompt " + label
        value.invoke_reference_reflection.return_value = "Fictional offline response " + label
        return value

    path = tmp_path / "memory.md"
    first = research_memory.ResearchMemory(
        {"memory_log_path": str(path)}, reflector("first"), lambda: {}
    )
    second = research_memory.ResearchMemory(
        {"memory_log_path": str(path)}, reflector("second"), lambda: {}
    )
    first.store.record_decision(item)
    collected, finished = threading.Event(), threading.Event()
    actual_list = second.store.list_decisions

    def delayed_list():
        stale = actual_list()
        collected.set()
        assert finished.wait(10), "bounded fictional race did not release"
        return stale

    second.store.list_decisions = delayed_list
    thread = threading.Thread(target=second.settle_pending, args=("FICT_SOURCE_A",))
    thread.start()
    try:
        assert collected.wait(10), "bounded fictional race did not collect"
        first.settle_pending("FICT_SOURCE_A")
        retained = first.store.load_decision(item["run_id"])
        assert retained["reflection"] is not None
    finally:
        finished.set()
        thread.join(10)
    assert not thread.is_alive()
    assert first.reflector.invoke_reference_reflection.call_count == 1
    second.reflector.invoke_reference_reflection.assert_not_called()
    assert second.store.load_decision(item["run_id"]) == retained


def test_fair_scheduler_corrupt_cursor_defers_without_provider_or_outcome(tmp_path, monkeypatch):
    path = tmp_path / "memory.md"
    item = snapshot()
    controller = research_memory.ResearchMemory({"memory_log_path": str(path)}, Mock(), lambda: {})
    controller.store.record_decision(item)
    with controller.store.review_batch("FICT_SOURCE_A", [item["run_id"]]):
        pass
    cursor = next((path.parent / "decisions-v1" / "scheduler-v1").glob("*/cursor.json"))
    cursor.write_text('{"schema_version":1,"schema_version":1,"last_run_id":"bad"}')
    forbidden = Mock(side_effect=AssertionError("corrupt cursor must not invoke evaluation"))
    monkeypatch.setattr(research_memory, "evaluate_decision", forbidden)
    controller.settle_pending("FICT_SOURCE_A")
    forbidden.assert_not_called()
    assert controller.store.load_decision(item["run_id"]) == item
    assert '"last_run_id":"bad"' in cursor.read_text()
