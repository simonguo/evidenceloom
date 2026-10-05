"""Frozen request subjects and byte-exact legacy replay, entirely offline."""

from copy import deepcopy
from fractions import Fraction
import hashlib
import json
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import pandas as pd
import pytest

from tradingagents.dataflows import symbol_utils
from tradingagents.graph.research_memory import ResearchMemory
from tradingagents.memory import _evaluation_v1, evaluation, history_adapter, targets
from tradingagents.memory.schema import (
    MemoryValidationError,
    build_decision_snapshot,
    make_artifact,
    make_component,
    merge_decision,
    validate_decision,
    validate_context_snapshot,
)
from tradingagents.memory.store import MemoryStore

START = "2026-01-05T21:10:00.000000Z"
OBSERVED = "2026-01-15T18:00:00.000000Z"
FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def no_real_provider(monkeypatch):
    import yfinance

    monkeypatch.setattr(
        yfinance, "Ticker", Mock(side_effect=AssertionError("offline fixture only"))
    )


def snapshot(instrument="FICT_SOURCE_A", *, benchmark="FICT_BENCHMARK", legacy=False, run_id=None):
    arguments = dict(
        analysis_date="2026-01-05",
        holding_period_days=5,
        host_local_calendar_at_start="2026-01-05",
        host_utc_offset="+00:00",
    )
    plan = (
        evaluation.make_evaluation_plan(resolved_benchmark=benchmark, **arguments)
        if legacy
        else evaluation.make_target_evaluation_plan(
            instrument=instrument,
            benchmark=benchmark,
            research_started_at=START,
            **arguments,
        )
    )
    text = "Rating: Buy\nFictional reference thesis; no executable recommendation."
    return build_decision_snapshot(
        run_id=run_id or str(uuid4()),
        instrument=instrument,
        asset_type="stock",
        analysis_date="2026-01-05",
        research_started_at=START,
        research_as_of="2026-01-05T23:59:59.999999Z",
        recorded_at="2026-01-05T21:20:00.000000Z",
        analysis_calendar_date="2026-01-05",
        host_utc_offset="+00:00",
        rating="Buy",
        decision_text=text,
        contract=evaluation.bind_evaluation_contract(plan, make_artifact("text", text)["sha256"]),
        evidence_bundle_sha256="e" * 64,
    )


def prices(values):
    frame = pd.DataFrame(
        {"Close": values, "Adj Close": values, "Dividends": 0.0, "Stock Splits": 0.0},
        index=pd.bdate_range("2026-01-05", "2026-01-14", tz="America/New_York"),
    )
    frame.attrs["currency"] = "USD"
    return frame


def history():
    data = {
        "FICT_SOURCE_A": prices(
            [99, 100.12345678901, 101.4, 102.3, 103.2, 104.6, 111.23456789123, 112.9]
        ),
        "FICT_SOURCE_B": prices([99, 100, 105, 110, 120, 130, 150, 155]),
        "FICT_BENCHMARK": prices(
            [199, 200.34567890123, 202.2, 203.3, 204.4, 205.5, 218.45678901345, 220.1]
        ),
        "GC=F": prices([99, 100, 105, 110, 120, 130, 150, 155]),
    }
    return Mock(side_effect=lambda symbol, **_parameters: data[symbol].copy(deep=True))


def saved(item, result):
    item = deepcopy(item)
    item["outcome"] = deepcopy(result["outcome"])
    item["artifacts"].update(deepcopy(result["artifacts"]))
    return validate_decision(make_component(item, "snapshot_sha256"))


def rehash_contract(item, change):
    item = deepcopy(item)
    change(item["contract"])
    item["contract"] = make_component(item["contract"], "contract_sha256")
    item["decision"]["contract_sha256"] = item["contract"]["contract_sha256"]
    item["decision"] = make_component(item["decision"], "decision_sha256")
    return make_component(item, "snapshot_sha256")


