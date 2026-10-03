"""Immutable daily reference outcomes from realistic, entirely offline prices."""

from copy import deepcopy
import json
from pathlib import Path
from unittest.mock import Mock
from uuid import uuid4

import pandas as pd
import pytest

from tradingagents.memory import evaluation
from tradingagents.memory.evaluation import (
    EvaluationValidationError,
    bind_evaluation_contract,
    evaluate_decision,
    evaluator_code_sha256,
    make_evaluation_plan,
    replay_evaluation,
)
from tradingagents.memory.schema import (
    HISTORY_PARAMETERS,
    MemoryValidationError,
    build_decision_snapshot,
    make_artifact,
    make_component,
    validate_decision,
)

pytestmark = pytest.mark.unit
OBSERVED = "2026-01-15T18:00:00Z"


def _plan(**changes):
    arguments = {
        "analysis_date": "2026-01-05",
        "resolved_benchmark": "BM-A",
        "holding_period_days": 5,
        "host_local_calendar_at_start": "2026-01-05",
        "host_utc_offset": "+00:00",
    }
    return make_evaluation_plan(**{**arguments, **changes})


def _snapshot(
    *,
    plan=None,
    instrument="AAA",
    recorded_at="2026-01-05T21:20:00Z",
    started_at="2026-01-05T21:10:00Z",
    text="Buy: durable thesis.\n<!-- ENTRY_END -->",
):
    plan = plan or _plan()
    artifact = make_artifact("text", text)
    contract = bind_evaluation_contract(plan, artifact["sha256"])
    return build_decision_snapshot(
        run_id=str(uuid4()),
        instrument=instrument,
        asset_type="stock",
        analysis_date=plan["analysis_date"],
        research_started_at=started_at,
        research_as_of=plan["analysis_date"] + "T23:59:59.999999Z",
        recorded_at=recorded_at,
        analysis_calendar_date=plan["research_calendar_date"],
        host_utc_offset=plan["host_utc_offset"],
        rating="Buy",
        decision_text=text,
        contract=contract,
        evidence_bundle_sha256="e" * 64,
    )


def _prices(dates, prices, *, zone="America/New_York", closes=None):
    index = pd.DatetimeIndex(pd.to_datetime(dates))
    if zone is not None:
        index = index.tz_localize(zone)
    frame = pd.DataFrame(
        {
            "Close": closes if closes is not None else prices,
            "Adj Close": prices,
            "Dividends": 0.0,
            "Stock Splits": 0.0,
        },
        index=index,
    )
    frame.attrs["currency"] = "USD"
    return frame


def _standard_frames():
    dates = pd.bdate_range("2026-01-05", "2026-01-14")
    return {
        "AAA": _prices(
            dates, [99, 100.12345678901, 101.4, 102.3, 103.2, 104.6, 111.23456789123, 112.9]
        ),
        "BM-A": _prices(
            dates, [199, 200.34567890123, 202.2, 203.3, 204.4, 205.5, 218.45678901345, 220.1]
        ),
    }


def _fetcher(frames):
    return Mock(side_effect=lambda symbol, **parameters: frames[symbol].copy(deep=True))


def _payload(result, reference):
    return json.loads(result["artifacts"][result["outcome"][reference]]["payload"])


def _saved(snapshot, result):
    assert result["outcome"] is not None
    snapshot = deepcopy(snapshot)
    snapshot["outcome"] = deepcopy(result["outcome"])
    snapshot["artifacts"].update(deepcopy(result["artifacts"]))
    return validate_decision(make_component(snapshot, "snapshot_sha256"))


def _rehash_payload(snapshot, reference, payload):
    snapshot = deepcopy(snapshot)
    old = snapshot["outcome"][reference]
    artifact = make_artifact("canonical_json", payload)
    del snapshot["artifacts"][old]
    snapshot["artifacts"][artifact["sha256"]] = artifact
    snapshot["outcome"][reference] = artifact["sha256"]
    snapshot["outcome"] = make_component(snapshot["outcome"], "outcome_sha256")
    return validate_decision(make_component(snapshot, "snapshot_sha256"))


