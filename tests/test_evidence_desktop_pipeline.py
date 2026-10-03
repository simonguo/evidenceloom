"""Exact captured inputs and citation audits survive the desktop bridge."""

import json
import io
from pathlib import Path

import pytest

from frontend.server import run_analysis as runner
from tests.test_desktop_stream import bridge, payload  # noqa: F401
from tests.test_graph_runtime import offline  # noqa: F401
from tradingagents.evidence import validate_evidence_bundle
from tradingagents.graph.trading_graph import _source_code_sha256
import tradingagents


def test_desktop_progress_completion_and_saved_log_keep_exact_evidence(request):
    _, events, graphs = request.getfixturevalue("bridge")
    runner.run(payload())
    completed = next(event for event in events if event["type"] == "completed")
    bundle = validate_evidence_bundle(completed["evidenceBundle"])
    assert completed["finalState"]["evidence_bundle"] == bundle
    assert completed["runSettings"] == bundle["manifest"]
    assert {r["analyst"] for r in bundle["records"]} >= {
        "identity",
        "market",
        "news",
        "fundamentals",
    }
    previous = set()
    for event in events:
        if event.get("evidenceBundle"):
            captured = validate_evidence_bundle(event["evidenceBundle"])
            ids = {r["id"] for r in captured["records"]}
            assert previous <= ids
            previous = ids
    for record in bundle["records"]:
        exact_input = bundle["artifacts"][record["output_sha256"]]["payload"]
        assert exact_input.startswith(f"[E:{record['id']}]\n")
    for key, report in completed["reportSections"].items():
        assert bundle["citation_audit"][key]["status"] in {"none", "resolved", "unresolved"}
        if report is None:
            assert bundle["citation_audit"][key]["referenced_ids"] == []
    graph = graphs[-1]
    path = (
        graph.config["results_dir"]
        + "/NVDA/TradingAgentsStrategy_logs/full_states_log_2026-01-09.json"
    )
    with open(path) as saved:
        assert json.load(saved)["evidence_bundle"] == bundle


def test_desktop_resume_reuses_frozen_bundle_and_extends_captured_inputs(request):
    model, events, _ = request.getfixturevalue("bridge")
    model.fail_at = 12
    request = payload(checkpointEnabled=True)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        runner.run(request)
    previous_bundle = next(e["evidenceBundle"] for e in reversed(events) if e.get("evidenceBundle"))
    events.clear()
    runner.run(request)
    final_bundle = events[-1]["evidenceBundle"]
    for key in ("run_id", "created_at", "research_as_of", "manifest", "manifest_sha256"):
        assert final_bundle[key] == previous_bundle[key]
    for record in previous_bundle["records"]:
        assert record in final_bundle["records"]
        digest = record["output_sha256"]
        assert previous_bundle["artifacts"][digest] == final_bundle["artifacts"][digest]


def test_packaging_manifest_diagnostic_hashes_actual_source_without_running_research(monkeypatch):
    events = []
    monkeypatch.setattr(
        runner.sys, "stdin", io.StringIO(json.dumps({"__command": "evidence_manifest"}))
    )
    monkeypatch.setattr(runner, "emit", events.append)
    monkeypatch.setattr(
        runner, "run", lambda _: pytest.fail("Inventory must not run paid research")
    )
    assert runner.main() == 0
    package = Path(tradingagents.__file__).parent
    assert events == [
        {
            "type": "evidence_ready",
            "schema_version": 1,
            "code_sha256": _source_code_sha256(package),
            "prompt_templates_sha256": _source_code_sha256(package / "agents"),
            "source_file_count": len(list(package.rglob("*.py"))),
        }
    ]