def test_v2_request_does_not_follow_later_fictional_alias_and_replays_offline(monkeypatch):
    item = snapshot()
    frozen = deepcopy(item)
    # A future alias would change the v1 fetching path to fictional B.
    monkeypatch.setitem(symbol_utils._ALIASES, "FICT_SOURCE_A", "FICT_SOURCE_B")
    assert symbol_utils.normalize_symbol("FICT_SOURCE_A") == "FICT_SOURCE_B"
    fetch = history()
    result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=fetch)
    assert [call.args[0] for call in fetch.call_args_list] == ["FICT_SOURCE_A", "FICT_BENCHMARK"]
    expected = float(Fraction("111.23456789123") / Fraction("100.12345678901") - 1)
    assert result["calculation"]["raw_return"] == pytest.approx(expected, abs=1e-14)
    assert result["calculation"]["raw_return"] != 0.5
    completed = saved(item, result)
    monkeypatch.setattr(history_adapter, "history", Mock(side_effect=AssertionError("no refetch")))
    monkeypatch.setattr(
        _evaluation_v1, "normalize_symbol", Mock(side_effect=AssertionError("no late resolver"))
    )
    assert evaluation.replay_evaluation(completed)["calculation"] == result["calculation"]
    assert item == frozen


def test_archived_v1_source_and_shared_completed_snapshot_remain_exact(monkeypatch):
    assert (
        hashlib.sha256(Path(_evaluation_v1.__file__).read_bytes()).hexdigest()
        == evaluation.LEGACY_EVALUATOR_SHA256
    )
    item = json.loads((FIXTURES / "memory_bundle_v1.json").read_text())["input_snapshot"][
        "decisions"
    ][0]
    original = deepcopy(item)
    monkeypatch.setattr(
        _evaluation_v1, "normalize_symbol", Mock(side_effect=AssertionError("no resolver"))
    )
    monkeypatch.setattr(history_adapter, "history", Mock(side_effect=AssertionError("no provider")))
    result = evaluation.replay_evaluation(item)
    assert result["status"] == "available"
    assert result["calculation"]["raw_return"] == 126.25 / 123.45678901234567 - 1
    assert result["outcome"] == original["outcome"]
    assert item == original


def test_unknown_legacy_code_is_unverified_and_full_saved_body_is_retained():
    item = snapshot(legacy=True)
    item = saved(
        item,
        _evaluation_v1.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history()),
    )
    changed = deepcopy(item)
    changed["contract"]["evaluator_code_sha256"] = "f" * 64
    changed["contract"] = make_component(changed["contract"], "contract_sha256")
    changed["decision"]["contract_sha256"] = changed["contract"]["contract_sha256"]
    changed["decision"] = make_component(changed["decision"], "decision_sha256")
    changed["outcome"]["contract_sha256"] = changed["contract"]["contract_sha256"]
    changed["outcome"] = make_component(changed["outcome"], "outcome_sha256")
    changed = validate_decision(make_component(changed, "snapshot_sha256"))
    result = evaluation.replay_evaluation(changed)
    assert result["status"] == "unverified" and result["reason"] == "unsupported_legacy_evaluator"
    assert result["outcome"] == changed["outcome"] and result["artifacts"] == changed["artifacts"]
    result["artifacts"].clear()
    assert changed["artifacts"]


def test_legacy_pending_never_fetches_and_does_not_starve_five_eligible_entries(
    tmp_path, monkeypatch
):
    store = MemoryStore(storage_dir=tmp_path / "decisions")
    old = [store.record_decision(snapshot(legacy=True)) for _ in range(8)]
    new = [store.record_decision(snapshot()) for _ in range(6)]
    controller = ResearchMemory({}, Mock(), lambda: {})
    controller.store = store
    settle = Mock()
    monkeypatch.setattr(controller, "_settle", settle)
    forbidden = Mock(side_effect=AssertionError("no legacy fetch"))
    for item in old:
        assert (
            evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=forbidden)[
                "reason"
            ]
            == "legacy_target_not_frozen"
        )
    for _ in range(3):
        controller.settle_pending("FICT_SOURCE_A")
    assert settle.call_count == 15
    assert all(call.args[0]["contract"]["schema_version"] == 2 for call in settle.call_args_list)
    assert all(store.load_decision(item["run_id"])["outcome"] is None for item in old + new)
    forbidden.assert_not_called()
    assert controller.reflector.mock_calls == []


