"""Real immutable publication/retry, corruption and cross-process lock cases."""

from copy import deepcopy
import json
from pathlib import Path
import os
import subprocess
import sys

import pytest

from tradingagents.memory.schema import make_component
from tradingagents.research.effective_request_identity import EffectiveRequestIdentityError
from tradingagents.research.effective_request_identity_persistence import (
    EffectiveRequestIdentityPersistenceError,
    freeze_effective_request_identity,
)

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures/effective_request_identity_v1.json").read_bytes()
)


def test_first_reviewed_clock_and_saved_bytes_remain_immutable(tmp_path):
    first = freeze_effective_request_identity(tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"])
    path = tmp_path / first["run_id"] / "effective_request_identity.json"
    original = path.read_bytes()
    assert first == freeze_effective_request_identity(
        tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"]
    )
    assert first == freeze_effective_request_identity(
        tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"], existing=first
    )
    assert path.read_bytes() == original
    first["summary"]["unsafe_record_ids"].clear()
    assert json.loads(path.read_bytes())["summary"]["unsafe_record_ids"]


@pytest.mark.parametrize("change", ["new_reviewed_clock", "changed_params", "changed_snapshot"])
def test_same_run_changed_context_or_existing_identity_rejected(tmp_path, change):
    from tradingagents.evidence import audit_citations
    from tradingagents.research.numeric_review import make_report_text_snapshot

    evidence, snapshot = deepcopy(FIXTURE["evidence"]), deepcopy(FIXTURE["snapshot"])
    saved = freeze_effective_request_identity(tmp_path, evidence, snapshot)
    path = tmp_path / saved["run_id"] / "effective_request_identity.json"
    original = path.read_bytes()
    existing = None
    if change == "new_reviewed_clock":
        existing = make_component(
            dict(saved, reviewed_at="2027-01-09T12:00:00.000000Z"), "assessment_sha256"
        )
    elif change == "changed_params":
        evidence["records"][0]["parameters"]["symbol"] = "OTHER"
        evidence = make_component(evidence, "bundle_sha256")
        evidence = audit_citations(evidence, snapshot["report_sections"])
        snapshot = make_report_text_snapshot(
            evidence, snapshot["report_sections"], captured_at=snapshot["captured_at"]
        )
    else:
        sections = dict(snapshot["report_sections"], final_trade_decision="Changed original report")
        evidence = audit_citations(evidence, sections)
        snapshot = make_report_text_snapshot(
            evidence, sections, captured_at=snapshot["captured_at"]
        )
    with pytest.raises(EffectiveRequestIdentityError):
        freeze_effective_request_identity(tmp_path, evidence, snapshot, existing=existing)
    assert path.read_bytes() == original


@pytest.mark.parametrize(
    "payload",
    [b'{"error":"network failed"}', b'{"schema_version":1,"schema_version":1}', b"not json"],
)
def test_corrupt_saved_file_never_replaced(tmp_path, payload):
    result = freeze_effective_request_identity(tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"])
    path = tmp_path / result["run_id"] / "effective_request_identity.json"
    path.write_bytes(payload)
    with pytest.raises(EffectiveRequestIdentityError):
        freeze_effective_request_identity(tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"])
    assert path.read_bytes() == payload


def test_output_size_bound_and_atomic_write_failure(tmp_path, monkeypatch):
    from tradingagents.research import effective_request_identity_persistence as module

    monkeypatch.setattr(module, "MAX_ASSESSMENT_BYTES", 10)
    with pytest.raises(EffectiveRequestIdentityError):
        freeze_effective_request_identity(tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"])
    path = tmp_path / FIXTURE["evidence"]["run_id"] / "effective_request_identity.json"
    assert not path.exists()
    monkeypatch.setattr(module, "MAX_ASSESSMENT_BYTES", 64 * 1024 * 1024)

    def fail_replace(*_):
        raise OSError("private path and secret must not reach the diagnostic")

    monkeypatch.setattr(module.os, "replace", fail_replace)
    with pytest.raises(EffectiveRequestIdentityPersistenceError) as error:
        freeze_effective_request_identity(tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"])
    assert str(error.value) == "Effective outer-request assessment could not be saved or loaded"
    assert not path.exists()
    assert sorted(p.name for p in path.parent.iterdir()) == [".lock"]


def test_existing_file_read_is_bounded_and_never_replaced(tmp_path, monkeypatch):
    from tradingagents.research import effective_request_identity_persistence as module

    result = freeze_effective_request_identity(tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"])
    path = tmp_path / result["run_id"] / "effective_request_identity.json"
    payload = path.read_bytes()
    monkeypatch.setattr(module, "MAX_ASSESSMENT_BYTES", len(payload) - 1)
    with pytest.raises(EffectiveRequestIdentityError):
        freeze_effective_request_identity(tmp_path, FIXTURE["evidence"], FIXTURE["snapshot"])
    assert path.read_bytes() == payload


def test_separate_processes_share_first_clock_and_identity(tmp_path):
    fixture_path = Path(__file__).parent / "fixtures/effective_request_identity_v1.json"
    code = """
import json,sys
from pathlib import Path
from tradingagents.research.effective_request_identity_persistence import freeze_effective_request_identity
f=json.loads(Path(sys.argv[1]).read_bytes())
a=freeze_effective_request_identity(sys.argv[2],f['evidence'],f['snapshot'])
print(a['assessment_sha256'])
"""
    env = dict(
        os.environ,
        PYTHONPATH=str(fixture_path.parents[2]),
        PYTHON_DOTENV_DISABLED="1",
        LANGCHAIN_TRACING_V2="false",
        LANGSMITH_TRACING="false",
    )
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", code, str(fixture_path), str(tmp_path)],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for _ in range(2)
    ]
    try:
        outputs = [process.communicate(timeout=30) for process in processes]
        assert [process.returncode for process in processes] == [0, 0]
        assert outputs[0][0] == outputs[1][0]
        saved = json.loads(
            (
                tmp_path / FIXTURE["evidence"]["run_id"] / "effective_request_identity.json"
            ).read_bytes()
        )
        assert outputs[0][0].decode("ascii").strip() == saved["assessment_sha256"]
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