def test_plan_freezes_five_and_original_benchmark_before_decision_text_binding(monkeypatch):
    original = _plan()
    later = _plan(holding_period_days=20, resolved_benchmark="BM-B")
    assert later["holding_period_days"] == 20 and later["resolved_benchmark"] == "BM-B"
    original_hash = original["evaluator_code_sha256"]
    monkeypatch.setattr(evaluation, "evaluator_code_sha256", lambda: "b" * 64)
    bound = bind_evaluation_contract(original, make_artifact("text", "new decision")["sha256"])
    assert bound["holding_period_days"] == 5 and bound["resolved_benchmark"] == "BM-A"
    assert bound["evaluator_code_sha256"] == original_hash
    assert "decision_text_sha256" not in original


def test_full_precision_prices_exact_requests_and_reference_formulas():
    snapshot = _snapshot()
    fetch = _fetcher(_standard_frames())
    result = evaluate_decision(snapshot, observed_at=OBSERVED, history_fetcher=fetch)
    assert result["status"] == "available"
    assert [call.args[0] for call in fetch.call_args_list] == ["AAA", "BM-A"]
    assert all(
        call.kwargs == {**HISTORY_PARAMETERS, "start": "2026-01-05", "end": "2026-01-15"}
        for call in fetch.call_args_list
    )
    facts = _payload(result, "facts_sha256")
    calculation = _payload(result, "calculation_sha256")
    assert calculation["entry_date"] == "2026-01-06"
    assert calculation["exit_date"] == "2026-01-13"
    assert calculation["selected_common_dates"] == [
        "2026-01-06",
        "2026-01-07",
        "2026-01-08",
        "2026-01-09",
        "2026-01-12",
        "2026-01-13",
    ]
    expected = 111.23456789123 / 100.12345678901 - 1
    expected_benchmark = 218.45678901345 / 200.34567890123 - 1
    assert calculation["raw_return"] == expected
    assert calculation["return_difference"] == expected - expected_benchmark
    assert facts["sources"][0]["rows"][1]["values"]["Adj Close"]["value"] == 100.12345678901
    assert "100.12345678901" in result["artifacts"][result["outcome"]["facts_sha256"]]["payload"]
    assert facts["sources"][0]["timezone"] == "America/New_York"
    assert facts["sources"][0]["rows"][1]["timestamp"] == "2026-01-06T00:00:00-05:00"
    assert facts["sources"][0]["rows"][1]["utc_offset"] == "-05:00"
    assert facts["limitations"]["provider_revision"] == "unknown"
    assert facts["limitations"]["exchange_calendar_coverage"] == "unknown"
    assert "capm" in calculation["interpretation"]
    saved = _saved(snapshot, result)
    assert replay_evaluation(saved)["calculation"] == calculation


def test_frozen_benchmark_survives_current_alias_resolver_drift(monkeypatch):
    original_resolver = evaluation.normalize_symbol
    resolved_at_start = original_resolver("SPX500")
    assert resolved_at_start == "^GSPC"
    snapshot = _snapshot(plan=_plan(resolved_benchmark=resolved_at_start))
    frames = _standard_frames()
    frames[resolved_at_start] = frames.pop("BM-A")
    monkeypatch.setattr(
        evaluation,
        "normalize_symbol",
        lambda symbol: "^NDX" if symbol == resolved_at_start else original_resolver(symbol),
    )
    fetch = _fetcher(frames)
    result = evaluate_decision(snapshot, observed_at=OBSERVED, history_fetcher=fetch)
    assert result["status"] == "available"
    assert [call.args[0] for call in fetch.call_args_list] == ["AAA", "^GSPC"]
    benchmark = _payload(result, "facts_sha256")["sources"][1]
    assert benchmark["requested_symbol"] == benchmark["resolved_symbol"] == "^GSPC"
    assert replay_evaluation(_saved(snapshot, result))["calculation"] == result["calculation"]