@pytest.mark.parametrize("instrument", ["000001", "700", "XAUUSD+", "ＡＡＡ", "", "FICT A"])
def test_unknown_target_does_not_fetch(instrument):
    if not instrument:
        with pytest.raises(MemoryValidationError):
            snapshot(instrument)
        return
    item = snapshot(instrument)
    fetch = Mock(side_effect=AssertionError("unsupported request must not fetch"))
    result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=fetch)
    assert result["status"] == "not_evaluable" and result["reason"] == "target_resolution_unknown"
    assert evaluation.replay_evaluation(saved(item, result))["outcome"] == result["outcome"]
    fetch.assert_not_called()


@pytest.mark.parametrize(
    "raw,request_symbol,relation",
    [
        ("600519.SH", "600519.SS", "venue_notation"),
        ("SH600519", "600519.SS", "venue_notation"),
        ("700.HK", "0700.HK", "venue_notation"),
        ("0700.HK", "0700.HK", "venue_notation"),
        ("EURUSD", "EURUSD=X", "pair_notation"),
        ("BTCUSD", "BTC-USD", "pair_notation"),
        ("GOLD", "GC=F", "proxy"),
        ("US500", "^GSPC", "proxy"),
        (" fict_source_a ", "FICT_SOURCE_A", "exact"),
    ],
)
def test_literal_policy_golden_targets(raw, request_symbol, relation):
    assert targets.derive_target("instrument", raw) == {
        "role": "instrument",
        "requested_symbol": raw,
        "request_symbol": request_symbol,
        "relation": relation,
    }


def test_proxy_reference_subject_is_saved_rederived_and_not_labeled_requested_asset_performance():
    item = snapshot("GOLD")
    result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history())
    assert result["calculation"]["reference_subjects"][0] == {
        "role": "instrument",
        "requested_symbol": "GOLD",
        "request_symbol": "GC=F",
        "relation": "proxy",
    }
    assert (
        result["calculation"]["interpretation"]
        == "provider_proxy_reference_not_requested_asset_performance_or_realized_profit"
    )
    assert evaluation.replay_evaluation(saved(item, result))["calculation"] == result["calculation"]


@pytest.mark.parametrize(
    "field", ["request_symbol", "relation", "role", "request_namespace", "policy_artifact_sha256"]
)
def test_rehashed_false_binding_and_crossrole_are_invalid(field):
    def change(contract):
        binding = contract["target_binding"]
        if field in ("request_namespace", "policy_artifact_sha256"):
            binding[field] = "other" if field == "request_namespace" else "f" * 64
        else:
            binding["targets"][0][field] = (
                "benchmark"
                if field == "role"
                else "proxy"
                if field == "relation"
                else "FICT_SOURCE_B"
            )
        contract["target_binding"] = make_component(binding, "binding_sha256")

    with pytest.raises(MemoryValidationError):
        validate_decision(rehash_contract(snapshot(), change))


def test_rehashed_cross_target_facts_do_not_replay_even_with_new_artifact_hash():
    item = snapshot()
    item = saved(
        item, evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history())
    )
    digest = item["outcome"]["facts_sha256"]
    payload = json.loads(item["artifacts"].pop(digest)["payload"])
    payload["sources"][0]["resolved_symbol"] = "FICT_SOURCE_B"
    artifact = make_artifact("canonical_json", payload)
    item["artifacts"][artifact["sha256"]] = artifact
    item["outcome"]["facts_sha256"] = artifact["sha256"]
    item["outcome"] = make_component(item["outcome"], "outcome_sha256")
    item = make_component(item, "snapshot_sha256")
    with pytest.raises(evaluation.EvaluationValidationError):
        evaluation.replay_evaluation(item)


