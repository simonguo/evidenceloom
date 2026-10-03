"""Offline release gates exercised with real stdout, stderr and process trees."""

import json
import os
import subprocess
import sys
import time

import pytest

from scripts import sidecar_probe
from scripts.sidecar_probe import ProbeError, run_probe

pytestmark = pytest.mark.unit


def _command(stdout=b'{"type":"ready"}\n', stderr=b"", status=0, before=""):
    return [
        sys.executable,
        "-c",
        "import os, sys, time\n"
        "sys.stdin.readline()\n"
        + before
        + f"os.write(1, {stdout!r})\n"
        + f"os.write(2, {stderr!r})\n"
        + f"sys.exit({status})\n",
    ]


@pytest.mark.parametrize(
    ("stage", "event"),
    [
        ("bootstrap", {"type": "ready"}),
        ("runtime", {"type": "runtime_ready"}),
        ("runtime", {"type": "runtime_ready", "timestamp": "09:42:17"}),
    ],
)
def test_valid_readiness_requires_the_matching_stage_and_successful_exit(stage, event):
    run_probe(_command(json.dumps(event).encode() + b"\n"), stage, timeout=2)


@pytest.mark.parametrize(
    ("stdout", "status"),
    [
        (b'{"type":"ready"}\n', 7),
        (b"log contains ready but is not a protocol event\n", 0),
        (b'{"type":"ready"', 0),
        (b'{"type":"ready"}', 0),
        (b'{"type":"ready"}\n\n', 0),
        (b'{"type":"ready"}\n{"type":"ready"}\n', 0),
        (b'{"type":"ready"}\n{"type":"error"}\n', 0),
        (b'{"type":"error","message":"secret/path"}\n', 0),
        (b'{"type":"ready","error":"secret/path"}\n', 0),
        (b'{"type":"error","type":"ready"}\n', 0),
        (b'{"type":"ready","timestamp":"99:00:00"}\n', 0),
        (b'{"type":"ready","timestamp":NaN}\n', 0),
        ('{"type":"ready","timestamp":"０９:４２:１７"}\n'.encode(), 0),
        (b'{"type":"runtime_ready"}\n', 0),
        (b'["ready"]\n', 0),
        (b'\xff{"type":"ready"}\n', 0),
    ],
)
def test_real_process_protocol_failures_cannot_pass_the_release_gate(stdout, status):
    with pytest.raises(ProbeError) as error:
        run_probe(_command(stdout, status=status), "bootstrap", timeout=2)
    assert "secret/path" not in str(error.value)


def test_stderr_ready_tokens_never_satisfy_stdout_protocol():
    with pytest.raises(ProbeError, match="exactly one JSONL"):
        run_probe(
            _command(b"", b'private/path api_key=secret {"type":"ready"}\n'),
            "bootstrap",
            timeout=2,
        )


def test_legacy_ready_cannot_satisfy_the_full_import_probe():
    with pytest.raises(ProbeError, match="unsupported sidecar"):
        run_probe(_command(), "runtime", timeout=2)


def test_stderr_noise_is_discarded_without_echoing_sensitive_content(capsys):
    run_probe(_command(stderr=b"private/path api_key=secret\n"), "bootstrap", timeout=2)
    assert capsys.readouterr() == ("", "")


@pytest.mark.parametrize("channel", [1, 2])
def test_each_output_pipe_has_a_bounded_limit_and_fixed_failure(channel):
    command = [
        sys.executable,
        "-c",
        "import os, sys\n"
        "sys.stdin.readline()\n"
        f"os.write({channel}, b'private/path api_key=secret ' * 4000)\n",
    ]
    started = time.monotonic()
    with pytest.raises(ProbeError, match="output limit") as error:
        run_probe(command, "bootstrap", timeout=2)
    assert time.monotonic() - started < 2
    assert "private/path" not in str(error.value) and "secret" not in str(error.value)


def test_child_environment_disables_dotenv_and_tracing_without_mutating_parent(monkeypatch):
    for key in ("PYTHON_DOTENV_DISABLED", "LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING"):
        monkeypatch.setenv(key, "parent-value")
    command = [
        sys.executable,
        "-c",
        "import json, os, sys\n"
        "payload = json.loads(sys.stdin.readline())\n"
        "assert payload == {'__command': 'smoke_test', 'verifyRuntime': True}\n"
        "assert os.environ['PYTHON_DOTENV_DISABLED'] == '1'\n"
        "assert os.environ['LANGCHAIN_TRACING_V2'] == 'false'\n"
        "assert os.environ['LANGSMITH_TRACING'] == 'false'\n"
        "print(json.dumps({'type': 'runtime_ready'}))\n",
    ]
    run_probe(command, "runtime", timeout=2)
    for key in ("PYTHON_DOTENV_DISABLED", "LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING"):
        assert os.environ[key] == "parent-value"


@pytest.mark.parametrize("parent_exits", [True, False])
def test_deadline_covers_descendant_held_pipes_and_kills_the_tree(tmp_path, parent_exits):
    marker = tmp_path / "descendant-survived"
    started_marker = tmp_path / "descendant-started"
    child = (
        "import time; from pathlib import Path; "
        f"Path({str(started_marker)!r}).touch(); "
        f"time.sleep(0.85); Path({str(marker)!r}).touch()"
    )
    command = [
        sys.executable,
        "-c",
        "import subprocess, sys, time\n"
        "sys.stdin.readline()\n"
        f"subprocess.Popen([sys.executable, '-c', {child!r}])\n"
        'print(\'{"type":"ready"}\', flush=True)\n' + ("" if parent_exits else "time.sleep(3)\n"),
    ]
    started = time.monotonic()
    with pytest.raises(ProbeError, match="deadline exceeded"):
        run_probe(command, "bootstrap", timeout=0.4)
    assert time.monotonic() - started < 0.75
    assert started_marker.exists()
    # The orphan inherited both pipes. It would write this marker after the
    # launcher exits if cleanup only killed the immediate process.
    time.sleep(0.85)
    assert not marker.exists()