def test_replay_rejects_rehashed_benchmark_substitution_even_with_matching_calculation():
    snapshot = _snapshot()
    result = evaluate_decision(
        snapshot, observed_at=OBSERVED, history_fetcher=_fetcher(_standard_frames())
    )
    saved = _saved(snapshot, result)
    facts = _payload(result, "facts_sha256")
    facts["sources"][1]["resolved_symbol"] = "BM-B"
    saved = _rehash_payload(saved, "facts_sha256", facts)
    calculation = _payload(result, "calculation_sha256")
    calculation["endpoints"][1]["resolved_symbol"] = "BM-B"
    saved = _rehash_payload(saved, "calculation_sha256", calculation)
    with pytest.raises(EvaluationValidationError, match="could not be verified"):
        replay_evaluation(saved)


def test_live_observation_times_are_recorded_after_each_provider_result(monkeypatch):
    snapshot = _snapshot()
    times = iter([OBSERVED, "2026-01-15T18:00:03Z", "2026-01-15T18:00:07Z"])
    order = []

    def clock():
        order.append("clock")
        return next(times)

    frames = _standard_frames()

    def fetch(symbol, **_parameters):
        order.append(symbol)
        return frames[symbol].copy(deep=True)

    monkeypatch.setattr(evaluation, "now_utc", clock)
    result = evaluate_decision(snapshot, history_fetcher=fetch)
    assert order == ["clock", "AAA", "clock", "BM-A", "clock"]
    facts = _payload(result, "facts_sha256")
    assert facts["observation_cutoff"] == OBSERVED
    assert [source["observed_at"] for source in facts["sources"]] == [
        "2026-01-15T18:00:03Z",
        "2026-01-15T18:00:07Z",
    ]
    assert result["outcome"]["observed_at"] == "2026-01-15T18:00:07Z"
    assert replay_evaluation(_saved(snapshot, result))["calculation"] == result["calculation"]


def test_crypto_weekend_waits_for_identical_equity_dates_without_stale_asof_prices():
    snapshot = _snapshot(
        plan=_plan(
            analysis_date="2026-01-10",
            host_local_calendar_at_start="2026-01-10",
            holding_period_days=2,
        ),
        instrument="BTCUSD",
        started_at="2026-01-10T11:00:00Z",
        recorded_at="2026-01-10T12:00:00Z",
    )
    crypto_dates = pd.date_range("2026-01-09", "2026-01-19")
    equity_dates = pd.bdate_range("2026-01-09", "2026-01-19")
    frames = {
        "BTC-USD": _prices(crypto_dates, range(100, 111), zone="UTC"),
        "BM-A": _prices(equity_dates, range(200, 207)),
    }
    result = evaluate_decision(
        snapshot, observed_at="2026-01-20T18:00:00Z", history_fetcher=_fetcher(frames)
    )
    calculation = _payload(result, "calculation_sha256")
    assert calculation["entry_date"] == "2026-01-12"
    assert calculation["exit_date"] == "2026-01-14"
    assert calculation["selected_common_dates"] == ["2026-01-12", "2026-01-13", "2026-01-14"]
    for endpoint in calculation["endpoints"]:
        assert endpoint["entry"]["date"] == "2026-01-12"
        assert endpoint["exit"]["date"] == "2026-01-14"
    facts = _payload(result, "facts_sha256")
    assert facts["sources"][0]["requested_symbol"] == "BTCUSD"
    assert facts["sources"][0]["resolved_symbol"] == "BTC-USD"