def test_policy_reference_start_and_immutable_run_contract_are_bound(tmp_path):
    original = snapshot()
    missing = deepcopy(original)
    missing["artifacts"].pop(original["contract"]["target_binding"]["policy_artifact_sha256"])
    with pytest.raises(MemoryValidationError):
        validate_decision(make_component(missing, "snapshot_sha256"))

    def change_start(contract):
        binding = contract["target_binding"]
        binding["research_started_at"] = "2026-01-05T21:09:00.000000Z"
        contract["target_binding"] = make_component(binding, "binding_sha256")

    changed_start = rehash_contract(original, change_start)
    with pytest.raises(MemoryValidationError):
        validate_decision(changed_start)
    legacy = snapshot(legacy=True, run_id=original["run_id"])
    with pytest.raises(MemoryValidationError):
        merge_decision(legacy, original)
    store = MemoryStore(storage_dir=tmp_path / "saved")
    store.record_decision(legacy)
    with pytest.raises(MemoryValidationError):
        store.record_decision(original)


def test_existing_context_v1_exact_bytes_and_new_context_v2_legacy_limit():
    bundle = json.loads((FIXTURES / "memory_bundle_v1.json").read_text())
    assert validate_context_snapshot(bundle["input_snapshot"]) == bundle["input_snapshot"]
    prior = bundle["input_snapshot"]["decisions"][0]
    store = MemoryStore()
    store.record_decision(prior)
    context = store.context_snapshot(
        prior["decision"]["instrument"],
        "2026-01-15T23:59:59.999999Z",
        selected_at=OBSERVED,
        selector_version="recent-reflections-v2",
    )
    assert context["decisions"] == [prior]
    assert "target was not frozen at research start" in context["context_artifact"]["payload"]
    assert prior == bundle["input_snapshot"]["decisions"][0]


@pytest.mark.parametrize(
    "field", ["adapter_code_sha256", "resolver_code_sha256", "evaluator_code_sha256"]
)
def test_unknown_v2_code_identity_preserves_pending_and_prevents_provider(field):
    def change(contract):
        if field == "evaluator_code_sha256":
            contract[field] = "f" * 64
        else:
            binding = contract["target_binding"]
            binding[field] = "f" * 64
            contract["target_binding"] = make_component(binding, "binding_sha256")

    item = validate_decision(rehash_contract(snapshot(), change))
    original = deepcopy(item)
    fetch = Mock(side_effect=AssertionError("unsupported implementation must not fetch"))
    result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=fetch)
    assert result["status"] == "unverified" and result["outcome"] is None
    assert item == original and result["artifacts"] == original["artifacts"]
    fetch.assert_not_called()


def test_proxy_reflection_prompt_and_durable_reload_keep_named_reference(tmp_path, monkeypatch):
    item = snapshot("GOLD")
    result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history())
    store = MemoryStore(storage_dir=tmp_path / "saved")
    store.record_decision(item)
    store.attach_outcome(item["run_id"], result["outcome"], result["artifacts"])
    from tradingagents.graph.reflection import Reflector
    from types import SimpleNamespace

    llm = Mock()
    llm.invoke.return_value = SimpleNamespace(
        content="Fictional proxy reference observation, not spot asset performance."
    )
    controller = ResearchMemory({}, Reflector(llm), lambda: {})
    controller.store = store
    monkeypatch.setattr(
        history_adapter, "history", Mock(side_effect=AssertionError("saved facts only"))
    )
    controller._settle(store.load_decision(item["run_id"]))
    messages = llm.invoke.call_args.args[0]
    assert "proxy reference is not the requested asset's performance" in messages[0][1]
    assert "GC=F" in messages[1][1] and "provider_proxy_reference" in messages[1][1]
    reloaded = MemoryStore(storage_dir=tmp_path / "saved").load_decision(item["run_id"])
    prompt = reloaded["artifacts"][reloaded["reflection"]["prompt_sha256"]]["payload"]
    assert prompt == controller.reflector.reference_prompt_text(messages)
    assert evaluation.replay_evaluation(reloaded)["calculation"] == result["calculation"]


def test_rehashed_false_calculation_subject_and_return_fail_replay():
    item = snapshot()
    item = saved(
        item, evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history())
    )
    original = deepcopy(item)
    for field in ("reference_subjects", "raw_return"):
        changed = deepcopy(original)
        digest = changed["outcome"]["calculation_sha256"]
        payload = json.loads(changed["artifacts"].pop(digest)["payload"])
        if field == "reference_subjects":
            payload[field][0]["request_symbol"] = "FICT_SOURCE_B"
        else:
            payload[field] = 0.5
        artifact = make_artifact("canonical_json", payload)
        changed["artifacts"][artifact["sha256"]] = artifact
        changed["outcome"]["calculation_sha256"] = artifact["sha256"]
        changed["outcome"] = make_component(changed["outcome"], "outcome_sha256")
        changed = make_component(changed, "snapshot_sha256")
        with pytest.raises(evaluation.EvaluationValidationError):
            evaluation.replay_evaluation(changed)


