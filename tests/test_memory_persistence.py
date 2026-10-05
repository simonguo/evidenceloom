"""Actual independent memory owners preserve authority under failure and retry."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import os
from pathlib import Path
import stat
import subprocess
import sys
import time

import pytest

from tradingagents.memory import (
    MemoryPersistenceError,
    MemoryStore,
    MemoryValidationError,
    build_review_attachment,
    canonical_json,
    make_component,
)
from tradingagents.memory import store as store_module
from tests.test_memory_contract import outcome, reflected, snapshot


def test_durable_facts_survive_restart_before_reflection_and_cannot_be_replaced(tmp_path):
    first = MemoryStore(tmp_path / "legacy.md")
    base = snapshot()
    first.record_decision(base)
    facts, artifacts = outcome(base)
    saved = first.attach_outcome(base["run_id"], facts, artifacts)
    restarted = MemoryStore(tmp_path / "legacy.md")
    assert restarted.load_decision(base["run_id"]) == saved
    assert saved["reflection"] is None
    assert "123.45678901234567" in saved["artifacts"][facts["facts_sha256"]]["payload"]
    final = reflected(base)
    restarted.record_decision(final)
    assert first.record_decision(base) == final  # A stale owner cannot remove facts.
    changed = deepcopy(final)
    changed["outcome"]["observed_at"] = "2025-02-20T12:01:00Z"
    changed["outcome"] = make_component(changed["outcome"], "outcome_sha256")
    changed["reflection"]["outcome_sha256"] = changed["outcome"]["outcome_sha256"]
    changed["reflection"] = make_component(changed["reflection"], "reflection_sha256")
    changed = make_component(changed, "snapshot_sha256")
    with pytest.raises(MemoryValidationError):
        first.record_decision(changed)
    assert first.load_decision(base["run_id"]) == final


def test_thread_owners_preserve_distinct_same_ticker_date_runs(tmp_path):
    records = [snapshot(index) for index in range(1, 25)]
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(
            executor.map(
                lambda item: MemoryStore(storage_dir=tmp_path / "records").record_decision(item),
                records,
            )
        )
    assert results == records
    store = MemoryStore(storage_dir=tmp_path / "records")
    assert {item["run_id"] for item in store.list_decisions()} == {
        item["run_id"] for item in records
    }


def test_atomic_replace_failure_preserves_previous_record_and_cleans_temp(tmp_path, monkeypatch):
    store = MemoryStore(storage_dir=tmp_path / "records")
    base = snapshot()
    store.record_decision(base)
    destination = store.storage_dir / base["run_id"] / "decision.json"
    original = destination.read_bytes()

    def fail_replace(*args):
        raise OSError("synthetic-secret /Users/synthetic/private.txt")

    monkeypatch.setattr(store_module.os, "replace", fail_replace)
    facts, artifacts = outcome(base)
    with pytest.raises(MemoryPersistenceError) as error:
        store.attach_outcome(base["run_id"], facts, artifacts)
    assert str(error.value) == "Research memory could not be persisted or loaded"
    assert destination.read_bytes() == original
    assert {path.name for path in destination.parent.iterdir()} == {".lock", "decision.json"}


def test_failed_file_fsync_keeps_prior_record_and_stops_completed_facts(tmp_path, monkeypatch):
    store = MemoryStore(storage_dir=tmp_path / "records")
    base = snapshot()
    store.record_decision(base)
    destination = store.storage_dir / base["run_id"] / "decision.json"
    original = destination.read_bytes()
    monkeypatch.setattr(
        store_module.os, "fsync", lambda _: (_ for _ in ()).throw(OSError("private failure"))
    )
    value, artifacts = outcome(base)
    with pytest.raises(MemoryPersistenceError):
        store.attach_outcome(base["run_id"], value, artifacts)
    assert destination.read_bytes() == original
    assert {path.name for path in destination.parent.iterdir()} == {".lock", "decision.json"}


def test_corrupt_or_wrong_uuid_saved_state_is_not_overwritten_or_exposed(tmp_path):
    store = MemoryStore(storage_dir=tmp_path / "records")
    base = snapshot()
    store.record_decision(base)
    destination = store.storage_dir / base["run_id"] / "decision.json"
    for corrupt in (b'{"secret":"synthetic-private-body"}', canonical_json(snapshot(2)).encode()):
        destination.write_bytes(corrupt)
        with pytest.raises(MemoryValidationError) as error:
            store.record_decision(base)
        assert "synthetic-private-body" not in str(error.value)
        assert str(tmp_path) not in str(error.value)
        assert destination.read_bytes() == corrupt


def test_directory_and_files_are_private_and_parent_directory_is_fsynced(tmp_path, monkeypatch):
    calls = []
    actual = store_module._fsync_directory

    def tracked(directory):
        calls.append(Path(directory))
        return actual(directory)

    monkeypatch.setattr(store_module, "_fsync_directory", tracked)
    store = MemoryStore(storage_dir=tmp_path / "records")
    base = snapshot()
    store.record_decision(base)
    directory = store.storage_dir / base["run_id"]
    assert store.storage_dir in calls and directory in calls
    if os.name != "nt":
        assert stat.S_IMODE(store.storage_dir.stat().st_mode) == 0o700
        assert stat.S_IMODE(directory.stat().st_mode) == 0o700
        for name in (".lock", "decision.json"):
            assert stat.S_IMODE((directory / name).stat().st_mode) == 0o600


@pytest.mark.parametrize("durable", [False, True])
def test_as_generated_completion_is_permanent_after_later_outcome_and_restart(tmp_path, durable):
    options = {"storage_dir": tmp_path / "records"} if durable else {}
    store = MemoryStore(**options)
    base = snapshot()
    store.record_decision(base)
    context = store.context_snapshot(
        "EVDM.TEST", base["decision"]["research_as_of"], selected_at="2025-02-14T12:00:00Z"
    )
    original = store.bundle(base["run_id"], context, evidence_bundle_sha256="c" * 64)
    assert original["decision_snapshot"]["outcome"] is None
    store.record_decision(reflected(base))
    restarted = MemoryStore(**options) if durable else store
    assert restarted.bundle(base["run_id"], context, evidence_bundle_sha256="c" * 64) == original
    assert restarted.load_bundle(base["run_id"]) == original
    assert restarted.load_decision(base["run_id"])["reflection"] is not None
    review = build_review_attachment(
        restarted.load_decision(base["run_id"]),
        reviewed_at="2025-02-22T12:00:00Z",
        completion_bundle=original,
    )
    assert review["snapshot"]["outcome"] is not None
    changed_context = deepcopy(context)
    changed_context["same_ticker_limit"] = 4
    changed_context = make_component(changed_context, "input_sha256")
    with pytest.raises(MemoryValidationError):
        restarted.bundle(base["run_id"], changed_context, evidence_bundle_sha256="c" * 64)
    assert restarted.load_bundle(base["run_id"]) == original


def test_completion_atomic_failure_is_visible_and_retry_can_publish_original_decision(
    tmp_path, monkeypatch
):
    store = MemoryStore(storage_dir=tmp_path / "records")
    base = snapshot()
    store.record_decision(base)
    context = store.context_snapshot(
        "EVDM.TEST", base["decision"]["research_as_of"], selected_at="2025-02-14T12:00:00Z"
    )
    actual = store_module.os.replace
    monkeypatch.setattr(
        store_module.os,
        "replace",
        lambda *args: (_ for _ in ()).throw(OSError("private completion failure")),
    )
    with pytest.raises(MemoryPersistenceError):
        store.bundle(base["run_id"], context, evidence_bundle_sha256="c" * 64)
    assert store.load_bundle(base["run_id"]) is None
    assert store.load_decision(base["run_id"]) == base
    monkeypatch.setattr(store_module.os, "replace", actual)
    assert (
        store.bundle(base["run_id"], context, evidence_bundle_sha256="c" * 64)["decision_snapshot"]
        == base
    )


def test_read_only_inventory_never_creates_or_chmods_a_directory_or_lock(tmp_path, monkeypatch):
    root = tmp_path / "absent"
    store = MemoryStore(storage_dir=root)
    assert store.list_decisions() == []
    assert store.load_decision(snapshot()["run_id"]) is None
    assert not root.exists()
    root.mkdir()
    directory = root / snapshot()["run_id"]
    directory.mkdir()
    (directory / "decision.json").write_text(canonical_json(snapshot()))
    monkeypatch.setattr(
        store_module.os, "chmod", lambda *args: pytest.fail("read-only inventory chmod")
    )
    monkeypatch.setattr(
        store_module, "_writer_lock", lambda *args: pytest.fail("read-only inventory writer lock")
    )
    assert store.load_decision(snapshot()["run_id"]) == snapshot()
    assert store.list_decisions() == [snapshot()]
    assert {path.name for path in directory.iterdir()} == {"decision.json"}


def test_invalid_path_identifier_cannot_escape_store_and_errors_are_fixed(tmp_path):
    store = MemoryStore(storage_dir=tmp_path / "records")
    for run_id in ("../private", "secret", None, 1):
        with pytest.raises(MemoryValidationError) as error:
            store.load_decision(run_id)
        assert str(error.value) == "Invalid or conflicting research memory"
    assert not store.storage_dir.exists()


def test_independent_subprocess_owners_lock_and_reject_immutable_conflict(tmp_path):
    """A real exclusive marker during publication detects an absent process lock."""
    base = snapshot()
    final = reflected(base)
    conflicting = snapshot(text="Rating: Sell\nDifferent immutable decision.")
    storage = tmp_path / "records"
    MemoryStore(storage_dir=storage).record_decision(base)
    candidates = [final, base, final, conflicting]
    gate = tmp_path / "release"
    script = r"""