def test_entry_must_follow_recorded_date_in_both_source_zones_and_utc():
    snapshot = _snapshot(
        plan=_plan(
            analysis_date="2026-01-06",
            host_local_calendar_at_start="2026-01-06",
            holding_period_days=1,
        ),
        started_at="2026-01-06T23:30:00Z",
        recorded_at="2026-01-06T23:50:00Z",
    )
    dates = pd.bdate_range("2026-01-06", "2026-01-12")
    frames = {
        "AAA": _prices(dates, [100, 101, 102, 103, 104], zone="Asia/Tokyo"),
        "BM-A": _prices(dates, [200, 201, 202, 203, 204]),
    }
    fetch = _fetcher(frames)
    pending = evaluate_decision(snapshot, observed_at="2026-01-10T00:30:00Z", history_fetcher=fetch)
    assert pending["status"] == "pending" and pending["outcome"] is None
    # The benchmark's Jan 9 local date has not elapsed at 00:30 UTC.
    available = evaluate_decision(
        snapshot, observed_at="2026-01-10T06:00:00Z", history_fetcher=fetch
    )
    calculation = _payload(available, "calculation_sha256")
    assert calculation["entry_after_date"] == "2026-01-07"
    assert calculation["entry_date"] == "2026-01-08" and calculation["exit_date"] == "2026-01-09"


def test_host_calendar_offset_freezes_mode_without_becoming_market_timezone():
    plan = _plan(
        analysis_date="2026-01-06",
        host_local_calendar_at_start="2026-01-06",
        host_utc_offset="+08:00",
        holding_period_days=1,
    )
    snapshot = _snapshot(
        plan=plan, started_at="2026-01-05T23:30:00Z", recorded_at="2026-01-06T01:00:00Z"
    )
    result = evaluate_decision(
        snapshot, observed_at=OBSERVED, history_fetcher=_fetcher(_standard_frames())
    )
    assert result["status"] == "available"
    assert _payload(result, "facts_sha256")["sources"][0]["timezone"] == "America/New_York"
    assert _payload(result, "calculation_sha256")["entry_date"] == "2026-01-07"


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ("no_timezone", "timezone_unknown"),
        ("missing_adjusted_close", "adjusted_close_unavailable"),
        ("nonmidnight", "daily_label_ambiguous"),
        ("nanosecond", "daily_label_ambiguous"),
        ("identical_duplicate", "duplicate_session_labels"),
        ("conflicting_duplicate", "duplicate_session_labels"),
    ],
)
def test_ambiguous_or_unadjusted_source_tables_cannot_settle(change, reason):
    frames = _standard_frames()
    asset = frames["AAA"]
    if change == "no_timezone":
        asset.index = asset.index.tz_localize(None)
    elif change == "missing_adjusted_close":
        asset.drop(columns="Adj Close", inplace=True)
    elif change in ("nonmidnight", "nanosecond"):
        asset.index += (
            pd.Timedelta(hours=1) if change == "nonmidnight" else pd.Timedelta(nanoseconds=1)
        )
    else:
        duplicate = asset.iloc[[1]].copy()
        if change == "conflicting_duplicate":
            duplicate["Adj Close"] = 987.654321
        frames["AAA"] = pd.concat([asset, duplicate])
    snapshot = _snapshot()
    result = evaluate_decision(snapshot, observed_at=OBSERVED, history_fetcher=_fetcher(frames))
    assert result["status"] == "not_evaluable" and result["reason"] == reason
    assert result["outcome"]["calculation_sha256"] is None
    assert replay_evaluation(_saved(snapshot, result))["status"] == "not_evaluable"


def test_missing_common_rows_remain_pending_with_observations_not_terminal_outcomes():
    frames = _standard_frames()
    frames["BM-A"] = frames["BM-A"].iloc[:3]
    result = evaluate_decision(_snapshot(), observed_at=OBSERVED, history_fetcher=_fetcher(frames))
    assert result["status"] == "pending" and result["reason"] == "common_window_incomplete"
    assert result["outcome"] is None and len(result["artifacts"]) == 1
    facts = json.loads(next(iter(result["artifacts"].values()))["payload"])
    assert len(facts["sources"][0]["rows"]) == 8 and len(facts["sources"][1]["rows"]) == 3


