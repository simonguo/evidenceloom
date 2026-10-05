"""The legacy-safe review command reads immutable records without research imports."""

import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import pytest

from cli.memory_inventory import inventory, validate_decision_ids
from cli.runner_diagnostics import read_memory_inventory
from tradingagents.memory.schema import validate_review_attachment
from tradingagents.memory.store import MemoryStore

REPOSITORY = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        ["../private"],
        [str(uuid4()).upper()],
        [1],
        [str(uuid4())] * 2,
        [str(uuid4()) for _ in range(21)],
    ],
)
def test_inventory_rejects_invalid_or_duplicate_ids(value):
    with pytest.raises(ValueError, match="Invalid research memory inventory request"):
        validate_decision_ids(value)


def test_missing_inventory_is_read_only(tmp_path, monkeypatch):
    path = tmp_path / "missing" / "legacy.md"
    monkeypatch.setenv("TRADINGAGENTS_MEMORY_LOG_PATH", str(path))
    run_id = str(uuid4())
    result = inventory({"decisionIds": [run_id]})
    assert result == {
        "type": "memory_inventory",
        "schema_version": 1,
        "requested_ids": [run_id],
        "reviews": [],
        "missing_ids": [run_id],
    }
    assert not path.parent.exists()


@pytest.mark.parametrize("prior", [None, "0", "custom-parent-value"])
def test_inventory_restores_parent_bootstrap_environment_on_success_and_failure(
    tmp_path, monkeypatch, prior
):
    monkeypatch.setenv("TRADINGAGENTS_MEMORY_LOG_PATH", str(tmp_path / "missing" / "legacy.md"))
    if prior is None:
        monkeypatch.delenv("EVIDENCELOOM_BOOTSTRAP_ONLY", raising=False)
    else:
        monkeypatch.setenv("EVIDENCELOOM_BOOTSTRAP_ONLY", prior)
    read_memory_inventory({"decisionIds": [str(uuid4())]})
    assert os.environ.get("EVIDENCELOOM_BOOTSTRAP_ONLY") == prior
    with pytest.raises(ValueError):
        read_memory_inventory({"decisionIds": ["../private"]})
    assert os.environ.get("EVIDENCELOOM_BOOTSTRAP_ONLY") == prior


def test_inventory_retains_full_attachment_and_does_not_change_completion(tmp_path, monkeypatch):
    path = tmp_path / "legacy.md"
    monkeypatch.setenv("TRADINGAGENTS_MEMORY_LOG_PATH", str(path))
    frozen = json.loads((REPOSITORY / "tests/fixtures/memory_bundle_v1.json").read_text())
    store = MemoryStore(path)
    store.record_decision(frozen["decision_snapshot"])
    completed = store.bundle(
        frozen["run_id"],
        frozen["input_snapshot"],
        evidence_bundle_sha256=frozen["evidence_bundle_sha256"],
    )
    result = inventory({"decisionIds": [frozen["run_id"]]})
    attachment = validate_review_attachment(result["reviews"][0], completed)
    assert attachment["snapshot"] == completed["decision_snapshot"]
    assert result["missing_ids"] == []
    assert store.load_bundle(frozen["run_id"]) == completed


@pytest.mark.parametrize("saved", [False, True])
def test_configured_inventory_does_not_require_home(tmp_path, monkeypatch, saved):
    path = tmp_path / "missing" / "legacy.md"
    monkeypatch.setenv("TRADINGAGENTS_MEMORY_LOG_PATH", str(path))
    frozen = json.loads((REPOSITORY / "tests/fixtures/memory_bundle_v1.json").read_text())
    store = MemoryStore(path)
    if saved:
        store.record_decision(frozen["decision_snapshot"])
        completed = store.bundle(
            frozen["run_id"],
            frozen["input_snapshot"],
            evidence_bundle_sha256=frozen["evidence_bundle_sha256"],
        )

    def unavailable_home():
        raise RuntimeError("Home directory is unavailable")

    monkeypatch.setattr(Path, "home", unavailable_home)
    result = inventory({"decisionIds": [frozen["run_id"]]})
    if saved:
        attachment = validate_review_attachment(result["reviews"][0], completed)
        assert attachment["snapshot"] == completed["decision_snapshot"]
        assert result["missing_ids"] == []
        assert store.load_bundle(frozen["run_id"]) == completed
    else:
        assert result["reviews"] == [] and result["missing_ids"] == [frozen["run_id"]]
        assert not path.parent.exists()