def test_success_also_stops_descendants_that_closed_their_output_pipes(tmp_path):
    marker = tmp_path / "descendant-survived"
    started_marker = tmp_path / "descendant-started"
    child = (
        "import time; from pathlib import Path; "
        f"Path({str(started_marker)!r}).touch(); "
        f"time.sleep(0.85); Path({str(marker)!r}).touch()"
    )
    command = [
        sys.executable,
        "-c",
        "import subprocess, sys, time; from pathlib import Path\n"
        "sys.stdin.readline()\n"
        f"subprocess.Popen([sys.executable, '-c', {child!r}], "
        "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
        f"started = Path({str(started_marker)!r})\n"
        "deadline = time.monotonic() + 1\n"
        "while not started.exists() and time.monotonic() < deadline: time.sleep(0.01)\n"
        "assert started.exists()\n"
        'print(\'{"type":"ready"}\', flush=True)\n',
    ]
    run_probe(command, "bootstrap", timeout=2)
    assert started_marker.exists()
    time.sleep(0.85)
    assert not marker.exists()


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable script fixture")
def test_both_legacy_safe_probes_share_one_total_deadline(tmp_path, monkeypatch, capsys):
    command_log = tmp_path / "commands.jsonl"
    sidecar = tmp_path / "fixture sidecar"
    sidecar.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys, time\n"
        "payload = json.loads(sys.stdin.readline())\n"
        f"with open({str(command_log)!r}, 'a') as log: log.write(json.dumps(payload) + '\\n')\n"
        "time.sleep(3 if payload.get('verifyRuntime') else 0.6)\n"
        "print(json.dumps({'type': 'runtime_ready' if payload.get('verifyRuntime') else 'ready'}), flush=True)\n"
        "os._exit(0)\n"
    )
    sidecar.chmod(0o755)
    monkeypatch.setattr(sidecar_probe, "PROBE_TIMEOUT_SECONDS", 1.8)
    started = time.monotonic()
    assert sidecar_probe.main(["all", str(sidecar)]) == 1
    assert time.monotonic() - started < 2.2
    captured = capsys.readouterr()
    assert "bootstrap check passed" in captured.out
    assert "runtime check passed" not in captured.out
    assert "runtime verification failed: readiness deadline exceeded" in captured.err
    assert [json.loads(line) for line in command_log.read_text().splitlines()] == [
        {"__command": "smoke_test"},
        {"__command": "smoke_test", "verifyRuntime": True},
    ]


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable script fixture")
def test_cli_diagnostics_do_not_echo_child_stderr_or_sidecar_path(tmp_path):
    sidecar = tmp_path / "private-secret-path"
    sidecar.write_text(
        f"#!{sys.executable}\n"
        "import sys\n"
        "sys.stdin.readline()\n"
        'sys.stderr.write(\'api_key=top-secret {"type":"ready"}\\n\')\n'
    )
    sidecar.chmod(0o755)
    result = subprocess.run(
        [sys.executable, sidecar_probe.__file__, "bootstrap", str(sidecar)],
        capture_output=True,
        text=True,
        timeout=2,
    )
    assert result.returncode == 1 and result.stdout == ""
    assert "exactly one JSONL" in result.stderr and "Rebuild the sidecar" in result.stderr
    assert "top-secret" not in result.stderr and str(sidecar) not in result.stderr
    assert "Traceback" not in result.stderr


def test_missing_executable_has_a_fixed_diagnostic(tmp_path, capsys):
    path = tmp_path / "private-secret-path"
    assert sidecar_probe.main(["all", str(path)]) == 1
    error = capsys.readouterr().err
    assert "could not be started" in error and str(path) not in error


@pytest.mark.skipif(os.name == "nt", reason="POSIX group cleanup failure fixture")
def test_cleanup_os_errors_are_sanitized_and_preserve_the_original_failure(monkeypatch):
    def denied_group_cleanup(*args):
        raise PermissionError("private/path api_key=secret")

    monkeypatch.setattr(os, "killpg", denied_group_cleanup)
    with pytest.raises(ProbeError, match="process cleanup failed"):
        run_probe(_command(), "bootstrap", timeout=2)
    with pytest.raises(ProbeError, match="deadline exceeded") as error:
        run_probe(_command(before="time.sleep(1)\n"), "bootstrap", timeout=0.1)
    assert "secret" not in str(error.value)


def test_unexpected_operation_errors_have_no_traceback_or_sensitive_paths(monkeypatch, capsys):
    def unavailable(*args, **kwargs):
        raise OSError("private/path api_key=secret")

    monkeypatch.setattr(sidecar_probe, "run_probe", unavailable)
    assert sidecar_probe.main(["all", "private-sidecar-path"]) == 1
    error = capsys.readouterr().err
    assert "probe operation failed" in error
    assert "secret" not in error and "private" not in error and "Traceback" not in error
