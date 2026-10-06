"""Owned-file regressions with inert backend and child fixtures."""

from __future__ import annotations

import copy
from contextlib import ExitStack
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_desktop_acceptance_boundary as boundary  # noqa: E402
import desktop_frontend_evidence as evidence  # noqa: E402


class FrontendEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="owned-frontend-evidence-", dir=os.environ["TMPDIR"]
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.frontend = self.root / "frontend"
        self.frontend.mkdir()
        self.parent = self.root / "metadata"
        self.parent.mkdir()
        self.selected = "src/features/desktop-verification/disabled.tsx"
        for name in ("next.config.mjs", "tsconfig.json", self.selected):
            path = self.frontend / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"inert owned source " + name.encode())
        self.registry = {
            "schema": evidence.REGISTRY_SCHEMA,
            "runId": "a" * 32,
            "registryClosed": False,
            "compilerOwner": {
                "pid": 123,
                "nodeVersion": "v22.17.0",
                "nextVersion": evidence.NEXT_VERSION,
                "backend": "webpack",
                "buildWorker": False,
            },
            "proofBoundary": "inert unit compiler record, never executed",
            "persistedEvidence": True,
            "records": [self.record(1, False), self.record(2, True), self.record(3, True, "edge")],
        }

    def source(self, name):
        return {
            "sourcePath": name,
            "sourceSha256": boundary.hash_file(self.frontend / name)["sha256"],
        }

    def record(self, ordinal, server, runtime=None):
        asset = {
            "totals": {"files": 1, "bytes": 4, "decodedBytes": 0},
            "rows": [
                {
                    "relativePath": "owned.js",
                    "bytes": 4,
                    "sha256": "1" * 64,
                    "privateMarkerHits": [],
                }
            ],
        }
        return {
            "callbackOrdinal": ordinal,
            "selection": "normal",
            "dev": False,
            "isServer": server,
            "nextRuntime": (runtime or "nodejs") if server else None,
            "webpackVersion": "5.98.0",
            "buildId": "inert-build",
            "configSource": self.source("next.config.mjs"),
            "tsconfigSource": self.source("tsconfig.json"),
            "selectedSource": self.source(self.selected),
            "compilerApplied": True,
            "status": "complete",
            "iteration": 1,
            "webpackMode": "production",
            "compilationHash": "inert-hash",
            "phases": [{"phase": "finishModules"}, {"phase": "done"}],
            "moduleRows": [
                {"phase": phase, "kind": "physical-source", **self.source(self.selected)}
                for phase in ("finishModules", "done")
            ],
            "resolutions": [{**self.source(self.selected), "resourceSha256": "2" * 64}],
            "replacements": [
                {"originalSpecifier": "@desktop-verification-entry", **self.source(self.selected)}
            ],
            "assets": copy.deepcopy(asset),
            "emittedAssets": copy.deepcopy(asset),
        }

    def validate(self, registry):
        return evidence.validate_registry(
            registry, self.frontend, "normal", 123, {"nextVersion": evidence.NEXT_VERSION}
        )

    def test_complete_whole_registry_has_one_original_client_and_node_server(self):
        self.assertEqual(len(self.validate(self.registry)), 3)

    def test_shipping_empty_selector_rejects_before_lookup_or_metadata_creation(self):
        with patch.object(evidence.shutil, "which") as lookup:
            with self.assertRaises(boundary.BoundaryError):
                evidence.run_frontend(
                    self.frontend, self.parent, "normal", {"PATH": "inert", evidence.SELECTOR: ""}
                )
            lookup.assert_not_called()
        self.assertEqual(list(self.parent.iterdir()), [])

    def test_callback_created_failed_or_missing_done_cannot_close(self):
        for change in (
            {"status": "callback-created", "compilerApplied": False},
            {"status": "failed"},
            {"phases": [{"phase": "finishModules"}]},
            {"iteration": 2},
        ):
            with self.subTest(change=change):
                mutant = copy.deepcopy(self.registry)
                mutant["records"][1].update(change)
                with self.assertRaises(boundary.BoundaryError):
                    self.validate(mutant)

    def test_absent_or_duplicate_server_callback_cannot_close(self):
        for records in (
            [self.record(1, False)],
            [self.record(1, False), self.record(2, True), self.record(3, True)],
        ):
            mutant = copy.deepcopy(self.registry)
            mutant["records"] = records
            with self.assertRaises(boundary.BoundaryError):
                self.validate(mutant)

    def test_other_producer_pid_or_worker_backend_cannot_close(self):
        for field, value in (
            ("pid", 999),
            ("buildWorker", True),
            ("backend", "rspack"),
            ("nextVersion", "15.5.26"),
        ):
            mutant = copy.deepcopy(self.registry)
            mutant["compilerOwner"][field] = value
            with self.assertRaises(boundary.BoundaryError):
                self.validate(mutant)

    def test_normal_private_identifier_or_compressed_marker_hit_rejects(self):
        for field in ("moduleRows", "assets", "emittedAssets"):
            mutant = copy.deepcopy(self.registry)
            if field == "moduleRows":
                name = "src/features/desktop-acceptance/lib/driver.ts"
                path = self.frontend / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"inert private unit implementation")
                mutant["records"][0][field].append(
                    {"phase": "done", "kind": "identifier-reference", **self.source(name)}
                )
            else:
                mutant["records"][0][field]["rows"][0]["privateMarkerHits"] = [evidence.MARKER]
            with self.assertRaises(boundary.BoundaryError):
                self.validate(mutant)

    def private_registry(self):
        required = [
            "src/features/desktop-acceptance/entry.tsx",
            "src/features/desktop-acceptance/lib/api.ts",
            "src/features/desktop-acceptance/lib/driver.ts",
        ]
        for name in required:
            path = self.frontend / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"inert private source " + name.encode())
        registry = copy.deepcopy(self.registry)
        for record in registry["records"]:
            record["selection"] = "acceptance"
            record["selectedSource"] = self.source(required[0])
            record["moduleRows"] = [
                {"phase": phase, "kind": "physical-source", **self.source(name)}
                for phase in ("finishModules", "done")
                for name in required
            ]
            record["resolutions"] = [{**self.source(required[0]), "resourceSha256": "2" * 64}]
            record["replacements"] = [
                {"originalSpecifier": "@desktop-verification-entry", **self.source(required[0])}
            ]
            for field in ("assets", "emittedAssets"):
                record[field]["rows"][0]["privateMarkerHits"] = [evidence.MARKER]
        return registry

    def test_private_requires_each_actual_physical_source_in_both_phases(self):
        registry = self.private_registry()
        self.assertEqual(
            len(
                evidence.validate_registry(
                    registry,
                    self.frontend,
                    "acceptance",
                    123,
                    {"nextVersion": evidence.NEXT_VERSION},
                )
            ),
            3,
        )
        mutant = copy.deepcopy(registry)
        for row in mutant["records"][0]["moduleRows"]:
            if row["sourcePath"].endswith("driver.ts") and row["phase"] == "done":
                row["kind"] = "identifier-reference"
        with self.assertRaises(boundary.BoundaryError):
            evidence.validate_registry(
                mutant, self.frontend, "acceptance", 123, {"nextVersion": evidence.NEXT_VERSION}
            )

    def test_private_physical_graph_without_consumed_handshake_cannot_close(self):
        mutant = self.private_registry()
        mutant["records"][0]["assets"]["rows"][0]["privateMarkerHits"] = []
        with self.assertRaises(boundary.BoundaryError):
            evidence.validate_registry(
                mutant, self.frontend, "acceptance", 123, {"nextVersion": evidence.NEXT_VERSION}
            )

    def test_exact_bytes_detect_mutation_even_with_stale_hash_inventory(self):
        source = self.root / "input"
        source.mkdir()
        (source / "owned.txt").write_bytes(b"same-size-A")
        snapshot = self.root / "snapshot"
        rows = evidence.freeze_files(source, ["owned.txt"], snapshot)
        (source / "owned.txt").write_bytes(b"same-size-B")
        with patch.object(boundary, "inventory", return_value=rows):
            with self.assertRaises(boundary.BoundaryError):
                evidence.verify_frozen(source, snapshot, rows)

    def test_input_parent_symlink_rejects_before_file_read(self):
        original = self.root / "physical"
        original.mkdir()
        file = original / "owned.txt"
        file.write_bytes(b"inert outside owned fixture")
        link = self.root / "link"
        try:
            link.symlink_to(original, target_is_directory=True)
        except OSError:
            self.skipTest("symlink unavailable")
        with self.assertRaises(boundary.BoundaryError):
            evidence.read_bytes(link / "owned.txt")
        self.assertEqual(file.read_bytes(), b"inert outside owned fixture")

    def test_final_poll_overlimit_raw_exit_zero_cannot_close_producer(self):
        # Actual owned raw bytes, fake retained handle; no Next/Node is launched.
        calls = []

        class OriginalHandle:
            pid = 12345

            def __init__(self, stdout):
                self.stdout = stdout

            def poll(self):
                self.stdout.write(b"x" * (evidence.RAW_MAX + 1))
                self.stdout.flush()
                return 0

            def wait(self, timeout):
                calls.append(("wait", timeout))
                return 0

        def spawn(*_args, **kwargs):
            return OriginalHandle(kwargs["stdout"])

        with patch.object(evidence.subprocess, "Popen", side_effect=spawn):
            with self.assertRaises(boundary.BoundaryError):
                evidence.run_child(
                    ["inert-next-not-launched"], self.frontend, {}, self.parent, "next", 300
                )
        self.assertEqual(calls, [("wait", 0)])
        self.assertFalse((self.parent / "next-terminal.json").exists())
        failure = boundary.load_json(self.parent / "next-failure.json")
        self.assertEqual(failure["reason"], "raw_output_limit")
        self.assertEqual(failure["directReturnCode"], 0)
        self.assertEqual(failure["rawOutputBytes"], {"stdout": evidence.RAW_MAX + 1, "stderr": 0})
        self.assertFalse(failure["certificate"])

    def test_final_poll_late_exit_zero_cannot_close_producer(self):
        # Fake original handle and pure clock; production creates owned raw files.
        calls = []

        class OriginalHandle:
            pid = 12345

            def poll(self):
                return 0

            def wait(self, timeout):
                calls.append(("wait", timeout))
                return 0

        ticks = iter((10, 311))
        with (
            patch.object(evidence.subprocess, "Popen", return_value=OriginalHandle()),
            patch.object(evidence.time, "monotonic", side_effect=lambda: next(ticks, 311)),
        ):
            with self.assertRaises(boundary.BoundaryError):
                evidence.run_child(
                    ["inert-next-not-launched"], self.frontend, {}, self.parent, "next", 300
                )
        self.assertEqual(calls, [("wait", 0)])
        self.assertFalse((self.parent / "next-terminal.json").exists())
        failure = boundary.load_json(self.parent / "next-failure.json")
        self.assertEqual(failure["reason"], "deadline")
        self.assertEqual(failure["directReturnCode"], 0)
        self.assertEqual(failure["seconds"], 301)
        self.assertEqual(failure["rawOutputBytes"], {"stdout": 0, "stderr": 0})
        self.assertFalse(failure["certificate"])

    def collector_failure_fixture(self, failure, where="start", receipts_fail=False):
        calls, seen = [], False
        label = "failure-" + str(len(list(self.parent.glob("failure-*.stdout"))))

        class OriginalHandle:
            pid = 12345

            def poll(self):
                nonlocal seen
                if where == "poll" and not seen:
                    seen = True
                    raise failure
                return None

            def wait(self, timeout):
                calls.append(("wait", timeout))
                return 77

            def kill(self):
                calls.append(("kill",))

        original_write, original_sizes = boundary.write_json, evidence.raw_output_sizes

        def write(path, value):
            if Path(path).name == label + "-start.json" and where == "start":
                raise failure
            if receipts_fail and Path(path).name == label + "-failure.json":
                raise OSError("fictional failure sink unavailable")
            return original_write(path, value)

        def sizes(directory, name):
            nonlocal seen
            if where == "sizes" and not seen:
                seen = True
                raise failure
            return original_sizes(directory, name)

        with ExitStack() as stack:
            stack.enter_context(
                patch.object(evidence.subprocess, "Popen", return_value=OriginalHandle())
            )
            stack.enter_context(
                patch.object(
                    evidence.os,
                    "killpg",
                    side_effect=lambda *_args: calls.append(("group-kill",)),
                    create=True,
                )
            )
            stack.enter_context(patch.object(boundary, "write_json", side_effect=write))
            stack.enter_context(patch.object(evidence, "raw_output_sizes", side_effect=sizes))
            with self.assertRaises(type(failure)) as caught:
                evidence.run_child(
                    ["inert-next-never-executed"], self.frontend, {}, self.parent, label, 300
                )
        self.assertIs(caught.exception, failure)
        self.assertEqual([row for row in calls if row[0] == "wait"], [("wait", 3)])
        self.assertFalse((self.parent / (label + "-terminal.json")).exists())
        path = self.parent / (label + "-failure.json")
        return calls, boundary.load_json(path) if path.exists() else None

    def test_start_receipt_oserror_keeps_original_cleanup_and_wait(self):
        calls, record = self.collector_failure_fixture(OSError("fictional start write failed"))
        self.assertTrue(calls)
        self.assertEqual(record["directReturnCode"], 77)
        self.assertEqual(record["rawOutputBytes"], {"stdout": 0, "stderr": 0})
        self.assertTrue(record["cleanup"]["actualDirectWaitObserved"])
        self.assertFalse(record["certificate"])

    def test_live_raw_metadata_oserror_cannot_skip_original_wait(self):
        _, record = self.collector_failure_fixture(
            OSError("fictional metadata unavailable"), "sizes"
        )
        self.assertEqual(record["processGroupCleanup"], "unknown")
        self.assertFalse(record["certificate"])

    def test_keyboard_interrupt_propagates_after_original_cleanup(self):
        _, record = self.collector_failure_fixture(KeyboardInterrupt(), "poll")
        self.assertEqual(record["reason"], "supervisor_keyboard_interrupt")
        self.assertFalse(record["certificate"])

    def test_private_sigterm_exception_propagates_after_original_cleanup(self):
        _, record = self.collector_failure_fixture(evidence.SupervisorTerminated(), "poll")
        self.assertEqual(record["reason"], "supervisor_sigterm")
        self.assertFalse(record["certificate"])

    def test_system_exit_and_unknown_exception_keep_original_semantics_after_cleanup(self):
        for failure in (SystemExit(17), RuntimeError("fictional unknown error")):
            with self.subTest(kind=type(failure).__name__):
                _, record = self.collector_failure_fixture(failure)
                self.assertFalse(record["certificate"])

    def test_failed_failure_receipt_does_not_suppress_owned_cleanup(self):
        calls, record = self.collector_failure_fixture(
            OSError("fictional start write failed"), receipts_fail=True
        )
        self.assertIsNone(record)
        self.assertEqual([row for row in calls if row[0] == "wait"], [("wait", 3)])

    def test_poll_and_kill_errors_still_attempt_original_bounded_wait(self):
        calls = []

        class OriginalHandle:
            pid = 12345

            def poll(self):
                raise ValueError("fictional poll error")

            def kill(self):
                raise OSError("fictional kill error")

            def wait(self, timeout):
                calls.append(timeout)
                return 55

        with patch.object(
            evidence.os, "killpg", side_effect=OSError("fictional group kill error"), create=True
        ):
            attempted, code, facts = evidence.cleanup_original_child(OriginalHandle(), False, None)
        self.assertEqual(calls, [3])
        self.assertTrue(attempted and facts["pollError"] and facts["killError"])
        self.assertTrue(facts["actualDirectWaitObserved"])
        self.assertEqual(code, 55)
        self.assertEqual(facts["processGroupCleanup"], "unknown")

    def test_entrypoint_local_sigterm_raiser_restores_previous_handler(self):
        previous, changes = object(), []

        def installed(number, handler):
            changes.append((number, handler))

        def main():
            changes[0][1](evidence.signal.SIGTERM, None)

        with (
            patch.object(evidence.signal, "getsignal", return_value=previous),
            patch.object(evidence.signal, "signal", side_effect=installed),
            patch.object(evidence.subprocess, "Popen") as spawn,
        ):
            with self.assertRaises(SystemExit) as caught:
                evidence.supervised_entrypoint(main)
            spawn.assert_not_called()
        self.assertEqual(caught.exception.code, 143)
        self.assertEqual(changes[-1], (evidence.signal.SIGTERM, previous))

    def test_entrypoint_restores_handler_for_keyboard_system_exit_and_unknown_error(self):
        previous = object()
        for failure, expected in (
            (KeyboardInterrupt(), 130),
            (SystemExit(19), 19),
            (RuntimeError("fictional unknown entry error"), None),
        ):
            with self.subTest(kind=type(failure).__name__):

                def main():
                    raise failure

                with (
                    patch.object(evidence.signal, "getsignal", return_value=previous),
                    patch.object(evidence.signal, "signal") as changed,
                ):
                    with self.assertRaises(
                        SystemExit if expected is not None else RuntimeError
                    ) as caught:
                        evidence.supervised_entrypoint(main)
                self.assertEqual(
                    changed.call_args_list[-1].args, (evidence.signal.SIGTERM, previous)
                )
                if expected is not None:
                    self.assertEqual(caught.exception.code, expected)
                else:
                    self.assertIs(caught.exception, failure)

    def test_non_main_entrypoint_rejects_before_signal_change_or_callback(self):
        main = Mock()
        with (
            patch.object(evidence.threading, "current_thread", return_value=object()),
            patch.object(evidence.signal, "getsignal") as previous,
            patch.object(evidence.signal, "signal") as changed,
        ):
            with self.assertRaises(boundary.BoundaryError):
                evidence.supervised_entrypoint(main)
            main.assert_not_called()
            previous.assert_not_called()
            changed.assert_not_called()

    def collector_cleanup_interrupt_fixture(self, where, keyboard=False, later_interrupts=False):
        # An ordinary post-spawn failure precedes the FIRST interruption.
        # Only fake handles and a directly invoked mocked local handler are used.
        calls, changes, requested, observed = [], [], [], []
        ordinary_failure_seen = False
        previous = object()
        label = "interrupt-" + str(len(list(self.parent.glob("interrupt-*.stdout"))))
        original_write = boundary.write_json

        def interrupt_at(operation):
            if operation != where and not (later_interrupts and operation in ("kill", "wait")):
                return
            self.assertTrue(ordinary_failure_seen)
            calls.append(("interrupt", operation))
            if operation != where or keyboard:
                interrupt = KeyboardInterrupt()
                requested.append(interrupt)
                raise interrupt
            try:
                changes[0][1](evidence.signal.SIGTERM, None)
            except evidence.SupervisorTerminated as interrupt:
                requested.append(interrupt)
                raise

        class OriginalHandle:
            pid = 12345

            def poll(self):
                calls.append(("poll", self))
                interrupt_at("poll")
                return None

            def wait(self, timeout):
                calls.append(("wait", self, timeout))
                interrupt_at("wait")
                return 77

            def kill(self):
                calls.append(("kill", self))
                interrupt_at("kill")

        handle = OriginalHandle()

        def spawn(*_args, **kwargs):
            kwargs["stdout"].write(b"owned partial stdout")
            kwargs["stderr"].write(b"owned partial stderr")
            return handle

        def kill_group(pid, _signal):
            self.assertEqual(pid, handle.pid)
            calls.append(("group-kill", handle))
            interrupt_at("kill")

        def write(path, value):
            nonlocal ordinary_failure_seen
            if Path(path).name == label + "-start.json":
                ordinary_failure_seen = True
                calls.append(("ordinary-start-write-error",))
                raise OSError("fictional start receipt failure before interruption")
            if Path(path).name == label + "-failure.json":
                interrupt_at("receipt")
            return original_write(path, value)

        original_sizes = evidence.raw_output_sizes

        def sizes(directory, name):
            interrupt_at("sizes")
            return original_sizes(directory, name)

        def main():
            try:
                evidence.run_child(
                    ["inert-next-never-executed"], self.frontend, {}, self.parent, label, 300
                )
            except (KeyboardInterrupt, evidence.SupervisorTerminated) as interrupt:
                observed.append(interrupt)
                raise

        with ExitStack() as stack:
            stack.enter_context(patch.object(evidence.signal, "getsignal", return_value=previous))
            stack.enter_context(
                patch.object(
                    evidence.signal,
                    "signal",
                    side_effect=lambda number, handler: changes.append((number, handler)),
                )
            )
            spawned = stack.enter_context(
                patch.object(evidence.subprocess, "Popen", side_effect=spawn)
            )
            stack.enter_context(
                patch.object(evidence.os, "killpg", side_effect=kill_group, create=True)
            )
            stack.enter_context(patch.object(boundary, "write_json", side_effect=write))
            stack.enter_context(patch.object(evidence, "raw_output_sizes", side_effect=sizes))
            with self.assertRaises(SystemExit) as caught:
                evidence.supervised_entrypoint(main)
            spawned.assert_called_once()
        self.assertEqual(caught.exception.code, 130 if keyboard else 143)
        self.assertEqual(changes[-1], (evidence.signal.SIGTERM, previous))
        self.assertIs(observed[0], requested[0])
        self.assertEqual([row for row in calls if row[0] == "wait"], [("wait", handle, 3)])
        self.assertEqual(calls[0], ("ordinary-start-write-error",))
        self.assertEqual((self.parent / (label + ".stdout")).read_bytes(), b"owned partial stdout")
        self.assertEqual((self.parent / (label + ".stderr")).read_bytes(), b"owned partial stderr")
        # An interrupted wait or failure diagnostic may leave no receipt.
        self.assertFalse((self.parent / (label + "-terminal.json")).exists())
        self.assertFalse((self.parent / (label + "-failure.json")).exists())

    def test_first_sigterm_in_failure_cleanup_poll_waits_original_once_and_exits_143(self):
        self.collector_cleanup_interrupt_fixture("poll")

    def test_first_sigterm_in_failure_cleanup_kill_waits_original_once_and_exits_143(self):
        self.collector_cleanup_interrupt_fixture("kill")

    def test_first_sigterm_in_failure_cleanup_wait_is_not_retried_or_certified(self):
        self.collector_cleanup_interrupt_fixture("wait")

    def test_first_sigterm_in_failure_size_observation_is_not_swallowed(self):
        self.collector_cleanup_interrupt_fixture("sizes")

    def test_first_sigterm_in_failure_receipt_write_is_not_swallowed(self):
        self.collector_cleanup_interrupt_fixture("receipt")

    def test_first_keyboard_interrupt_in_failure_cleanup_or_diagnostics_exits_130(self):
        for where in ("poll", "kill", "wait", "sizes", "receipt"):
            with self.subTest(where=where):
                self.collector_cleanup_interrupt_fixture(where, keyboard=True)

    def test_first_cleanup_sigterm_identity_survives_later_kill_and_wait_interruptions(self):
        self.collector_cleanup_interrupt_fixture("poll", later_interrupts=True)

    def metadata_frontend_fixture(self, mode="normal", wrong_start_directory=False):
        # Real collector, run_child, closure, snapshots and proof loader; only
        # backend lookup and the retained original subprocess handles are inert.
        node = self.root / "inert-node-file"
        node.write_bytes(b"owned inert node file, never executed")
        adapter = self.root / "scripts/desktop_frontend_evidence.mjs"
        adapter.parent.mkdir(exist_ok=True)
        adapter.write_bytes(b"owned inert scanner file, never executed")
        registry = self.private_registry() if mode == "acceptance" else copy.deepcopy(self.registry)
        backend = {
            "nextVersion": evidence.NEXT_VERSION,
            "webpackVersion": evidence.WEBPACK_VERSION,
            "backend": "webpack",
            "buildWorker": False,
            "node": {"path": str(node), **boundary.hash_file(node)},
            "files": boundary.inventory(self.frontend, ["next.config.mjs"]),
        }
        waits, producer_directories = [], []
        test = self
        original_write = boundary.write_json

        def write(path, document):
            if wrong_start_directory and Path(path).name == "next-start.json":
                document = copy.deepcopy(document)
                document["environment"][evidence.METADATA] = str(test.parent)
            return original_write(path, document)

        def spawn(argv, **kwargs):
            next_process = argv[-1] == "build"
            records = Path(kwargs["stdout"].name).parent

            class OriginalHandle:
                pid = 123 if next_process else 124
                observed = False

                def poll(self):
                    if self.observed:
                        return 0
                    self.observed = True
                    if next_process:
                        compiler = Path(kwargs["env"][evidence.METADATA])
                        # Consumer contract: Next requires this directory empty
                        # even though actual parent run receipts already exist.
                        test.assertEqual(compiler.parent, records)
                        test.assertEqual(compiler.name, "compiler")
                        test.assertEqual(compiler.stat().st_mode & 0o777, 0o700)
                        test.assertEqual(list(compiler.iterdir()), [])
                        for name in (
                            "input-bytes",
                            "frontend-input-inventory.json",
                            "next-start.json",
                            "next.stdout",
                            "next.stderr",
                        ):
                            test.assertTrue((records / name).exists(), name)
                        start = boundary.load_json(records / "next-start.json")
                        test.assertEqual(
                            start["environment"][evidence.METADATA],
                            str(test.parent if wrong_start_directory else compiler),
                        )
                        producer_directories.append(compiler)
                        boundary.write_json(compiler / "compiler-records.json", registry)
                        output = test.frontend / "out"
                        output.mkdir(exist_ok=True)
                        (output / "owned.js").write_bytes(b"owned inert exported bytes")
                    else:
                        test.assertNotIn(evidence.METADATA, kwargs["env"])
                        request = boundary.load_json(argv[-2])
                        rows = [
                            {
                                **row,
                                "privateMarkerHits": [evidence.MARKER]
                                if mode == "acceptance"
                                else [],
                            }
                            for row in request["inventory"]
                        ]
                        boundary.write_json(
                            argv[-1],
                            {
                                "schema": "evidenceloom-desktop-frontend-export-scan-v1",
                                "selection": mode,
                                "inventorySha256": request["expectedInventorySha256"],
                                "rows": rows,
                            },
                        )
                    return 0

                def wait(self, timeout):
                    waits.append((self.pid, timeout))
                    return 0

            return OriginalHandle()

        with (
            patch.object(evidence.shutil, "which", return_value=str(node)),
            patch.object(evidence, "backend_binding", return_value=backend),
            patch.object(evidence.subprocess, "Popen", side_effect=spawn),
            patch.object(boundary, "write_json", side_effect=write),
        ):
            proof_path = evidence.run_frontend(
                self.frontend, self.parent, mode, {"PATH": "inert owned path"}
            )
            if not wrong_start_directory:
                evidence.verify_frontend_proof(proof_path, mode)
                if mode == "acceptance":
                    boundary.write_json(
                        self.frontend / "out/desktop-acceptance-build.json", {"buildId": "a" * 64}
                    )
                    proof_path = evidence.reseal_acceptance(proof_path)
                    evidence.verify_frontend_proof(proof_path, mode)
        expected_waits = [(123, 0), (124, 0)] + ([(124, 0)] if mode == "acceptance" else [])
        self.assertEqual(waits, expected_waits)
        self.assertEqual(len(producer_directories), 1)
        return proof_path, producer_directories[0]

    def test_normal_and_acceptance_next_consume_empty_compiler_directory_with_parent_receipts(self):
        for mode in ("normal", "acceptance"):
            with self.subTest(mode=mode):
                proof_path, compiler = self.metadata_frontend_fixture(mode)
                proof = evidence.load_closed_proof(proof_path)
                self.assertEqual(proof["rawRegistryFile"], str(compiler / "compiler-records.json"))
                self.assertEqual(proof["compilerMetadata"]["path"], str(compiler))
                self.assertEqual(
                    (compiler / "compiler-records.json").read_bytes(),
                    (
                        proof_path.parent / "compiler-proof-bytes/compiler/compiler-records.json"
                    ).read_bytes(),
                )
                self.assertFalse((proof_path.parent / "compiler-records.json").exists())

    def test_closed_proof_rejects_original_registry_byte_mutation_and_same_path_directory_replacement(
        self,
    ):
        for mutation in ("original-registry-bytes", "same-path-directory"):
            with self.subTest(mutation=mutation):
                proof_path, compiler = self.metadata_frontend_fixture()
                registry = compiler / "compiler-records.json"
                original = registry.read_bytes()
                if mutation == "original-registry-bytes":
                    registry.write_bytes(original + b"\n")
                    self.assertEqual(
                        boundary.load_json(registry),
                        boundary.load_json(
                            proof_path.parent
                            / "compiler-proof-bytes/compiler/compiler-records.json"
                        ),
                    )
                else:
                    compiler.rename(proof_path.parent / "previous-compiler")
                    compiler.mkdir(mode=0o700)
                    registry.write_bytes(original)
                    self.assertEqual(
                        registry.read_bytes(),
                        (
                            proof_path.parent
                            / "compiler-proof-bytes/compiler/compiler-records.json"
                        ).read_bytes(),
                    )
                with self.assertRaises(boundary.BoundaryError):
                    evidence.load_closed_proof(proof_path)

    def test_closed_proof_rejects_original_start_environment_pointing_to_receipt_parent(self):
        proof_path, compiler = self.metadata_frontend_fixture(wrong_start_directory=True)
        self.assertEqual(
            boundary.load_json(proof_path.parent / "next-start.json")["environment"][
                evidence.METADATA
            ],
            str(self.parent),
        )
        self.assertEqual(
            (compiler / "compiler-records.json").read_bytes(),
            (
                proof_path.parent / "compiler-proof-bytes/compiler/compiler-records.json"
            ).read_bytes(),
        )
        with self.assertRaises(boundary.BoundaryError):
            evidence.load_closed_proof(proof_path)

    def direct_client_registry(self, mode="normal"):
        registry = self.private_registry() if mode == "acceptance" else copy.deepcopy(self.registry)
        registry["records"][0]["replacements"] = []
        edge = registry["records"][2]
        edge["replacements"], edge["resolutions"], edge["moduleRows"] = [], [], []
        return registry

    def test_direct_physical_client_with_server_neutral_replacement_is_valid_in_both_modes(self):
        for mode in ("normal", "acceptance"):
            with self.subTest(mode=mode):
                registry = self.direct_client_registry(mode)
                records = evidence.validate_registry(
                    registry, self.frontend, mode, 123, {"nextVersion": evidence.NEXT_VERSION}
                )
                self.assertEqual(len(records), 3)
                self.assertEqual(records[0]["replacements"], [])
                self.assertEqual(len(records[0]["resolutions"]), 1)
                self.assertEqual(len(records[1]["replacements"]), 1)

    def test_whole_build_without_any_neutral_replacement_is_rejected(self):
        for mode in ("normal", "acceptance"):
            with self.subTest(mode=mode):
                registry = self.direct_client_registry(mode)
                for record in registry["records"]:
                    record["replacements"] = []
                with self.assertRaises(boundary.BoundaryError):
                    evidence.validate_registry(
                        registry, self.frontend, mode, 123, {"nextVersion": evidence.NEXT_VERSION}
                    )

    def test_whole_build_replacement_rows_require_exact_selected_source_and_schema(self):
        for change in ("specifier", "path", "hash", "extra", "missing", "non_list", "bound"):
            with self.subTest(change=change):
                registry = self.direct_client_registry()
                record = registry["records"][1]
                row = record["replacements"][0]
                if change == "specifier":
                    row["originalSpecifier"] = "@unreviewed-entry"
                elif change == "path":
                    row["sourcePath"] = "tsconfig.json"
                elif change == "hash":
                    row["sourceSha256"] = "0" * 64
                elif change == "extra":
                    row["fabricatedOwner"] = 123
                elif change == "missing":
                    del row["sourceSha256"]
                elif change == "non_list":
                    record["replacements"] = {"row": row}
                else:
                    record["replacements"] = [copy.deepcopy(row) for _ in range(257)]
                with self.assertRaises(boundary.BoundaryError):
                    self.validate(registry)

    def test_direct_client_resolution_rows_require_exact_physical_source_and_resource_hash(self):
        for change in (
            "absent",
            "path",
            "hash",
            "resource_type",
            "resource_hash",
            "extra",
            "bound",
        ):
            with self.subTest(change=change):
                registry = self.direct_client_registry()
                record = registry["records"][0]
                row = record["resolutions"][0]
                if change == "absent":
                    record["resolutions"] = []
                elif change == "path":
                    row["sourcePath"] = "tsconfig.json"
                elif change == "hash":
                    row["sourceSha256"] = "0" * 64
                elif change == "resource_type":
                    row["resourceSha256"] = True
                elif change == "resource_hash":
                    row["resourceSha256"] = "not-a-sha256"
                elif change == "extra":
                    row["originalSpecifier"] = "@desktop-verification-entry"
                else:
                    record["resolutions"] = [copy.deepcopy(row) for _ in range(257)]
                with self.assertRaises(boundary.BoundaryError):
                    self.validate(registry)

    def test_direct_client_keeps_original_owner_and_both_physical_module_phases_required(self):
        for change in ("owner_pid", "worker", "closed", "missing_phase", "identifier_only"):
            with self.subTest(change=change):
                registry = self.direct_client_registry()
                if change == "owner_pid":
                    registry["compilerOwner"]["pid"] = 999
                elif change == "worker":
                    registry["compilerOwner"]["buildWorker"] = True
                elif change == "closed":
                    registry["registryClosed"] = True
                elif change == "missing_phase":
                    registry["records"][0]["moduleRows"] = [
                        row
                        for row in registry["records"][0]["moduleRows"]
                        if row["phase"] == "finishModules"
                    ]
                else:
                    for row in registry["records"][0]["moduleRows"]:
                        row["kind"] = "identifier-reference"
                with self.assertRaises(boundary.BoundaryError):
                    self.validate(registry)

    def test_private_direct_client_still_requires_consumed_handshake_marker(self):
        registry = self.direct_client_registry("acceptance")
        registry["records"][0]["assets"]["rows"][0]["privateMarkerHits"] = []
        with self.assertRaises(boundary.BoundaryError):
            evidence.validate_registry(
                registry, self.frontend, "acceptance", 123, {"nextVersion": evidence.NEXT_VERSION}
            )


if __name__ == "__main__":
    unittest.main()