def test_splits_and_dividends_use_observed_adjusted_close_not_raw_close_loss():
    dates = pd.bdate_range("2026-01-05", "2026-01-09")
    asset = _prices(dates, [50, 50, 51, 52, 53], closes=[100, 100, 50, 51, 52])
    asset.loc[asset.index[2], "Stock Splits"] = 2
    asset.loc[asset.index[2], "Dividends"] = 1.234567890123
    benchmark = _prices(dates, [200, 200, 200, 200, 200])
    result = evaluate_decision(
        _snapshot(plan=_plan(holding_period_days=1)),
        observed_at=OBSERVED,
        history_fetcher=_fetcher({"AAA": asset, "BM-A": benchmark}),
    )
    calculation = _payload(result, "calculation_sha256")
    assert calculation["raw_return"] == 51 / 50 - 1
    assert calculation["raw_return"] != 50 / 100 - 1
    action_row = _payload(result, "facts_sha256")["sources"][0]["rows"][2]
    assert action_row["values"]["Stock Splits"]["value"] == 2
    assert action_row["values"]["Dividends"]["value"] == 1.234567890123


def test_nonfinite_and_unsupported_cells_are_explicit_and_never_stored_as_nan_or_secrets():
    frames = _standard_frames()
    frames["AAA"]["Close"] = frames["AAA"]["Close"].astype(object)
    frames["AAA"].iloc[0, frames["AAA"].columns.get_loc("Close")] = "api_key=private-secret"
    frames["AAA"].iloc[1, frames["AAA"].columns.get_loc("Adj Close")] = float("nan")
    frames["AAA"].iloc[2, frames["AAA"].columns.get_loc("Dividends")] = float("inf")
    result = evaluate_decision(
        _snapshot(plan=_plan(holding_period_days=1)),
        observed_at=OBSERVED,
        history_fetcher=_fetcher(frames),
    )
    assert result["status"] == "available"
    rows = _payload(result, "facts_sha256")["sources"][0]["rows"]
    assert rows[0]["values"]["Close"] == {"status": "unsupported", "value": None}
    assert rows[1]["values"]["Adj Close"] == {"status": "nonfinite", "value": None}
    assert rows[2]["values"]["Dividends"] == {"status": "nonfinite", "value": None}
    assert "private-secret" not in json.dumps(result)
    assert _payload(result, "calculation_sha256")["entry_date"] == "2026-01-07"


def test_historical_date_only_decision_is_terminal_without_any_price_request():
    snapshot = _snapshot(
        plan=_plan(host_local_calendar_at_start="2026-02-05"),
        started_at="2026-02-05T21:10:00Z",
        recorded_at="2026-02-05T21:20:00Z",
    )
    fetch = Mock(side_effect=AssertionError("must not fetch historical outcome"))
    result = evaluate_decision(snapshot, observed_at="2026-02-10T18:00:00Z", history_fetcher=fetch)
    fetch.assert_not_called()
    assert result["status"] == "not_evaluable"
    assert result["reason"] == "historical_decision_availability_unknown"
    assert result["outcome"]["facts_sha256"] is None


@pytest.mark.parametrize(
    ("field", "value", "reason"),
    [
        ("evaluator_version", "a-future-evaluator", "unsupported_evaluator_version"),
        ("evaluator_code_sha256", "f" * 64, "evaluator_code_mismatch"),
    ],
)
def test_unknown_evaluator_does_not_silently_recompute_with_current_code(field, value, reason):
    plan = _plan()
    plan[field] = value
    fetch = Mock()
    snapshot = _snapshot(plan=plan)
    result = evaluate_decision(snapshot, observed_at=OBSERVED, history_fetcher=fetch)
    fetch.assert_not_called()
    assert result["status"] == "not_evaluable" and result["reason"] == reason
    assert replay_evaluation(_saved(snapshot, result))["reason"] == reason


def test_provider_errors_are_pending_fixed_categories_without_exception_body():
    fetch = Mock(side_effect=RuntimeError("https://private/path?apikey=private-secret"))
    result = evaluate_decision(_snapshot(), observed_at=OBSERVED, history_fetcher=fetch)
    assert result["status"] == "pending" and result["reason"] == "provider_unavailable"
    assert result["outcome"] is None
    assert "private-secret" not in json.dumps(result) and "private/path" not in json.dumps(result)


