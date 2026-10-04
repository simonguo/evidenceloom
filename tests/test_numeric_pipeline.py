"""Actual graph/CLI/desktop completion authority and durable retry behavior."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import timedelta
import io
import json

import pytest

from cli.main import save_report_to_disk
from frontend.server import run_analysis as runner
from tests.test_desktop_stream import bridge, payload  # noqa: F401
from tests.test_graph_runtime import TRADE_DATE, ScriptedModel, _graph, offline  # noqa: F401
from tests import test_graph_runtime as graph_fixture
from tests.test_numeric_review import scenario
from tradingagents.graph import research_memory
from tradingagents.memory.schema import make_component, utc_timestamp
from tradingagents.research.numeric_persistence import freeze_report_text_snapshot
from tradingagents.research.numeric_review import NumericReviewError, validate_report_text_snapshot


def test_saved_snapshot_retries_reuse_first_capture_and_reject_coherent_rewrite(tmp_path):
    evidence, snapshot, _ = scenario()
    first = freeze_report_text_snapshot(tmp_path, evidence, snapshot["report_sections"])
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(
            pool.map(
                lambda _: freeze_report_text_snapshot(
                    tmp_path, evidence, snapshot["report_sections"]
                ),
                range(6),
            )
        )
    assert all(result == first for result in results)
    saved_path = tmp_path / first["run_id"] / "report_text_snapshot.json"
    assert json.loads(saved_path.read_text()) == first
    changed = deepcopy(first)
    changed["report_sections"]["market_report"] = changed["report_sections"][
        "market_report"
    ].replace("125.02", "999.00")
    changed = make_component(changed, "snapshot_sha256")
    # Self-hash and citation IDs alone accept the rewritten text; saved
    # per-run authority still rejects replacing the original captured core.
    assert validate_report_text_snapshot(changed, evidence) == changed
    with pytest.raises(NumericReviewError):
        freeze_report_text_snapshot(
            tmp_path, evidence, changed["report_sections"], existing=changed
        )
    assert json.loads(saved_path.read_text()) == first


def test_same_run_changed_final_evidence_is_rejected_and_corruption_not_overwritten(tmp_path):
    evidence, snapshot, _ = scenario()
    first = freeze_report_text_snapshot(tmp_path, evidence, snapshot["report_sections"])
    revised = deepcopy(evidence)
    revised["records"][0]["sources"][0]["units"] = "USD"
    revised = make_component(revised, "bundle_sha256")
    with pytest.raises(NumericReviewError):
        freeze_report_text_snapshot(tmp_path, revised, snapshot["report_sections"])
    saved_path = tmp_path / first["run_id"] / "report_text_snapshot.json"
    saved_path.write_text('{"broken":true}', encoding="utf-8")
    with pytest.raises(NumericReviewError):
        freeze_report_text_snapshot(tmp_path, evidence, snapshot["report_sections"])
    assert saved_path.read_text() == '{"broken":true}'


def test_real_offline_graph_logs_and_cli_export_original_snapshot(tmp_path, monkeypatch, offline):  # noqa: F811
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(structured=True))
    state, _ = graph.propagate("NVDA", TRADE_DATE)
    snapshot = validate_report_text_snapshot(
        state["report_text_snapshot"], state["evidence_bundle"]
    )
    assert snapshot["report_sections"]["final_trade_decision"] == state["final_trade_decision"]
    assert (
        snapshot["captured_at"]
        >= state["memory_bundle"]["decision_snapshot"]["decision"]["recorded_at"]
    )
    stored = next((tmp_path / "cache").rglob("report_text_snapshot.json"))
    assert json.loads(stored.read_text()) == snapshot
    log = json.loads(next((tmp_path / "results").rglob("full_states_log_*.json")).read_text())
    assert log["report_text_snapshot"] == snapshot
    graph.record_decision("NVDA", TRADE_DATE, state)
    assert state["report_text_snapshot"] == snapshot
    save_report_to_disk(state, "NVDA", tmp_path / "export")
    assert json.loads((tmp_path / "export/report_text_snapshot.json").read_text()) == snapshot
    changed = deepcopy(state)
    changed["market_report"] += "\nNew claim after completion"
    with pytest.raises(ValueError, match="immutable snapshot"):
        graph.record_decision("NVDA", TRADE_DATE, changed)
    assert json.loads(stored.read_text()) == snapshot


def test_actual_desktop_completed_event_exact_sections_and_snapshot(bridge):  # noqa: F811
    _, events, _ = bridge
    runner.run(payload())
    completed = next(event for event in events if event["type"] == "completed")
    snapshot = completed["reportTextSnapshot"]
    assert completed["finalState"]["report_text_snapshot"] == snapshot
    assert completed["reportSections"] == snapshot["report_sections"]
    assert completed["evidenceBundle"]["bundle_sha256"] == snapshot["evidence_bundle_sha256"]
    assert (
        snapshot["captured_at"]
        >= completed["memoryBundle"]["decision_snapshot"]["decision"]["recorded_at"]
    )
    assert not any(
        "reportTextSnapshot" in event for event in events if event["type"] != "completed"
    )


def test_relocated_memory_store_cannot_publish_retry_before_new_recorded_decision(
    tmp_path,
    monkeypatch,
    offline,  # noqa: F811
):
    graph = _graph(tmp_path, monkeypatch, ScriptedModel())
    state, _ = graph.propagate("NVDA", TRADE_DATE)
    first = deepcopy(state["report_text_snapshot"])
    stored = next((tmp_path / "cache").rglob("report_text_snapshot.json"))
    stored_bytes = stored.read_bytes()
    log = next((tmp_path / "results").rglob("full_states_log_*.json"))
    logged_bytes = log.read_bytes()
    retry = deepcopy(state)
    # A checkpoint from before completion contains the same original Evidence,
    # report sections and research input, but neither completion attachment.
    retry.pop("memory_bundle")
    retry.pop("report_text_snapshot")
    later = (
        (utc_timestamp(first["captured_at"]) + timedelta(seconds=1))
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )
    monkeypatch.setattr(research_memory, "now_utc", lambda: later)
    relocated = _graph(
        tmp_path,
        monkeypatch,
        ScriptedModel(),
        memory_log_path=str(tmp_path / "relocated/log.md"),
    )
    sentinel = relocated.curr_state
    with pytest.raises(NumericReviewError):
        relocated.record_decision("NVDA", TRADE_DATE, retry)
    assert relocated.curr_state is sentinel
    assert retry["memory_bundle"]["decision_snapshot"]["decision"]["recorded_at"] == later
    assert "report_text_snapshot" not in retry
    assert stored.read_bytes() == stored_bytes
    assert log.read_bytes() == logged_bytes
    # A caller cannot combine that fresh Memory completion with the older
    # snapshot through the separate CLI export path either.
    retry["report_text_snapshot"] = first
    with pytest.raises(NumericReviewError):
        save_report_to_disk(retry, "NVDA", tmp_path / "relocated-export")
    assert not (tmp_path / "relocated-export").exists()


def test_cli_preserves_original_utf8_mixed_newline_bytes(tmp_path):
    evidence, snapshot, _ = scenario()
    original = snapshot["report_sections"]["market_report"]
    assert "\r\n" in original and "\n" in original.replace("\r\n", "")
    assert "📈" in original
    state = {
        **snapshot["report_sections"],
        "evidence_bundle": evidence,
        "report_text_snapshot": snapshot,
        "investment_debate_state": {"bull_history": "看多📈\r\n一行\n二行\r结尾"},
        "risk_debate_state": {"judge_decision": "结论📉\r\n一行\n二行\r结尾"},
    }
    destination = tmp_path / "byte-export"
    save_report_to_disk(state, "FICT", destination)
    assert (destination / "1_analysts/market.md").read_bytes() == original.encode("utf-8")
    assert (destination / "2_research/bull.md").read_bytes() == state["investment_debate_state"][
        "bull_history"
    ].encode("utf-8")
    assert (destination / "5_portfolio/decision.md").read_bytes() == state["risk_debate_state"][
        "judge_decision"
    ].encode("utf-8")
    consolidated = (destination / "complete_report.md").read_bytes()
    assert original.encode("utf-8") in consolidated
    assert state["investment_debate_state"]["bull_history"].encode("utf-8") in consolidated
    assert b"\r\r\n" not in consolidated
    assert json.loads((destination / "report_text_snapshot.json").read_bytes()) == snapshot


def test_known_configured_secret_redacted_before_snapshot_and_final_edit(
    tmp_path, monkeypatch, request
):
    request.getfixturevalue("offline")
    secret = "fictional-configured-secret-789"
    monkeypatch.setattr(graph_fixture, "TEXT", graph_fixture.TEXT + "\n" + secret)
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(), api_key=secret)
    state, _ = graph.propagate("NVDA", TRADE_DATE)
    assert secret not in json.dumps(state["report_text_snapshot"], ensure_ascii=False)
    assert "[redacted]" in state["report_text_snapshot"]["report_sections"]["market_report"]
    log = next((tmp_path / "results").rglob("full_states_log_*.json"))
    saved = json.loads(log.read_text())
    assert secret not in log.read_text()
    save_report_to_disk(
        state, "NVDA", tmp_path / "secret-export", secrets=graph._evidence_secrets()
    )
    assert all(secret not in path.read_text() for path in (tmp_path / "secret-export").rglob("*.*"))
    assert (
        json.loads((tmp_path / "secret-export/report_text_snapshot.json").read_text())
        == state["report_text_snapshot"]
    )
    for key, text in state["report_text_snapshot"]["report_sections"].items():
        assert secret not in (text or "")
        if key in saved:
            assert secret not in (saved[key] or "")
    changed = deepcopy(state)
    changed["final_trade_decision"] += "\n" + secret
    with pytest.raises(ValueError):
        graph.record_decision("NVDA", TRADE_DATE, changed)
    assert secret not in changed["final_trade_decision"]
    assert json.loads(log.read_text())["report_text_snapshot"] == state["report_text_snapshot"]


def test_actual_completed_packet_redacts_configured_report_secret(bridge, monkeypatch):  # noqa: F811
    _, events, _ = bridge
    secret = "fictional-completed-report-secret-654"
    monkeypatch.setattr(graph_fixture, "TEXT", graph_fixture.TEXT + "\n" + secret)
    monkeypatch.setitem(runner.DEFAULT_CONFIG, "api_key", secret)
    runner.run(payload())
    completed = next(event for event in events if event["type"] == "completed")
    leaked = secret in json.dumps(events, ensure_ascii=False)
    assert not leaked
    assert completed["reportTextSnapshot"] == completed["finalState"]["report_text_snapshot"]


def test_actual_runner_system_stream_and_error_echo_are_redacted(bridge, monkeypatch, capsys):  # noqa: F811
    from langchain_core.messages import SystemMessage

    _, events, graphs = bridge
    secret = "fictional-runner-system-secret-789"
    monkeypatch.setitem(runner.DEFAULT_CONFIG, "api_key", secret)
    original_stream = graph_fixture.trading_graph.TradingAgentsGraph.stream_run

    def stream(graph, *args, **kwargs):
        yield [SystemMessage(content="System diagnostic " + secret)], {}, None
        yield from original_stream(graph, *args, **kwargs)

    monkeypatch.setattr(graph_fixture.trading_graph.TradingAgentsGraph, "stream_run", stream)
    runner.run(payload())
    systems = [e for e in events if e.get("messageType") == "System"]
    assert any(e.get("message") == "System diagnostic [redacted]" for e in systems)
    assert not any(secret in json.dumps(event, ensure_ascii=False) for event in events)
    snapshot = events[-1]["reportTextSnapshot"]
    assert snapshot == graphs[0].curr_state["report_text_snapshot"]

    def fail(_payload):
        raise RuntimeError("Configured echo " + secret)

    monkeypatch.setattr(runner, "run", fail)
    monkeypatch.setattr(runner.sys, "stdin", io.StringIO(json.dumps(payload())))
    assert runner.main() == 1
    assert events[-1]["type"] == "error"
    assert events[-1]["error"] == "Configured echo [redacted]"
    assert secret not in capsys.readouterr().err


def test_cli_export_rejects_changed_original_before_creating_any_files(tmp_path):
    evidence, snapshot, _ = scenario()
    state = {
        **snapshot["report_sections"],
        "evidence_bundle": evidence,
        "report_text_snapshot": snapshot,
    }
    changed = deepcopy(state)
    changed["market_report"] = changed["market_report"].replace("125.02", "999.00")
    with pytest.raises(NumericReviewError):
        save_report_to_disk(changed, "FICT", tmp_path / "changed")
    assert not (tmp_path / "changed").exists()
    changed = deepcopy(state)
    changed["report_text_snapshot"]["report_sections"]["market_report"] += (
        "\nChanged self-hashed text"
    )
    changed["report_text_snapshot"] = make_component(
        changed["report_text_snapshot"], "snapshot_sha256"
    )
    with pytest.raises(NumericReviewError):
        save_report_to_disk(changed, "FICT", tmp_path / "rehashed")
    assert not (tmp_path / "rehashed").exists()
    # Known-secret redaction cannot silently change an already captured section.
    with pytest.raises(NumericReviewError):
        save_report_to_disk(state, "FICT", tmp_path / "postcapture-redaction", secrets=("FICT",))
    assert not (tmp_path / "postcapture-redaction").exists()