import os, sys, time
from pathlib import Path
from tradingagents.memory import MemoryStore, MemoryValidationError
from tradingagents.memory.schema import parse_json
from tradingagents.memory import store as module

storage, candidate_path, ready, gate, conflict = sys.argv[1:]
candidate = parse_json(Path(candidate_path).read_bytes())
original = module._atomic_write
def publish(directory, value, filename='decision.json'):
    marker = Path(storage) / 'active-writer'
    descriptor = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        time.sleep(0.15)
        return original(directory, value, filename)
    finally:
        marker.unlink()
module._atomic_write = publish
Path(ready).touch()
deadline = time.monotonic() + 15
while not Path(gate).exists():
    if time.monotonic() > deadline:
        sys.exit(4)
    time.sleep(0.01)
try:
    MemoryStore(storage_dir=storage).record_decision(candidate)
except MemoryValidationError:
    sys.exit(0 if conflict == 'yes' else 3)
sys.exit(2 if conflict == 'yes' else 0)
"""
    processes, ready = [], []
    try:
        for index, item in enumerate(candidates):
            candidate_path = tmp_path / f"candidate-{index}.json"
            candidate_path.write_text(canonical_json(item))
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
                        "yes" if index == 3 else "no",
                    ],
                    cwd=Path(__file__).resolve().parents[1],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
                    text=True,
                )
            )
        deadline = time.monotonic() + 15
        while not all(path.exists() for path in ready) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert all(path.exists() for path in ready), "memory subprocess startup failed"
        gate.touch()
        for process in processes:
            stdout, stderr = process.communicate(timeout=20)
            assert process.returncode == 0, stdout + stderr
    finally:
        gate.touch(exist_ok=True)
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
    assert MemoryStore(storage_dir=storage).load_decision(base["run_id"]) == final
    assert not (storage / "active-writer").exists()
    assert {path.name for path in (storage / base["run_id"]).iterdir()} == {
        ".lock",
        "decision.json",
    }