def test_saved_facts_replay_offline_ignores_later_provider_revisions_and_current_settings(
    monkeypatch,
):
    snapshot = _snapshot()
    frames = _standard_frames()
    result = evaluate_decision(snapshot, observed_at=OBSERVED, history_fetcher=_fetcher(frames))
    saved = _saved(snapshot, result)
    calculation = _payload(result, "calculation_sha256")
    frames["AAA"]["Adj Close"] = 999999.99999999
    frames["BM-A"]["Adj Close"] = 1.0
    _plan(holding_period_days=20, resolved_benchmark="BM-B")
    forbidden = Mock(side_effect=AssertionError("saved outcomes must be offline"))
    monkeypatch.setattr(evaluation.yf, "Ticker", forbidden)
    assert replay_evaluation(saved)["calculation"] == calculation
    repeated = evaluate_decision(
        saved, observed_at="2030-01-01T00:00:00Z", history_fetcher=forbidden
    )
    forbidden.assert_not_called()
    assert repeated["outcome"] == result["outcome"] and repeated["calculation"] == calculation


@pytest.mark.parametrize(
    "change",
    [
        "formula",
        "endpoint",
        "window",
        "request",
        "request_boolean",
        "timezone",
        "nanosecond",
        "observed_at",
    ],
)
def test_offline_replay_rejects_rehashed_but_inconsistent_facts_or_calculation(change):
    snapshot = _snapshot()
    result = evaluate_decision(
        snapshot, observed_at=OBSERVED, history_fetcher=_fetcher(_standard_frames())
    )
    saved = _saved(snapshot, result)
    if change in ("formula", "endpoint", "window"):
        payload = _payload(result, "calculation_sha256")
        if change == "formula":
            payload["raw_return"] = 0.987654321
        elif change == "endpoint":
            payload["endpoints"][0]["entry"]["date"] = "2026-01-05"
        else:
            payload["selected_common_dates"].pop()
        saved = _rehash_payload(saved, "calculation_sha256", payload)
    else:
        payload = _payload(result, "facts_sha256")
        source = payload["sources"][0]
        if change == "request":
            source["request_parameters"]["auto_adjust"] = True
        elif change == "request_boolean":
            source["request_parameters"]["auto_adjust"] = 0
        elif change == "timezone":
            source["timezone"] = "Asia/Tokyo"
        elif change == "observed_at":
            source["observed_at"] = "2026-01-16T18:00:00Z"
        else:
            source["rows"][0]["timestamp"] = "2026-01-05T00:00:00.000000001-05:00"
        saved = _rehash_payload(saved, "facts_sha256", payload)
    with pytest.raises(EvaluationValidationError, match="could not be verified"):
        replay_evaluation(saved)


def test_dst_offsets_remain_original_in_saved_prices_and_offline_replay():
    plan = _plan(
        analysis_date="2026-03-04", host_local_calendar_at_start="2026-03-04", holding_period_days=2
    )
    snapshot = _snapshot(
        plan=plan, started_at="2026-03-04T21:10:00Z", recorded_at="2026-03-04T21:20:00Z"
    )
    dates = pd.bdate_range("2026-03-04", "2026-03-10")
    frames = {
        "AAA": _prices(dates, [100, 101, 102, 103, 104]),
        "BM-A": _prices(dates, [200, 201, 202, 203, 204]),
    }
    result = evaluate_decision(
        snapshot, observed_at="2026-03-11T18:00:00Z", history_fetcher=_fetcher(frames)
    )
    endpoints = _payload(result, "calculation_sha256")["endpoints"][0]
    assert endpoints["entry"]["utc_offset"] == "-05:00"
    assert endpoints["exit"]["utc_offset"] == "-04:00"
    assert replay_evaluation(_saved(snapshot, result))["status"] == "available"