def blocked_research_request(raw, tmp_path, *, default_without_home=False):
    program = """
import runpy, sys
class BlockResearchImports:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'cli.main' or fullname.startswith('tradingagents.graph') or fullname.startswith('tradingagents.llm_clients') or fullname.startswith('tradingagents.dataflows') or fullname.split('.')[0] in {'pandas','numpy','yfinance','requests','dotenv','langchain_core','langgraph'}:
            raise RuntimeError('Research import must not occur')
sys.meta_path.insert(0, BlockResearchImports())
runpy.run_path(sys.argv[1], run_name='__main__')
"""
    if default_without_home:
        program = (
            """
from pathlib import Path
def unavailable_home():
    raise RuntimeError('Private home failure body must not escape')
Path.home = unavailable_home
"""
            + program
        )
    environment = {
        key: os.environ[key]
        for key in ("PATH", "HOME", "TMPDIR", "SYSTEMROOT", "WINDIR")
        if key in os.environ
    }
    environment.update(
        {
            "PYTHONPATH": str(REPOSITORY),
            "PYTHON_DOTENV_DISABLED": "1",
            "TRADINGAGENTS_MEMORY_LOG_PATH": str(tmp_path / "missing" / "legacy.md"),
        }
    )
    if default_without_home:
        environment.pop("TRADINGAGENTS_MEMORY_LOG_PATH")
    return subprocess.run(
        [sys.executable, "-c", program, str(REPOSITORY / "frontend/server/run_analysis.py")],
        input=raw,
        text=True,
        encoding="utf-8",
        capture_output=True,
        cwd=tmp_path,
        env=environment,
        timeout=20,
    )


def test_memory_flag_finishes_before_models_sources_or_dotenv_import(tmp_path):
    run_id = str(uuid4())
    result = blocked_research_request(
        json.dumps({"__command": "smoke_test", "memoryInventory": True, "decisionIds": [run_id]}),
        tmp_path,
    )
    assert result.returncode == 0, result.stderr
    event = json.loads(result.stdout)
    assert event["type"] == "memory_inventory" and event["missing_ids"] == [run_id]
    assert result.stdout.endswith("\n") and len(result.stdout.splitlines()) == 1
    assert result.stderr == "" and not (tmp_path / "missing").exists()


def test_unavailable_default_home_is_safe_without_research_imports(tmp_path):
    result = blocked_research_request(
        json.dumps(
            {"__command": "smoke_test", "memoryInventory": True, "decisionIds": [str(uuid4())]}
        ),
        tmp_path,
        default_without_home=True,
    )
    assert result.returncode == 1
    event = json.loads(result.stdout)
    assert event["type"] == "error" and event["error"] == "Runner diagnostic failed"
    assert result.stderr == "Evidence Loom runner error (RuntimeError): Runner diagnostic failed\n"
    assert "Private home failure" not in result.stdout + result.stderr
    assert not (tmp_path / "missing").exists()


@pytest.mark.parametrize(
    "raw",
    [
        '{"__command":"future_inventory"}',
        '{"__command":"smoke_test","memoryInventory":1}',
        '{"__command":"smoke_test","memoryInventory":true,"verifyRuntime":true}',
        '{"__command":"smoke_test","__command":null}',
        '{"__command":"smoke_test","unused":NaN}',
    ],
)
def test_malformed_or_unknown_commands_never_fall_through_to_analysis(raw, tmp_path):
    result = blocked_research_request(raw, tmp_path)
    assert result.returncode == 1
    assert json.loads(result.stdout)["type"] == "error"
    assert "Research import must not occur" not in result.stderr
    assert str(tmp_path) not in result.stdout + result.stderr
