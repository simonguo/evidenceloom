"""Launcher regressions with owned inert bytes and fake handles."""

from __future__ import annotations

import copy
from contextlib import ExitStack
import json
import os
import sqlite3
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_desktop_acceptance_boundary as boundary  # noqa: E402
import run_desktop_acceptance as launcher  # noqa: E402


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="owned-launcher-unit-", dir=os.environ["TMPDIR"]
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.session, self.build = "a" * 32, "b" * 64
        self.document = {
            "schemaVersion": 1,
            "recordKind": "native_shutdown",
            "sessionId": self.session,
            "buildId": self.build,
            "firstCause": "driver_complete",
            "failureObserved": False,
            "status": "completed",
            "errorCode": None,
            "cleanupWorkerJoined": True,
            "watchdogWorkerJoined": True,
            "exitDispatcherIsCurrentThread": True,
            "nativeExitEligible": True,
            "nativeExitAuthorized": False,
            "recordWriterJoinRequired": True,
            "facts": {key: None for key in launcher.FACT_KEYS},
        }
        self.document["facts"].update(
            {
                "admissionClosed": True,
                "privateControlsClosed": True,
                "auxiliaryCleanupConfirmed": True,
                "capturedOwner": None,
                "capturedRegistryOwnerRetained": False,
                "runtimeInitialization": "ready",
                "runtimeGate": "vacant",
                "journalGate": "ready",
                "runtimeOwnerPresent": False,
                "blockerCount": 0,
                "snapshotCoherent": True,
                "journalCount": 4,
                "unsettledJournalCount": 0,
                "heartbeatWorkerJoined": True,
                "nativeTasks": {
                    "closed": True,
                    "accepted": 23,
                    "joined": 23,
                    "pending": 0,
                    "panicked": False,
                },
            }
        )

    def test_exact_completed_record_is_only_eligible_not_writer_authorized(self):
        self.assertIs(
            launcher.completed_native_record(self.document, self.session, self.build), self.document
        )
        self.assertFalse(self.document["nativeExitAuthorized"])

    def test_unknown_unjoined_unsettled_or_incoherent_facts_reject(self):
        changes = [
            ("heartbeatWorkerJoined", False),
            ("auxiliaryCleanupConfirmed", None),
            ("capturedRegistryOwnerRetained", True),
            ("snapshotCoherent", False),
            ("journalCount", 0),
            ("unsettledJournalCount", 1),
        ]
        for key, value in changes:
            mutant = copy.deepcopy(self.document)
            mutant["facts"][key] = value
            with self.assertRaises(boundary.BoundaryError):
                launcher.completed_native_record(mutant, self.session, self.build)
        for key, value in (("pending", 1), ("joined", 22), ("panicked", True), ("closed", False)):
            mutant = copy.deepcopy(self.document)
            mutant["facts"]["nativeTasks"][key] = value
            with self.assertRaises(boundary.BoundaryError):
                launcher.completed_native_record(mutant, self.session, self.build)

    def test_serialized_authorization_unknown_fields_and_other_identity_reject(self):
        for change in (
            {"nativeExitAuthorized": True},
            {"extra": True},
            {"sessionId": "c" * 32},
            {"buildId": "c" * 64},
            {"recordWriterJoinRequired": False},
            {"firstCause": "heartbeat_lost"},
        ):
            mutant = {**copy.deepcopy(self.document), **change}
            with self.assertRaises(boundary.BoundaryError):
                launcher.completed_native_record(mutant, self.session, self.build)

    def test_duplicate_json_and_partial_record_reject(self):
        for raw in (
            b'{"schemaVersion":1,"schemaVersion":1}',
            b'{"schemaVersion":',
            b'{"counter":NaN}',
        ):
            with self.assertRaises((boundary.BoundaryError, ValueError)):
                launcher.strict_raw(raw, 8192)

    def test_seven_field_manifest_and_empty_base_environment_leave_native_dirs_fresh(self):
        stamp = {
            "permittedOwnedParent": str(self.root),
            "buildId": self.build,
            "target": "aarch64-apple-darwin",
        }
        with (
            patch.object(launcher.sys, "platform", "darwin"),
            patch.dict(
                os.environ,
                {
                    "FICTIONAL_PROVIDER_KEY": "inert-fictional-parent-value",
                    "HOME": "inert-parent-home",
                },
                clear=True,
            ),
        ):
            envelope, root, session, environment = launcher.prepare_session(stamp, "d" * 64)
        manifest = boundary.load_json(envelope / "launch-manifest.json")
        self.assertEqual(
            set(manifest),
            {
                "schemaVersion",
                "mode",
                "sessionId",
                "ownedRoot",
                "buildId",
                "compiledStampSha256",
                "target",
            },
        )
        self.assertEqual(manifest["sessionId"], session)
        self.assertNotIn("FICTIONAL_PROVIDER_KEY", environment)
        self.assertEqual(
            set(environment),
            {
                "HOME",
                "USERPROFILE",
                "TMPDIR",
                "TMP",
                "TEMP",
                "EVIDENCELOOM_DESKTOP_ACCEPTANCE_MANIFEST",
            },
        )
        self.assertEqual(environment["HOME"], str(envelope / "home"))
        self.assertEqual([item.name for item in root.iterdir()], [".desktop-acceptance-owner.json"])

    def test_heartbeat_counter_advances_and_other_owner_never_overwrites(self):
        control = self.root / "control"
        control.mkdir()
        launcher.write_heartbeat(control, self.session, self.build, 1)
        launcher.write_heartbeat(control, self.session, self.build, 2)
        original = (control / "launcher-heartbeat.json").read_bytes()
        self.assertEqual(
            set(json.loads(original)), {"schemaVersion", "sessionId", "buildId", "counter"}
        )
        self.assertEqual(json.loads(original)["counter"], "2")
        for session, counter in ((self.session, 2), ("c" * 32, 3)):
            with self.assertRaises(boundary.BoundaryError):
                launcher.write_heartbeat(control, session, self.build, counter)
            self.assertEqual((control / "launcher-heartbeat.json").read_bytes(), original)

    def database_fixture(self):
        path = self.root / "owned-fictional.db"
        connection = sqlite3.connect(path)
        connection.executescript("""
            CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT,report_sections TEXT,stats TEXT,ticker TEXT,instrument_name TEXT,analysis_date TEXT,asset_type TEXT,research_depth INTEGER,analysts TEXT,output_language TEXT);
            CREATE TABLE analysis_journals(journal_id TEXT PRIMARY KEY,origin_json TEXT,binding_json TEXT,header_json TEXT,cleanup_state TEXT,result_state TEXT,body_state TEXT,sealed_seq INTEGER,applied_seq INTEGER,latest_seq INTEGER,worker_outcome TEXT,control_revision INTEGER);
            CREATE TABLE task_report_versions(id TEXT PRIMARY KEY,task_id TEXT,run_id TEXT,version_number INTEGER,snapshot TEXT);
            CREATE TABLE analysis_requests(journal_id TEXT,kind TEXT,outcome TEXT,origin_json TEXT,binding_json TEXT,receipt_json TEXT);
            CREATE TABLE analysis_controls(journal_id TEXT,revision INTEGER,outcome TEXT);
        """)
        tasks, witnesses = [], []
        frozen_task = {
            "ticker": "FICTION",
            "instrumentName": "Fictional",
            "analysisDate": "2000-01-01",
            "assetType": "stock",
            "researchDepth": 1,
            "analysts": ["market"],
            "outputLanguage": "en",
        }
        for index, slot in enumerate(("a", "b", "c", "d"), 1):
            task_id = f"00000000-0000-4000-8000-{index:012d}"
            run = "analysis-" + str(index)
            journal = str(index) * 64
            origin = {"runtimeEpoch": "e" * 64, "taskId": task_id, "runId": run}
            binding = {
                "collection": {"collectionId": "inert-collection", "epoch": "0"},
                "taskId": task_id,
                "generation": "0",
            }
            header = {
                "journalId": journal,
                "origin": origin,
                "binding": binding,
                "headerDigest": "f" * 64,
            }
            stopped = slot in ("a", "c")
            version_id = None if stopped else f"report:{journal}:2"
            sections = {} if stopped else {"market_report": launcher.FIXTURE_REPORT}
            task = {
                "slot": slot,
                "taskId": task_id,
                "runId": run,
                "status": "stopped" if stopped else "succeeded",
                "reportVersionId": version_id,
            }
            tasks.append(task)
            witnesses.append(
                {
                    "origin": origin,
                    "journalId": journal,
                    "binding": binding,
                    "headerDigest": header["headerDigest"],
                    "releaseNonce": "a" * 32,
                }
            )
            connection.execute(
                "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    task_id,
                    "stopped" if stopped else "completed",
                    json.dumps(sections),
                    json.dumps(launcher.FIXTURE_STATS),
                    frozen_task["ticker"],
                    frozen_task["instrumentName"],
                    frozen_task["analysisDate"],
                    frozen_task["assetType"],
                    frozen_task["researchDepth"],
                    json.dumps(frozen_task["analysts"]),
                    frozen_task["outputLanguage"],
                ),
            )
            connection.execute(
                "INSERT INTO analysis_journals VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    journal,
                    json.dumps(origin),
                    json.dumps(binding),
                    json.dumps(header),
                    "confirmed",
                    "projected",
                    "available",
                    3,
                    3,
                    3,
                    "cancelled" if stopped else "succeeded",
                    1 if stopped else 0,
                ),
            )
            if stopped:
                receipt = {
                    "recoveryProtocolVersion": 1,
                    "requestId": "stop-" + slot,
                    "digest": "f" * 64,
                    "origin": origin,
                    "journalId": journal,
                    "controlRevision": "1",
                    "outcome": "cleanup_confirmed",
                    "sqlCommitted": True,
                }
                connection.execute(
                    "INSERT INTO analysis_requests VALUES(?,?,?,?,?,?)",
                    (
                        journal,
                        "control",
                        "committed",
                        json.dumps(origin),
                        json.dumps(binding),
                        json.dumps(receipt),
                    ),
                )
                connection.execute(
                    "INSERT INTO analysis_controls VALUES(?,?,?)", (journal, 1, "cleanup_confirmed")
                )
            else:
                snapshot = {
                    "id": version_id,
                    "runId": run,
                    "task": frozen_task,
                    "reportSections": sections,
                    "stats": launcher.FIXTURE_STATS,
                }
                connection.execute(
                    "INSERT INTO task_report_versions VALUES(?,?,?,?,?)",
                    (version_id, task_id, run, 1, json.dumps(snapshot)),
                )
        connection.commit()
        connection.close()
        return path, {"tasks": tasks, "witnesses": witnesses}

    def test_actual_owned_sqlite_rows_correlate_four_original_runs_and_stop_seals(self):
        path, controls = self.database_fixture()
        rows = launcher.audit_database(path, controls)
        self.assertEqual([row["slot"] for row in rows], ["a", "b", "c", "d"])
        self.assertEqual([bool(row["stopReceipts"]) for row in rows], [True, False, True, False])
        self.assertEqual(
            [row["reportVersionId"] is not None for row in rows], [False, True, False, True]
        )

    def test_sqlite_wrong_stop_cleanup_or_report_run_cannot_pass_status_only(self):
        path, controls = self.database_fixture()
        connection = sqlite3.connect(path)
        connection.execute(
            "UPDATE analysis_journals SET cleanup_state='unknown' WHERE journal_id=?", ("1" * 64,)
        )
        connection.commit()
        with self.assertRaises(boundary.BoundaryError):
            launcher.audit_database(path, controls)
        connection.execute(
            "UPDATE analysis_journals SET cleanup_state='confirmed' WHERE journal_id=?", ("1" * 64,)
        )
        connection.execute(
            "UPDATE task_report_versions SET run_id='analysis-999' WHERE task_id=?",
            (controls["tasks"][1]["taskId"],),
        )
        connection.commit()
        connection.close()
        with self.assertRaises(boundary.BoundaryError):
            launcher.audit_database(path, controls)

    def launched_fixture(self, return_code, alive=False):
        executable = self.root / "inert-App-file"
        executable.write_bytes(b"owned inert bytes; not an executable")
        grant_path = self.root / "grant.json"
        proof_sha = "e" * 64
        boundary.write_json(
            grant_path,
            {
                "stage": "owned-app-launch",
                "singleAttempt": True,
                "expectedProofSha256": proof_sha,
                "expectedLauncherSha256": boundary.hash_file(Path(launcher.__file__).resolve())[
                    "sha256"
                ],
            },
        )
        stamp = {
            "permittedOwnedParent": str(self.root),
            "buildId": self.build,
            "target": "aarch64-apple-darwin",
        }
        proof = {"compiledStampSha256": "d" * 64}
        calls = []

        class OriginalHandle:
            pid = 12345

            def poll(self):
                return None if alive and not calls else return_code

            def wait(self, timeout):
                calls.append(("wait", timeout))
                return return_code

            def kill(self):
                calls.append(("kill",))

        handle = OriginalHandle()

        def spawn(*args, **kwargs):
            # No process is spawned. The native final file is inert fixture data.
            control = Path(kwargs["cwd"]) / "control"
            control.mkdir()
            manifest = boundary.load_json(kwargs["env"]["EVIDENCELOOM_DESKTOP_ACCEPTANCE_MANIFEST"])
            record = copy.deepcopy(self.document)
            record["sessionId"] = manifest["sessionId"]
            boundary.write_json(control / "native-shutdown.json", record)
            return handle

        return executable, grant_path, proof_sha, stamp, proof, calls, handle, spawn

    def test_complete_native_file_cannot_replace_original_nonzero_wait(self):
        executable, grant, proof_sha, stamp, proof, calls, handle, spawn = self.launched_fixture(1)
        with (
            patch.object(
                launcher, "validate_builder_output", return_value=(proof, stamp, executable)
            ),
            patch.object(launcher.subprocess, "Popen", side_effect=spawn),
            patch.object(launcher, "audit_database") as audit,
        ):
            with self.assertRaises(boundary.BoundaryError):
                launcher.launch(
                    self.root / "inert-proof.json",
                    proof_sha,
                    grant,
                    boundary.hash_file(grant)["sha256"],
                )
            audit.assert_not_called()
        self.assertEqual(calls, [("wait", 0)])
        terminal = boundary.load_json(
            next(self.root.glob("launcher-session-*/records/launcher-terminal.json"))
        )
        self.assertEqual(terminal["status"], "failed")
        self.assertEqual(terminal["originalAppPid"], handle.pid)
        self.assertEqual(terminal["actualDirectWaitReturnCode"], 1)

    @unittest.skipUnless(os.name != "nt", "POSIX group signal fixture")
    def test_deadline_kill_and_late_completed_file_stay_failure_even_wait_returns_zero(self):
        executable, grant, proof_sha, stamp, proof, calls, handle, spawn = self.launched_fixture(
            0, alive=True
        )
        with (
            patch.object(
                launcher, "validate_builder_output", return_value=(proof, stamp, executable)
            ),
            patch.object(launcher.subprocess, "Popen", side_effect=spawn),
            patch.object(launcher, "GLOBAL_SECONDS", -1),
            patch.object(
                launcher.os, "killpg", side_effect=lambda *_args: calls.append(("group-kill",))
            ),
            patch.object(launcher, "audit_database") as audit,
        ):
            with self.assertRaises(boundary.BoundaryError):
                launcher.launch(
                    self.root / "inert-proof.json",
                    proof_sha,
                    grant,
                    boundary.hash_file(grant)["sha256"],
                )
            audit.assert_not_called()
        self.assertIn(("wait", 3), calls)
        terminal = boundary.load_json(
            next(self.root.glob("launcher-session-*/records/launcher-terminal.json"))
        )
        self.assertEqual(terminal["status"], "failed")
        self.assertTrue(terminal["launcherIntervened"])
        self.assertEqual(terminal["orphanClassification"], "unknown")
        self.assertFalse(terminal["certificate"])

    def test_final_poll_overlimit_raw_exit_zero_rejects_before_native_and_sql(self):
        # Inert App/native fixture plus actual owned raw bytes, never a real App.
        executable, grant, proof_sha, stamp, proof, calls, handle, spawn = self.launched_fixture(0)

        def final_poll_spawn(*args, **kwargs):
            original = spawn(*args, **kwargs)
            wrote = False

            def final_poll():
                nonlocal wrote
                if not wrote:
                    wrote = True
                    kwargs["stderr"].write(b"x" * (launcher.RAW_MAX + 1))
                    kwargs["stderr"].flush()
                return 0

            original.poll = final_poll
            return original

        with (
            patch.object(
                launcher, "validate_builder_output", return_value=(proof, stamp, executable)
            ),
            patch.object(launcher.subprocess, "Popen", side_effect=final_poll_spawn),
            patch.object(launcher, "completed_native_record") as native,
            patch.object(launcher, "audit_database") as audit,
        ):
            with self.assertRaises(boundary.BoundaryError):
                launcher.launch(
                    self.root / "inert-proof.json",
                    proof_sha,
                    grant,
                    boundary.hash_file(grant)["sha256"],
                )
            native.assert_not_called()
            audit.assert_not_called()
        self.assertEqual(calls, [("wait", 0)])
        terminal = boundary.load_json(
            next(self.root.glob("launcher-session-*/records/launcher-terminal.json"))
        )
        self.assertEqual(terminal["status"], "failed")
        self.assertEqual(terminal["reason"], "launcher_raw_output_limit")
        self.assertEqual(terminal["actualDirectWaitReturnCode"], 0)
        self.assertEqual(terminal["rawOutputBytes"], {"stdout": 0, "stderr": launcher.RAW_MAX + 1})
        self.assertFalse(terminal["launcherIntervened"])
        self.assertFalse(terminal["certificate"])

    def test_final_poll_late_exit_zero_rejects_before_native_and_sql(self):
        # Fake retained handle, inert native bytes and pure time; no App launch.
        executable, grant, proof_sha, stamp, proof, calls, handle, spawn = self.launched_fixture(0)
        late = 10 + launcher.GLOBAL_SECONDS + 1
        ticks = iter((10, late))
        with (
            patch.object(
                launcher, "validate_builder_output", return_value=(proof, stamp, executable)
            ),
            patch.object(launcher.subprocess, "Popen", side_effect=spawn),
            patch.object(launcher.time, "monotonic", side_effect=lambda: next(ticks, late)),
            patch.object(launcher, "completed_native_record") as native,
            patch.object(launcher, "audit_database") as audit,
        ):
            with self.assertRaises(boundary.BoundaryError):
                launcher.launch(
                    self.root / "inert-proof.json",
                    proof_sha,
                    grant,
                    boundary.hash_file(grant)["sha256"],
                )
            native.assert_not_called()
            audit.assert_not_called()
        self.assertEqual(calls, [("wait", 0)])
        terminal = boundary.load_json(
            next(self.root.glob("launcher-session-*/records/launcher-terminal.json"))
        )
        self.assertEqual(terminal["status"], "failed")
        self.assertEqual(terminal["reason"], "launcher_deadline")
        self.assertEqual(terminal["actualDirectWaitReturnCode"], 0)
        self.assertEqual(terminal["seconds"], launcher.GLOBAL_SECONDS + 1)
        self.assertEqual(terminal["rawOutputBytes"], {"stdout": 0, "stderr": 0})
        self.assertFalse(terminal["launcherIntervened"])
        self.assertFalse(terminal["certificate"])

    def launcher_failure_fixture(self, failure, where="start", receipts_fail=False):
        executable, grant, proof_sha, stamp, proof, calls, handle, spawn = self.launched_fixture(
            0, alive=True
        )
        original_write, original_sizes, original_poll = (
            boundary.write_json,
            launcher.evidence.raw_output_sizes,
            handle.poll,
        )
        seen = False

        def poll():
            nonlocal seen
            if where == "poll" and not seen:
                seen = True
                raise failure
            return original_poll()

        handle.poll = poll

        def write(path, value):
            if Path(path).name == "app-start.json" and where == "start":
                raise failure
            if receipts_fail and Path(path).name == "launcher-terminal.json":
                raise OSError("fictional failure receipt unavailable")
            return original_write(path, value)

        def sizes(directory, name):
            nonlocal seen
            if where == "sizes" and not seen:
                seen = True
                raise failure
            return original_sizes(directory, name)

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    launcher, "validate_builder_output", return_value=(proof, stamp, executable)
                )
            )
            stack.enter_context(patch.object(launcher.subprocess, "Popen", side_effect=spawn))
            stack.enter_context(
                patch.object(
                    launcher.os,
                    "killpg",
                    side_effect=lambda *_args: calls.append(("group-kill",)),
                    create=True,
                )
            )
            stack.enter_context(patch.object(boundary, "write_json", side_effect=write))
            stack.enter_context(
                patch.object(launcher.evidence, "raw_output_sizes", side_effect=sizes)
            )
            native = stack.enter_context(patch.object(launcher, "completed_native_record"))
            audit = stack.enter_context(patch.object(launcher, "audit_database"))
            kind = boundary.BoundaryError if isinstance(failure, OSError) else type(failure)
            with self.assertRaises(kind) as caught:
                launcher.launch(
                    self.root / "inert-proof.json",
                    proof_sha,
                    grant,
                    boundary.hash_file(grant)["sha256"],
                )
            if not isinstance(failure, OSError):
                self.assertIs(caught.exception, failure)
            native.assert_not_called()
            audit.assert_not_called()
        self.assertEqual([row for row in calls if row[0] == "wait"], [("wait", 3)])
        paths = list(self.root.glob("launcher-session-*/records/launcher-terminal.json"))
        return calls, boundary.load_json(paths[0]) if paths else None

    def test_start_receipt_oserror_cleans_original_app_before_failed_receipt(self):
        _, record = self.launcher_failure_fixture(OSError("fictional app start receipt failure"))
        self.assertEqual(record["actualDirectWaitReturnCode"], 0)
        self.assertTrue(record["launcherIntervened"])
        self.assertTrue(record["cleanup"]["actualDirectWaitObserved"])
        self.assertEqual(record["rawOutputBytes"], {"stdout": 0, "stderr": 0})
        self.assertFalse(record["certificate"])

    def test_live_raw_metadata_oserror_cannot_skip_original_app_wait(self):
        _, record = self.launcher_failure_fixture(
            OSError("fictional app metadata failure"), "sizes"
        )
        self.assertEqual(record["orphanClassification"], "unknown")
        self.assertFalse(record["certificate"])

    def test_keyboard_interrupt_propagates_after_original_app_cleanup(self):
        _, record = self.launcher_failure_fixture(KeyboardInterrupt(), "poll")
        self.assertEqual(record["reason"], "supervisor_keyboard_interrupt")
        self.assertFalse(record["certificate"])

    def test_private_sigterm_exception_propagates_after_original_app_cleanup(self):
        _, record = self.launcher_failure_fixture(launcher.evidence.SupervisorTerminated(), "poll")
        self.assertEqual(record["reason"], "supervisor_sigterm")
        self.assertFalse(record["certificate"])

    def test_system_exit_keeps_original_code_after_original_app_cleanup(self):
        _, record = self.launcher_failure_fixture(SystemExit(23))
        self.assertFalse(record["certificate"])

    def test_unknown_error_keeps_original_semantics_after_original_app_cleanup(self):
        _, record = self.launcher_failure_fixture(RuntimeError("fictional unknown app error"))
        self.assertFalse(record["certificate"])

    def test_unavailable_failed_app_receipt_cannot_skip_original_cleanup(self):
        calls, record = self.launcher_failure_fixture(
            OSError("fictional app start receipt failure"), receipts_fail=True
        )
        self.assertIsNone(record)
        self.assertEqual([row for row in calls if row[0] == "wait"], [("wait", 3)])

    def launcher_cleanup_interrupt_fixture(self, where, keyboard=False):
        # Complete owned inert inputs; ordinary app-start write failure happens
        # before the first mocked handler/KeyboardInterrupt in failure cleanup.
        fixture_root = self.root / (
            "cleanup-interrupt-" + str(len(list(self.root.glob("cleanup-interrupt-*"))))
        )
        fixture_root.mkdir()
        with patch.object(self, "root", fixture_root):
            executable, grant, proof_sha, stamp, proof, calls, handle, original_spawn = (
                self.launched_fixture(0, alive=True)
            )
        changes, requested, observed, owned_records = [], [], [], []
        ordinary_failure_seen = False
        previous = object()
        original_write = boundary.write_json

        def interrupt_at(operation):
            if operation != where:
                return
            self.assertTrue(ordinary_failure_seen)
            calls.append(("interrupt", operation))
            if keyboard:
                interrupt = KeyboardInterrupt()
                requested.append(interrupt)
                raise interrupt
            try:
                changes[0][1](launcher.evidence.signal.SIGTERM, None)
            except launcher.evidence.SupervisorTerminated as interrupt:
                requested.append(interrupt)
                raise

        def poll():
            calls.append(("poll", handle))
            interrupt_at("poll")
            return None

        def wait(timeout):
            calls.append(("wait", handle, timeout))
            interrupt_at("wait")
            return 0

        def kill():
            calls.append(("kill", handle))
            interrupt_at("kill")

        handle.poll, handle.wait, handle.kill = poll, wait, kill

        def spawn(*args, **kwargs):
            owned_records.append(Path(kwargs["stdout"].name).parent)
            kwargs["stdout"].write(b"owned partial app stdout")
            kwargs["stderr"].write(b"owned partial app stderr")
            return original_spawn(*args, **kwargs)

        def kill_group(pid, _signal):
            self.assertEqual(pid, handle.pid)
            calls.append(("group-kill", handle))
            interrupt_at("kill")

        def write(path, value):
            nonlocal ordinary_failure_seen
            if Path(path).name == "app-start.json":
                ordinary_failure_seen = True
                calls.append(("ordinary-start-write-error",))
                raise OSError("fictional app start receipt failure before interruption")
            if Path(path).name == "launcher-terminal.json":
                interrupt_at("receipt")
            return original_write(path, value)

        original_sizes = launcher.evidence.raw_output_sizes

        def sizes(directory, name):
            interrupt_at("sizes")
            return original_sizes(directory, name)

        def main():
            try:
                launcher.launch(
                    fixture_root / "inert-proof.json",
                    proof_sha,
                    grant,
                    boundary.hash_file(grant)["sha256"],
                )
            except (KeyboardInterrupt, launcher.evidence.SupervisorTerminated) as interrupt:
                observed.append(interrupt)
                raise

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(
                    launcher, "validate_builder_output", return_value=(proof, stamp, executable)
                )
            )
            stack.enter_context(
                patch.object(launcher.evidence.signal, "getsignal", return_value=previous)
            )
            stack.enter_context(
                patch.object(
                    launcher.evidence.signal,
                    "signal",
                    side_effect=lambda number, handler: changes.append((number, handler)),
                )
            )
            spawned = stack.enter_context(
                patch.object(launcher.subprocess, "Popen", side_effect=spawn)
            )
            stack.enter_context(
                patch.object(launcher.os, "killpg", side_effect=kill_group, create=True)
            )
            stack.enter_context(patch.object(boundary, "write_json", side_effect=write))
            stack.enter_context(
                patch.object(launcher.evidence, "raw_output_sizes", side_effect=sizes)
            )
            native = stack.enter_context(patch.object(launcher, "completed_native_record"))
            audit = stack.enter_context(patch.object(launcher, "audit_database"))
            with self.assertRaises(SystemExit) as caught:
                launcher.evidence.supervised_entrypoint(main)
            spawned.assert_called_once()
            native.assert_not_called()
            audit.assert_not_called()
        self.assertEqual(caught.exception.code, 130 if keyboard else 143)
        self.assertEqual(changes[-1], (launcher.evidence.signal.SIGTERM, previous))
        self.assertIs(observed[0], requested[0])
        self.assertEqual([row for row in calls if row[0] == "wait"], [("wait", handle, 3)])
        self.assertEqual(calls[0], ("ordinary-start-write-error",))
        self.assertEqual(len(owned_records), 1)
        self.assertEqual(
            (owned_records[0] / "app.stdout").read_bytes(), b"owned partial app stdout"
        )
        self.assertEqual(
            (owned_records[0] / "app.stderr").read_bytes(), b"owned partial app stderr"
        )
        # Neither inert native bytes nor interrupted cleanup authorizes success.
        self.assertFalse((owned_records[0] / "launcher-terminal.json").exists())

    def test_first_sigterm_in_failed_app_cleanup_poll_waits_original_once_and_exits_143(self):
        self.launcher_cleanup_interrupt_fixture("poll")

    def test_first_sigterm_in_failed_app_cleanup_kill_waits_original_once_and_exits_143(self):
        self.launcher_cleanup_interrupt_fixture("kill")

    def test_first_sigterm_in_failed_app_cleanup_wait_is_not_retried_or_certified(self):
        self.launcher_cleanup_interrupt_fixture("wait")

    def test_first_sigterm_in_failed_app_size_observation_is_not_swallowed(self):
        self.launcher_cleanup_interrupt_fixture("sizes")

    def test_first_sigterm_in_failed_app_receipt_write_is_not_swallowed(self):
        self.launcher_cleanup_interrupt_fixture("receipt")

    def test_first_keyboard_interrupt_in_failed_app_cleanup_or_diagnostics_exits_130(self):
        for where in ("poll", "kill", "wait", "sizes", "receipt"):
            with self.subTest(where=where):
                self.launcher_cleanup_interrupt_fixture(where, keyboard=True)


if __name__ == "__main__":
    unittest.main()
