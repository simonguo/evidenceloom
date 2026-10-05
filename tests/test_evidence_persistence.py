"""Independent process owners cannot silently overwrite captured evidence."""

from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

import pytest

from tradingagents.evidence import (
    EvidenceLedger,
    analyst_evidence,
    capture_evidence,
    merge_evidence_bundles,
    validate_evidence_bundle,
)
from tradingagents.evidence.ledger import _canonical
from tradingagents.evidence.persistence import atomic_save_bundle


def _candidates(tmp_path, count):
    checkpoint = EvidenceLedger(
        "EVDM.TEST", "2025-02-14", {"analysts": ["news"]}, tmp_path / "seed"
    ).bundle()
    results = []
    for index in range(count):
        owner = EvidenceLedger.restore(checkpoint, tmp_path / f"owner-{index}")
        with owner.bind(), analyst_evidence("news"):
            capture_evidence(
                "get_news",
                {"ticker": "EVDM.TEST", "limit": index + 1},
                lambda: f"independently captured source {index}",
            )
        results.append(owner.bundle())
    return checkpoint, results


def _save(storage, bundle):
    return atomic_save_bundle(
        storage, bundle, validate_evidence_bundle, merge_evidence_bundles, _canonical
    )


def test_independent_stale_owners_save_a_strict_durable_union(tmp_path):
    checkpoint, (first, second) = _candidates(tmp_path, 2)
    storage = tmp_path / "shared"
    _save(storage, checkpoint)
    _save(storage, first)
    saved = _save(storage, second)
    assert {r["id"] for r in saved["records"]} == {
        r["id"] for owner in (first, second) for r in owner["records"]
    }
    assert len(first["records"]) == len(second["records"]) == 1
    directory = storage / checkpoint["run_id"]
    assert validate_evidence_bundle(json.loads((directory / "bundle.json").read_text())) == saved
    assert {path.name for path in directory.iterdir()} == {"bundle.json", ".lock"}
    if os.name != "nt":
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
        assert stat.S_IMODE((directory / ".lock").stat().st_mode) == 0o600
        assert stat.S_IMODE((directory / "bundle.json").stat().st_mode) == 0o600


def test_corrupt_durable_state_is_not_overwritten_or_exposed(tmp_path):
    checkpoint, (candidate,) = _candidates(tmp_path, 1)
    storage = tmp_path / "shared"
    _save(storage, checkpoint)
    destination = storage / checkpoint["run_id"] / "bundle.json"
    corrupt = b'{"synthetic-secret-body": "untrusted state"}'
    destination.write_bytes(corrupt)
    with pytest.raises(ValueError) as error:
        _save(storage, candidate)
    assert "synthetic-secret-body" not in str(error.value)
    assert str(tmp_path) not in str(error.value)
    assert destination.read_bytes() == corrupt
    assert {path.name for path in destination.parent.iterdir()} == {"bundle.json", ".lock"}


def test_subprocess_writers_serialize_and_keep_every_capture(tmp_path):
    """An exclusive probe inside serialization detects a missing process lock."""
    checkpoint, candidates = _candidates(tmp_path, 4)
    storage = tmp_path / "shared"
    _save(storage, checkpoint)
    gate = tmp_path / "start-writers"
    script = """
import json, os, sys, time
from pathlib import Path
from tradingagents.evidence import validate_evidence_bundle, merge_evidence_bundles
from tradingagents.evidence.ledger import _canonical
from tradingagents.evidence.persistence import atomic_save_bundle

storage, candidate_path, ready_path, gate_path = map(Path, sys.argv[1:])
candidate = json.loads(candidate_path.read_text())
ready_path.touch()
deadline = time.monotonic() + 15
while not gate_path.exists():
    if time.monotonic() > deadline:
        raise RuntimeError('test writer barrier expired')
    time.sleep(0.01)

def serialize(value):
    probe = storage / 'active-serialization'
    descriptor = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        time.sleep(0.15)
        return _canonical(value)
    finally:
        probe.unlink()

atomic_save_bundle(storage, candidate, validate_evidence_bundle, merge_evidence_bundles, serialize)
"""
    processes, ready = [], []
    try:
        for index, candidate in enumerate(candidates):
            candidate_path = tmp_path / f"candidate-{index}.json"
            candidate_path.write_text(_canonical(candidate))
            ready_path = tmp_path / f"ready-{index}"
            ready.append(ready_path)
            processes.append(
                subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        script,
                        str(storage),
                        str(candidate_path),
                        str(ready_path),
                        str(gate),
                    ],
                    cwd=Path(__file__).resolve().parents[1],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
            )
        deadline = time.monotonic() + 10
        while not all(path.exists() for path in ready) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert all(path.exists() for path in ready), "evidence subprocesses failed to initialize"
        gate.touch()
        for process in processes:
            stdout, stderr = process.communicate(timeout=20)
            assert process.returncode == 0, stdout + stderr
    finally:
        gate.touch(exist_ok=True)
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
    saved = validate_evidence_bundle(
        json.loads((storage / checkpoint["run_id"] / "bundle.json").read_text())
    )
    assert {r["id"] for r in saved["records"]} == {
        r["id"] for candidate in candidates for r in candidate["records"]
    }
    assert len(saved["records"]) == 4
    assert not (storage / "active-serialization").exists()