def test_before_recording_or_no_elapsed_daily_window_is_pending_without_provider_calls():
    fetch = Mock()
    before = evaluate_decision(
        _snapshot(), observed_at="2026-01-05T21:19:00Z", history_fetcher=fetch
    )
    same_day = evaluate_decision(
        _snapshot(), observed_at="2026-01-05T23:59:00Z", history_fetcher=fetch
    )
    assert before["reason"] == "observation_not_after_decision"
    assert same_day["reason"] == "no_elapsed_entry_window"
    assert before["outcome"] is None and same_day["outcome"] is None
    fetch.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"holding_period_days": True},
        {"holding_period_days": 0},
        {"holding_period_days": 10001},
        {"analysis_date": "private/path api_key=secret"},
        {"host_utc_offset": "+99:00"},
        {"resolved_benchmark": "https://private/path?apikey=secret"},
        {"analysis_date": "2026-01-06"},
    ],
)
def test_invalid_or_future_plans_have_fixed_safe_validation_errors(changes):
    with pytest.raises(MemoryValidationError) as error:
        _plan(**changes)
    assert "secret" not in str(error.value) and "private/path" not in str(error.value)


def test_evaluator_hash_identifies_exact_own_source():
    assert len(evaluator_code_sha256()) == 64
    assert _plan()["evaluator_code_sha256"] == evaluator_code_sha256()


def test_shared_memory_fixture_replays_actual_saved_endpoint_facts_offline():
    fixture = Path(__file__).parent / "fixtures" / "memory_bundle_v1.json"
    bundle = json.loads(fixture.read_text(encoding="utf-8"))
    prior = bundle["input_snapshot"]["decisions"][0]
    result = replay_evaluation(prior)
    assert prior["contract"]["evaluator_code_sha256"] == evaluator_code_sha256()
    assert result["status"] == "available"
    assert result["calculation"]["entry_date"] == "2025-02-10"
    assert result["calculation"]["exit_date"] == "2025-02-12"
    assert result["calculation"]["raw_return"] == 126.25 / 123.45678901234567 - 1
    facts = json.loads(result["artifacts"][result["outcome"]["facts_sha256"]]["payload"])
    assert facts["sources"][0]["rows"][0]["values"]["Adj Close"]["value"] == 123.45678901234567


def test_saved_available_outcome_with_new_evaluator_is_explicitly_unverifiable_without_refetch(
    monkeypatch,
):
    snapshot = _snapshot()
    result = evaluate_decision(
        snapshot, observed_at=OBSERVED, history_fetcher=_fetcher(_standard_frames())
    )
    saved = _saved(snapshot, result)
    original = deepcopy(saved)
    monkeypatch.setattr(evaluation, "evaluator_code_sha256", lambda: "a" * 64)
    forbidden = Mock(side_effect=AssertionError("must not fetch revised prices"))
    repeated = evaluate_decision(saved, history_fetcher=forbidden)
    forbidden.assert_not_called()
    assert repeated["status"] == "not_evaluable" and repeated["reason"] == "evaluator_code_mismatch"
    assert repeated["outcome"] is None and repeated["calculation"] is None
    assert saved == original


def test_durable_facts_survive_reflection_failure_and_retry_without_provider(tmp_path):
    from tradingagents.memory.store import MemoryStore

    snapshot = _snapshot()
    frames = _standard_frames()
    result = evaluate_decision(snapshot, observed_at=OBSERVED, history_fetcher=_fetcher(frames))
    store = MemoryStore(storage_dir=tmp_path / "memory")
    store.record_decision(snapshot)
    store.attach_outcome(snapshot["run_id"], result["outcome"], result["artifacts"])
    failed_reflection = Mock(side_effect=RuntimeError("fixed fixture failure"))
    with pytest.raises(RuntimeError, match="fixed fixture failure"):
        failed_reflection(result["calculation"])
    frames["AAA"]["Adj Close"] = 1.23456789
    restarted = MemoryStore(storage_dir=tmp_path / "memory").load_decision(snapshot["run_id"])
    forbidden = Mock(side_effect=AssertionError("a reflection retry must not fetch prices"))
    replayed = evaluate_decision(restarted, history_fetcher=forbidden)
    forbidden.assert_not_called()
    assert restarted["reflection"] is None
    assert replayed["calculation"] == result["calculation"]
    assert replayed["outcome"] == result["outcome"]