@pytest.mark.parametrize(
    "instrument",
    ["https://internal.local/private", "Bearer abcdefghijklmnop", "C:\\private\\secret"],
)
def test_unsafe_original_selector_cannot_be_frozen(instrument):
    with pytest.raises(MemoryValidationError) as error:
        snapshot(instrument)
    assert instrument not in str(error.value)


def test_shared_candidate_fixture_full_values_hashes_and_completed_retry_are_preserved():
    from tradingagents.evidence import validate_evidence_bundle as validate_evidence
    from tradingagents.memory.schema import validate_bundle

    fixture = json.loads((FIXTURES / "memory_target_binding_v2.json").read_text())
    evidence, bundle = fixture["evidence"], fixture["bundle"]
    assert validate_evidence(evidence) == evidence
    assert validate_bundle(bundle) == bundle
    item = fixture["available_snapshot"]
    replay = evaluation.replay_evaluation(item)
    assert replay["status"] == "available"
    assert replay["calculation"]["entry_date"] == "2025-02-17"
    assert replay["calculation"]["exit_date"] == "2025-02-19"
    assert replay["calculation"]["raw_return"] == 126.25 / 123.45678901234567 - 1
    payload = item["artifacts"][item["outcome"]["facts_sha256"]]["payload"]
    assert "123.45678901234567" in payload and "1.0" in payload and "1e-07" in payload
    decision = bundle["decision_snapshot"]["decision"]
    state = {
        "memory_bundle": bundle,
        "asset_type": decision["asset_type"],
        "final_trade_decision": bundle["decision_snapshot"]["artifacts"][
            decision["decision_text_sha256"]
        ]["payload"],
        "research_memory": {
            "research_started_at": decision["research_started_at"],
            "input_snapshot": bundle["input_snapshot"],
            "evaluation_plan": {
                key: value
                for key, value in bundle["decision_snapshot"]["contract"].items()
                if key not in ("decision_text_sha256", "contract_sha256")
            },
        },
    }
    controller = ResearchMemory({}, Mock(), lambda: {})
    assert controller.record_final(state, evidence, decision["rating"]) == bundle
    missing_manifest = deepcopy(evidence)
    del missing_manifest["manifest"]["memory_target_binding_sha256"]
    with pytest.raises(ValueError, match="frozen evidence manifest"):
        controller.record_final(state, missing_manifest, decision["rating"])


def test_corrupted_saved_v2_source_reference_fails_read_only_without_repair(tmp_path):
    from tradingagents.memory.schema import canonical_json

    item = snapshot()
    result = evaluation.evaluate_decision(item, observed_at=OBSERVED, history_fetcher=history())
    store = MemoryStore(storage_dir=tmp_path / "decisions")
    store.record_decision(item)
    item = store.attach_outcome(item["run_id"], result["outcome"], result["artifacts"])
    digest = item["outcome"]["facts_sha256"]
    facts = json.loads(item["artifacts"].pop(digest)["payload"])
    facts["sources"][0]["resolved_symbol"] = "FICT_SOURCE_B"
    artifact = make_artifact("canonical_json", facts)
    item["artifacts"][artifact["sha256"]] = artifact
    item["outcome"]["facts_sha256"] = artifact["sha256"]
    item["outcome"] = make_component(item["outcome"], "outcome_sha256")
    item = make_component(item, "snapshot_sha256")
    path = tmp_path / "decisions" / item["run_id"] / "decision.json"
    path.write_text(canonical_json(item), encoding="utf-8")
    before = path.read_bytes()
    with pytest.raises(MemoryValidationError):
        MemoryStore(storage_dir=tmp_path / "decisions").load_decision(item["run_id"])
    assert path.read_bytes() == before
