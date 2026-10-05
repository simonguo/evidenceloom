"""Bootstrap diagnostics stay usable even when research imports are unavailable."""

import io
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from cli.research_manifest import research_manifest
from cli.runner_diagnostics import bootstrap
from cli.runner_protocol import emit

REPOSITORY = Path(__file__).resolve().parents[1]


def blocked_runtime_command(raw, tmp_path):
    program = """
import runpy
import sys

class BlockResearchImports:
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'cli.main' or fullname.split('.')[0] in {
            'tradingagents', 'pandas', 'numpy', 'yfinance', 'requests',
            'dotenv', 'langchain_core', 'langgraph',
        }:
            raise RuntimeError('Research runtime was imported: ' + fullname)

sys.meta_path.insert(0, BlockResearchImports())
runpy.run_path(sys.argv[1], run_name='__main__')
"""
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("TRADINGAGENTS_")
        and not any(
            marker in key.upper()
            for marker in ("API_KEY", "ACCESS_TOKEN", "PASSWORD", "SECRET", "SIGNING_IDENTITY")
        )
    }
    environment["PYTHONPATH"] = str(REPOSITORY)
    environment["PYTHON_DOTENV_DISABLED"] = "1"
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


def test_smoke_ready_does_not_import_the_research_runtime(tmp_path):
    result = blocked_runtime_command('{"__command":"smoke_test","unused":"\\ud800"}', tmp_path)
    assert result.returncode == 0, result.stderr
    event = json.loads(result.stdout)
    assert event.keys() == {"type", "timestamp"}
    assert event["type"] == "ready"
    assert result.stderr == ""


def test_manifest_matches_actual_sources_without_importing_them(tmp_path):
    result = blocked_runtime_command('{"__command":"evidence_manifest"}', tmp_path)
    assert result.returncode == 0, result.stderr
    event = json.loads(result.stdout)
    assert event.pop("timestamp")
    assert event == research_manifest(REPOSITORY / "tradingagents")
    assert result.stderr == ""


def test_full_runtime_probe_cannot_report_ready_when_a_research_import_fails(tmp_path):
    result = blocked_runtime_command('{"__command":"smoke_test","verifyRuntime":true}', tmp_path)
    assert result.returncode == 1
    event = json.loads(result.stdout)
    assert event["type"] == "error"
    assert event["error"] == "Research runtime could not be initialized"
    assert "runtime_ready" not in result.stdout
    assert "Research runtime was imported" not in result.stdout + result.stderr
    assert str(REPOSITORY) not in result.stdout + result.stderr


def test_full_runtime_probe_loads_actual_research_dependencies_without_provider_calls(tmp_path):
    program = """
import runpy
import socket
import sys

def no_network(*args, **kwargs):
    raise RuntimeError('Runtime probe attempted a network request')

socket.socket.connect = no_network
socket.socket.connect_ex = no_network
socket.create_connection = no_network
runpy.run_path(sys.argv[1], run_name='__main__')
"""
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("TRADINGAGENTS_")
        and not any(
            marker in key.upper()
            for marker in ("API_KEY", "ACCESS_TOKEN", "PASSWORD", "SECRET", "SIGNING_IDENTITY")
        )
    }
    environment["PYTHONPATH"] = str(REPOSITORY)
    environment["PYTHON_DOTENV_DISABLED"] = "1"
    result = subprocess.run(
        [sys.executable, "-c", program, str(REPOSITORY / "frontend/server/run_analysis.py")],
        input='{"__command":"smoke_test","verifyRuntime":true}',
        text=True,
        encoding="utf-8",
        capture_output=True,
        cwd=tmp_path,
        env=environment,
        timeout=30,
    )
    assert result.returncode == 0, result.stderr
    event = json.loads(result.stdout)
    assert event.keys() == {"type", "timestamp"}
    assert event["type"] == "runtime_ready"
    assert result.stderr == ""


@pytest.mark.parametrize(
    "raw",
    [
        '{"private":"https://internal.invalid/?api_key=private-secret",',
        '["https://internal.invalid/?api_key=private-secret"]',
        '"private-secret"',
        "null",
        "42",
        '{"__command":"smoke_test","verifyRuntime":"true"}',
        '{"__command":"smoke_test","verifyRuntime":1}',
    ],
)
def test_invalid_requests_emit_safe_errors_without_runtime_imports(raw, tmp_path):
    result = blocked_runtime_command(raw, tmp_path)
    assert result.returncode == 1
    event = json.loads(result.stdout)
    assert event["type"] == "error" and event["messageType"] == "Error"
    assert event["error"] == event["message"]
    assert "Evidence Loom runner error" in result.stderr
    assert "Research runtime was imported" not in result.stderr
    assert "private-secret" not in result.stdout + result.stderr
    assert "internal.invalid" not in result.stdout + result.stderr


def test_ordinary_request_is_read_once_and_reaches_existing_analysis_main(monkeypatch):
    from frontend.server import run_analysis as runner

    request = {"ticker": "NVDA", "message": "研究", "analysts": ["market"]}

    class ReadOnce(io.StringIO):
        reads = 0

        def read(self, *args, **kwargs):
            self.reads += 1
            assert self.reads == 1, "runner consumed stdin twice"
            return super().read(*args, **kwargs)

    stream = ReadOnce(json.dumps(request, ensure_ascii=False))
    monkeypatch.setattr(sys, "stdin", stream)
    status, payload = bootstrap()
    assert status is None and payload == request
    monkeypatch.setattr(runner, "_BOOTSTRAP_PAYLOAD", payload)
    received = []
    monkeypatch.setattr(runner, "run", received.append)
    assert runner.main() == 0
    assert received == [request] and stream.reads == 1


def test_diagnostic_jsonl_preserves_unicode_and_repairs_surrogates(capsys):
    emit({"type": "message", "message": "研究 \ud83d\ude80 \ud800 \udc00"})
    text = capsys.readouterr().out
    text.encode("utf-8", "strict")
    assert json.loads(text)["message"] == "研究 🚀 � �"


def test_unreadable_manifest_is_a_safe_visible_error(monkeypatch, tmp_path, capsys):
    from cli import runner_diagnostics

    (tmp_path / "__init__.pyc").write_bytes(b"compiled-only package")
    monkeypatch.setattr(
        runner_diagnostics, "research_manifest", lambda _: research_manifest(tmp_path)
    )
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"__command":"evidence_manifest"}'))
    assert bootstrap() == (1, None)
    captured = capsys.readouterr()
    event = json.loads(captured.out)
    assert event["type"] == "error"
    assert event["error"] == (
        "Research source files are unavailable for code and prompt verification"
    )
    assert str(tmp_path) not in captured.out + captured.err


def test_unexpected_bootstrap_exception_never_exposes_input_or_path(monkeypatch, capsys):
    from cli import runner_diagnostics

    def unreadable(_):
        raise OSError("/private/research/body https://internal.invalid/?token=private-secret")

    monkeypatch.setattr(runner_diagnostics, "research_manifest", unreadable)
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"__command":"evidence_manifest"}'))
    assert bootstrap() == (1, None)
    captured = capsys.readouterr()
    assert json.loads(captured.out)["error"] == "Runner diagnostic failed"
    assert "private" not in captured.out + captured.err
    assert "internal.invalid" not in captured.out + captured.err
