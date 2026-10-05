"""Pure owned-file proof tests; all normal build/probe subprocesses are mocked."""

from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import check_desktop_acceptance_boundary as boundary  # noqa: E402
import build_desktop_acceptance as acceptance_builder  # noqa: E402
import sidecar_architecture as architecture  # noqa: E402


class DesktopBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="desktop-boundary-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.target = boundary.ACCEPTANCE_TARGETS[0]
        self.commit = "1" * 40
        config = {
            "identifier": "io.github.simonguo.evidenceloom",
            "build": {"frontendDist": "../frontend/out"},
            "bundle": {"externalBin": ["binaries/evidenceloom-runner"]},
        }
        for name, value in [
            ("src-tauri/tauri.conf.json", config),
            ("frontend/package-lock.json", {"lockfileVersion": 3}),
        ]:
            boundary.write_json(self.repo / name, value)
        for name, data in {
            "src-tauri/Cargo.lock": b"locked",
            "scripts/build_tauri_sidecar.sh": b"normal build",
            "scripts/sidecar_probe.py": b"normal bounded probe",
            "frontend/server/evidenceloom-runner.spec": b"normal spec",
            "src-tauri/capabilities/default.json": b"{}",
            "frontend/out/index.html": b"real saved frontend",
            "frontend/out/empty.css": b"",
            "tradingagents/dataflows/__init__.py": b"",
            "docs/contracts/shared-policy.json": b'{"schemaVersion":1}',
            "tests/fixtures/shared-fixture.json": b'{"fictional":true}',
            "LICENSE": b"license",
            "NOTICE": b"notice",
            "THIRD_PARTY_NOTICES.md": b"notices",
        }.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        self.binary = self.repo / f"src-tauri/binaries/evidenceloom-runner-{self.target}"
        self.binary.parent.mkdir()
        self.binary.write_bytes(b"owned simulated normal runner")
        self.sidecar_path = self.root / "sidecar-input.json"
        source = boundary.source_binding(self.repo)
        self.completion = {
            "buildExitCode": 0,
            "probeExitCode": 0,
            "sourceBeforeSha256": source,
            "sourceAfterSha256": source,
        }
        boundary.write_json(
            self.sidecar_path,
            boundary.sidecar_proof(
                self.repo, self.target, self.binary, self.commit, self.completion
            ),
        )
        self.typed = self.root / "typed-config.json"
        boundary.write_json(self.typed, config)

    def app_stage(self):
        directory = self.root / "app-stage"
        stamp = boundary.prepare_shipping(
            self.repo,
            directory,
            self.target,
            self.commit,
            self.binary,
            self.sidecar_path,
            {},
            self.typed,
        )
        executable = self.root / "evidenceloom-desktop"
        executable.write_bytes(b"unit fixture, never executable\n" + boundary.canonical(stamp))
        boundary.seal_build(directory, executable)
        return directory

    def package(self, directory, name="Evidence-Loom-arm64.dmg"):
        artifact = self.root / name
        artifact.write_bytes(b"controlled package bytes, no executable")
        proof = self.root / (name + ".proof.json")
        boundary.seal_package(directory / "build-proof.json", artifact, proof, "normal")
        return artifact, proof

    def test_empty_source_and_frontend_files_bind_but_empty_executable_rejects(self):
        source = boundary.inventory(self.repo, boundary.source_names(self.repo))
        self.assertIn(
            {
                "path": "tradingagents/dataflows/__init__.py",
                "bytes": 0,
                "sha256": boundary.digest(b""),
            },
            source,
        )
        self.app_stage()
        self.binary.write_bytes(b"")
        with self.assertRaises(boundary.BoundaryError):
            boundary.hash_file(self.binary)

    def test_typed_sdk_config_digest_uses_actual_bytes_not_python_float_reencoding(self):
        data = boundary.canonical(boundary.load_json(self.typed)).rstrip(b"\n")
        self.typed.write_bytes(data[:-1] + b',"app":{"windows":[{"width":1e-5}]}}\n')
        self.assertNotEqual(
            self.typed.read_bytes(), boundary.canonical(boundary.load_json(self.typed))
        )
        directory = self.app_stage()
        self.assertEqual(
            boundary.load_json(directory / "desktop-build-stamp.json")["effectiveConfigSha256"],
            boundary.hash_file(self.typed)["sha256"],
        )

    def test_dependency_copy_preserves_inward_cli_and_directory_links(self):
        source = self.root / "dependencies"
        (source / ".bin").mkdir(parents=True)
        (source / "pkg/bin").mkdir(parents=True)
        cli_bytes = b"inert CLI whose relative module is ../module.txt"
        (source / "pkg/bin/cli").write_bytes(cli_bytes)
        (source / "pkg/module.txt").write_bytes(b"inert relative module")
        try:
            (source / ".bin/cli").symlink_to("../pkg/bin/cli")
            (source / "alias-pkg").symlink_to("pkg", target_is_directory=True)
        except OSError:
            self.skipTest("Symbolic link creation is unavailable.")
        flattened = self.root / "old-flattened-dependencies"
        acceptance_builder.shutil.copytree(source, flattened, symlinks=False)
        old_cli = flattened / ".bin/cli"
        self.assertFalse(old_cli.is_symlink())
        self.assertFalse((old_cli.parent / "../module.txt").exists())
        destination = self.root / "copied-dependencies"
        acceptance_builder.copy_frontend_dependencies(source, destination)
        copied = destination / ".bin/cli"
        self.assertTrue(copied.is_symlink())
        self.assertEqual(os.readlink(copied), "../pkg/bin/cli")
        self.assertEqual(copied.resolve(), destination / "pkg/bin/cli")
        self.assertEqual(copied.read_bytes(), cli_bytes)
        self.assertEqual(
            (copied.resolve().parent / "../module.txt").read_bytes(), b"inert relative module"
        )
        self.assertTrue((destination / "alias-pkg").is_symlink())
        self.assertEqual(os.readlink(destination / "alias-pkg"), "pkg")
        self.assertEqual(os.readlink(source / ".bin/cli"), "../pkg/bin/cli")
        self.assertEqual((source / "pkg/bin/cli").read_bytes(), cli_bytes)

    def test_native_source_copy_preserves_identity_modes_and_relative_includes(self):
        source = self.repo / "src-tauri/src/inert.rs"
        source.parent.mkdir(parents=True)
        source.write_bytes(b'include_str!("../static/input.txt");')
        resource = self.repo / "src-tauri/static/input.txt"
        resource.parent.mkdir()
        resource.write_bytes(b"inert relative source input")
        source.chmod(0o6755)
        schemas = self.repo / "src-tauri/gen/schemas"
        schemas.mkdir(parents=True)
        (schemas / "original.json").write_bytes(b"original SDK output")
        (self.repo / ".git").mkdir()
        (self.repo / ".git/inert-metadata").write_bytes(b"original repository metadata")
        original = acceptance_builder.native_source_inventory(self.repo)
        copied = self.root / "native-source"
        records = acceptance_builder.copy_native_source(self.repo, copied)
        self.assertEqual(records, original)
        self.assertEqual(acceptance_builder.native_source_inventory(copied), original)
        self.assertFalse((copied / ".git").exists())
        self.assertFalse((copied / "src-tauri/binaries").exists())
        self.assertFalse((copied / "src-tauri/gen").exists())
        self.assertEqual(
            stat.S_IMODE((copied / "src-tauri/src/inert.rs").stat().st_mode),
            stat.S_IMODE(source.stat().st_mode) & 0o777,
        )
        self.assertEqual(
            (copied / "src-tauri/src/../static/input.txt").read_bytes(), resource.read_bytes()
        )
        generated = copied / "src-tauri/gen/schemas"
        generated.mkdir(parents=True)
        (generated / "original.json").write_bytes(b"simulated acceptance SDK schema")
        acceptance_builder.verify_native_source(self.repo, copied, records)
        self.assertEqual((schemas / "original.json").read_bytes(), b"original SDK output")
        self.assertEqual(
            (self.repo / ".git/inert-metadata").read_bytes(), b"original repository metadata"
        )

    def test_native_source_copy_binds_cache_named_data_in_both_shared_trees(self):
        components = (
            "gen",
            "binaries",
            "node_modules",
            "target",
            "out",
            ".next",
            ".venv",
            "__pycache__",
        )
        shared = []
        for prefix in boundary.SHARED_FRONTEND_PREFIXES:
            for component in components:
                name = f"{prefix}/{component}/data.json"
                path = self.repo / name
                path.parent.mkdir(parents=True)
                path.write_bytes(boundary.canonical({"sourceData": name}))
                shared.append(name)
        original = acceptance_builder.native_source_inventory(self.repo)
        self.assertEqual(original, boundary.inventory(self.repo, boundary.source_names(self.repo)))
        by_name = {record["path"]: record for record in original}
        self.assertTrue(all(name in by_name for name in shared))
        copied = self.root / "native-source"
        self.assertEqual(acceptance_builder.copy_native_source(self.repo, copied), original)
        for name in shared:
            self.assertEqual((copied / name).read_bytes(), (self.repo / name).read_bytes())
        self.assertEqual(boundary.source_binding(copied), boundary.source_binding(self.repo))
        for name in (shared[0], shared[len(components)]):
            selected = copied / name
            original_bytes = selected.read_bytes()
            selected.write_bytes(b'{"sourceData":"changed shared input"}')
            self.assertNotEqual(boundary.source_binding(copied), boundary.source_binding(self.repo))
            with self.assertRaises(boundary.BoundaryError):
                acceptance_builder.verify_native_source(self.repo, copied, original)
            selected.write_bytes(original_bytes)
        acceptance_builder.verify_native_source(self.repo, copied, original)
        self.assertFalse((copied / "src-tauri/gen").exists())
        self.assertFalse((copied / "src-tauri/binaries").exists())
        self.assertFalse((copied / ".git").exists())

    def test_native_source_copy_detects_input_names_bytes_and_copy_tampering(self):
        copied = self.root / "native-source"
        records = acceptance_builder.copy_native_source(self.repo, copied)
        selected = copied / "NOTICE"
        original = selected.read_bytes()
        selected.write_bytes(b"changed clone input")
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.verify_native_source(self.repo, copied, records)
        selected.write_bytes(original)
        extra = copied / "scripts/unexpected.py"
        extra.write_bytes(b"unexpected source input")
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.verify_native_source(self.repo, copied, records)
        extra.unlink()
        (self.repo / "NOTICE").write_bytes(b"changed original input")
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.verify_native_source(self.repo, copied, records)
        (self.repo / "NOTICE").write_bytes(original)
        actual_copy = acceptance_builder.shutil.copyfile

        def corrupt_copy(source, destination):
            actual_copy(source, destination)
            if Path(destination).name == "NOTICE":
                Path(destination).write_bytes(b"changed during copy")

        with patch.object(acceptance_builder.shutil, "copyfile", side_effect=corrupt_copy):
            with self.assertRaises(boundary.BoundaryError):
                acceptance_builder.copy_native_source(self.repo, self.root / "tampered-copy")
        self.assertEqual(acceptance_builder.native_source_inventory(self.repo), records)

    def test_native_source_copy_rejects_reuse_parent_links_and_private_env_input(self):
        existing = self.root / "existing-copy"
        existing.mkdir()
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.copy_native_source(self.repo, existing)
        self.assertEqual(list(existing.iterdir()), [])
        outside = self.root / "owned-inert-outside"
        outside.mkdir()
        parent = self.root / "linked-copy-parent"
        try:
            parent.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("Symbolic link creation is unavailable.")
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.copy_native_source(self.repo, parent / "native-source")
        self.assertEqual(list(outside.iterdir()), [])
        private = self.repo / "frontend/.env"
        private.write_bytes(b"inert excluded environment fixture")
        with patch.object(boundary, "hash_file") as hash_file:
            with self.assertRaises(boundary.BoundaryError):
                acceptance_builder.copy_native_source(self.repo, self.root / "private-copy")
            hash_file.assert_not_called()
        self.assertFalse((self.root / "private-copy").exists())

    def pipeline_args(self, name):
        dependencies = self.root / (name + "-dependencies")
        dependencies.mkdir()
        return SimpleNamespace(
            repo=str(self.repo),
            work_root=str(self.root / name),
            target=self.target,
            base_commit=self.commit,
            cargo_home=str(self.root),
            rustup_home=str(self.root),
            frontend_dependencies=str(dependencies),
            tool_path="owned-tool-path",
        )

    def test_pipeline_routes_all_cargo_to_copy_and_isolates_simulated_sdk_writes(self):
        boundary.write_json(
            self.repo / "src-tauri/acceptance/tauri.conf.json",
            {"build": {}, "bundle": {"externalBin": [], "resources": []}},
        )
        boundary.write_json(
            self.repo / "src-tauri/acceptance/capability.json",
            {"identifier": "acceptance-main", "windows": ["main"], "permissions": []},
        )
        permissions = self.repo / "src-tauri/acceptance/permissions/default.toml"
        permissions.parent.mkdir()
        permissions.write_bytes(b"[default]\npermissions = []\n")
        original_schema = self.repo / "src-tauri/gen/schemas/capabilities.json"
        original_schema.parent.mkdir(parents=True)
        original_schema.write_bytes(b"original SDK schema")
        args = self.pipeline_args("owned-pipeline")
        work = Path(args.work_root)
        owned_source = work / "native-source"
        calls = []

        def cargo(repo, target, environment, binary, command="check", stamp=None):
            self.assertEqual(repo, owned_source)
            calls.append((command, binary))
            generated = repo / "src-tauri/gen/schemas/capabilities.json"
            generated.parent.mkdir(parents=True, exist_ok=True)
            generated.write_bytes(b"simulated SDK write in compiler cwd")
            output = work / "target/build/out"
            output.mkdir(parents=True, exist_ok=True)
            (output / "desktop-effective-config.json").write_bytes(
                boundary.canonical(
                    boundary.effective_config(repo, target, json.loads(environment["TAURI_CONFIG"]))
                )
            )
            if command == "build":
                executable = work / f"target/{target}/release/{binary}"
                executable.parent.mkdir(parents=True, exist_ok=True)
                executable.write_bytes(
                    b"inert simulated compiler output\n" + Path(stamp).read_bytes()
                )
            return output

        def frontend(*_args, **kwargs):
            self.assertEqual(kwargs["cwd"], work / "frontend")
            output = kwargs["cwd"] / "out"
            output.mkdir()
            (output / "index.html").write_bytes(b"inert simulated frontend export")

        with (
            patch.dict(os.environ, {}, clear=True),
            patch.object(acceptance_builder, "cargo_metadata", side_effect=cargo),
            patch.object(acceptance_builder.shutil, "which", return_value="owned-mocked-npm"),
            patch.object(acceptance_builder.subprocess, "run", side_effect=frontend) as run,
        ):
            app = acceptance_builder.pipeline(args)
        self.assertTrue(app.is_dir())
        self.assertEqual(run.call_count, 1)
        self.assertEqual(
            calls,
            [
                ("check", "evidenceloom-desktop-fixture"),
                ("build", "evidenceloom-desktop-fixture"),
                ("check", "evidenceloom-desktop-fixture"),
                ("build", "evidenceloom-desktop"),
            ],
        )
        self.assertEqual(original_schema.read_bytes(), b"original SDK schema")
        self.assertEqual(
            boundary.load_json(work / "native-source-validation.json")[
                "originalAndCopiedInputsUnchanged"
            ],
            True,
        )
        self.assertEqual(
            acceptance_builder.native_source_inventory(self.repo),
            acceptance_builder.native_source_inventory(owned_source),
        )

    def test_cargo_metadata_manifest_and_cwd_both_use_owned_copy(self):
        copied = self.root / "native-source"
        acceptance_builder.copy_native_source(self.repo, copied)
        target = self.root / "owned-target"
        output = target / "build/out"
        output.mkdir(parents=True)
        result = SimpleNamespace(
            stdout=json.dumps(
                {
                    "reason": "build-script-executed",
                    "package_id": "evidenceloom-desktop",
                    "out_dir": str(output),
                }
            )
            + "\n"
        )
        with (
            patch.object(acceptance_builder.shutil, "which", return_value="owned-mocked-cargo"),
            patch.object(acceptance_builder.subprocess, "run", return_value=result) as run,
        ):
            acceptance_builder.cargo_metadata(
                copied,
                self.target,
                {"PATH": "owned-tool-path", "CARGO_TARGET_DIR": str(target)},
                "evidenceloom-desktop-fixture",
            )
        self.assertEqual(run.call_args.kwargs["cwd"], copied)
        argv = run.call_args.args[0]
        self.assertEqual(
            argv[argv.index("--manifest-path") + 1], str(copied / "src-tauri/Cargo.toml")
        )
        self.assertIn("--locked", argv)
        self.assertIn("--offline", argv)

    def test_pipeline_checks_source_identity_after_tool_failure(self):
        for tampered in (False, True):
            with self.subTest(tampered=tampered):
                args = self.pipeline_args("failed-pipeline-" + str(tampered))
                work = Path(args.work_root)

                def fail(source, *_args):
                    if tampered:
                        (source / "NOTICE").write_bytes(b"changed clone during failed tool")
                    raise boundary.subprocess.CalledProcessError(1, "inert mocked tool failure")

                error = (
                    boundary.BoundaryError if tampered else boundary.subprocess.CalledProcessError
                )
                with patch.object(acceptance_builder, "compile_owned_source", side_effect=fail):
                    with self.assertRaises(error):
                        acceptance_builder.pipeline(args)
                self.assertEqual((work / "native-source-validation.json").exists(), not tampered)
                self.assertEqual((self.repo / "NOTICE").read_bytes(), b"notice")

    def test_frontend_copy_restores_shared_siblings_without_copying_whole_docs_or_tests(self):
        for name in ("docs/unrelated.txt", "tests/unrelated.txt"):
            (self.repo / name).write_bytes(b"outside fixed shared input scope")
        original = boundary.inventory(
            self.repo,
            ["docs/contracts/shared-policy.json", "tests/fixtures/shared-fixture.json"],
        )
        old = self.root / "old-frontend-only"
        acceptance_builder.shutil.copytree(self.repo / "frontend", old / "frontend")
        for record in original:
            self.assertFalse((old / record["path"]).exists())
        owned = self.root / "owned-frontend-with-shared-inputs"
        acceptance_builder.shutil.copytree(self.repo / "frontend", owned / "frontend")
        acceptance_builder.copy_shared_frontend_inputs(self.repo, owned)
        for record in original:
            self.assertEqual(
                (owned / record["path"]).read_bytes(), (self.repo / record["path"]).read_bytes()
            )
        self.assertFalse((owned / "docs/unrelated.txt").exists())
        self.assertFalse((owned / "tests/unrelated.txt").exists())
        self.assertEqual(
            boundary.inventory(self.repo, [record["path"] for record in original]), original
        )

    def test_changed_shared_inputs_change_acceptance_identity_and_reject_shipping_reuse(self):
        baseline = boundary.source_binding(self.repo)
        shipping = boundary.load_json(self.sidecar_path)
        first = acceptance_builder.descriptor(
            self.repo,
            self.root / "first-acceptance",
            self.target,
            self.commit,
            "fixture-only",
            self.typed,
            self.root / "sessions",
        )
        for index, name in enumerate(
            ("docs/contracts/shared-policy.json", "tests/fixtures/shared-fixture.json")
        ):
            with self.subTest(name=name):
                path = self.repo / name
                original = path.read_bytes()
                path.write_bytes(original + b" ")
                self.assertNotEqual(boundary.source_binding(self.repo), baseline)
                with self.assertRaises(boundary.BoundaryError):
                    boundary.verify_sidecar(self.repo, self.target, self.binary, shipping)
                changed = acceptance_builder.descriptor(
                    self.repo,
                    self.root / ("changed-acceptance-" + str(index)),
                    self.target,
                    self.commit,
                    "fixture-only",
                    self.typed,
                    self.root / "sessions",
                )
                self.assertNotEqual(
                    changed["sourceInventorySha256"], first["sourceInventorySha256"]
                )
                self.assertNotEqual(changed["buildId"], first["buildId"])
                path.write_bytes(original)
                self.assertEqual(boundary.source_binding(self.repo), baseline)
                boundary.verify_sidecar(self.repo, self.target, self.binary, shipping)

    def test_shared_links_and_oversized_inputs_reject_before_any_copy(self):
        directory = self.repo / "tests/fixtures"
        for name, directory_link in (("linked-file", False), ("linked-directory", True)):
            with self.subTest(name=name):
                link = directory / name
                try:
                    link.symlink_to(
                        "shared-fixture.json" if not directory_link else "../../docs/contracts",
                        target_is_directory=directory_link,
                    )
                except OSError:
                    self.skipTest("Symbolic link creation is unavailable.")
                owned = self.root / ("blocked-" + name)
                owned.mkdir()
                with self.assertRaises(boundary.BoundaryError):
                    acceptance_builder.copy_shared_frontend_inputs(self.repo, owned)
                self.assertEqual(list(owned.iterdir()), [])
                link.unlink()
        oversized = directory / "oversized.json"
        oversized.write_bytes(b"x" * (boundary.MAX_JSON + 1))
        owned = self.root / "blocked-oversized"
        owned.mkdir()
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.copy_shared_frontend_inputs(self.repo, owned)
        self.assertEqual(list(owned.iterdir()), [])

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO creation requires Unix.")
    def test_shared_unsupported_node_rejects_without_opening_or_copying(self):
        os.mkfifo(self.repo / "tests/fixtures/inert-fifo")
        owned = self.root / "blocked-shared-fifo"
        owned.mkdir()
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.copy_shared_frontend_inputs(self.repo, owned)
        self.assertEqual(list(owned.iterdir()), [])

    def test_shared_directory_node_and_total_byte_bounds_reject_before_copy(self):
        (self.repo / "tests/fixtures/empty-one").mkdir()
        (self.repo / "tests/fixtures/empty-two").mkdir()
        for name, limit in (("MAX_ENTRIES", 2), ("MAX_SHARED_FRONTEND_TREE_BYTES", 1)):
            with self.subTest(name=name), patch.object(boundary, name, limit):
                owned = self.root / ("blocked-" + name)
                owned.mkdir()
                with self.assertRaises(boundary.BoundaryError):
                    acceptance_builder.copy_shared_frontend_inputs(self.repo, owned)
                self.assertEqual(list(owned.iterdir()), [])

    def test_shared_destination_parent_link_rejects_before_copy(self):
        owned = self.root / "blocked-destination-parent"
        owned.mkdir()
        outside = self.root / "owned-inert-outside"
        outside.mkdir()
        try:
            (owned / "docs").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("Symbolic link creation is unavailable.")
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.copy_shared_frontend_inputs(self.repo, owned)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((owned / "tests").exists())

    def test_shared_source_parent_link_rejects_before_external_walk_hash_or_copy(self):
        actual_scandir = os.scandir
        for parent_name, subtree in (("docs", "contracts"), ("tests", "fixtures")):
            with self.subTest(parent=parent_name):
                source_parent = self.repo / parent_name
                original_parent = self.root / ("original-" + parent_name)
                source_parent.rename(original_parent)
                outside = self.root / ("owned-inert-external-" + parent_name)
                (outside / subtree).mkdir(parents=True)
                (outside / subtree / "untouched.json").write_bytes(b"inert external fixture")
                try:
                    source_parent.symlink_to(outside, target_is_directory=True)
                except OSError:
                    original_parent.rename(source_parent)
                    self.skipTest("Symbolic link creation is unavailable.")
                external_walks = []

                def guarded_scandir(path):
                    actual = Path(path).resolve()
                    if actual == outside or outside in actual.parents:
                        external_walks.append(str(path))
                        raise AssertionError("Shared parent link allowed external traversal.")
                    return actual_scandir(path)

                owned = self.root / ("blocked-source-parent-" + parent_name)
                owned.mkdir()
                with (
                    patch.object(boundary.os, "scandir", side_effect=guarded_scandir),
                    patch.object(boundary, "hash_file") as hash_file,
                    patch.object(acceptance_builder.shutil, "copyfile") as copy_file,
                ):
                    with self.assertRaises(boundary.BoundaryError):
                        boundary.shared_frontend_tree_names(source_parent / subtree)
                    with self.assertRaises(boundary.BoundaryError):
                        boundary.source_names(self.repo)
                    with self.assertRaises(boundary.BoundaryError):
                        acceptance_builder.copy_shared_frontend_inputs(self.repo, owned)
                    hash_file.assert_not_called()
                    copy_file.assert_not_called()
                self.assertEqual(external_walks, [])
                self.assertEqual(list(owned.iterdir()), [])
                self.assertEqual(
                    (outside / subtree / "untouched.json").read_bytes(), b"inert external fixture"
                )
                source_parent.unlink()
                original_parent.rename(source_parent)

    def test_owned_build_environment_disables_npm_update_check_and_omits_parent_keys(self):
        owned = self.root / "environment-work"
        owned.mkdir()
        with patch.dict(os.environ, {"FICTIONAL_API_KEY": "inert-unit-value"}, clear=True):
            environment = acceptance_builder.owned_environment(
                owned, "owned-tool-path", self.root / "cargo-home", self.root / "rustup-home"
            )
        self.assertEqual(environment["NPM_CONFIG_UPDATE_NOTIFIER"], "false")
        self.assertNotIn("FICTIONAL_API_KEY", environment)
        self.assertEqual(environment["HOME"], str(owned / "home"))

    def test_dependency_invalid_links_fail_before_output_copy(self):
        outside = self.root / "owned-outside-file"
        outside.write_bytes(b"inert outside fixture")
        for name, target in (
            ("absolute", str(outside)),
            ("escape", "../../owned-outside-file"),
            ("dangling", "../missing-file"),
            ("cycle", "cli"),
        ):
            with self.subTest(name=name):
                source = self.root / ("dependencies-" + name)
                (source / ".bin").mkdir(parents=True)
                original = source / "unchanged.txt"
                original.write_bytes(b"unchanged dependency input")
                link = source / ".bin/cli"
                try:
                    link.symlink_to(target)
                except OSError:
                    self.skipTest("Symbolic link creation is unavailable.")
                destination = self.root / ("never-copied-" + name)
                with self.assertRaises(boundary.BoundaryError):
                    acceptance_builder.copy_frontend_dependencies(source, destination)
                self.assertFalse(destination.exists())
                self.assertEqual(os.readlink(link), target)
                self.assertEqual(original.read_bytes(), b"unchanged dependency input")
        self.assertEqual(outside.read_bytes(), b"inert outside fixture")

    @unittest.skipUnless(hasattr(os, "mkfifo"), "FIFO creation requires Unix.")
    def test_dependency_unsupported_node_rejects_without_opening_or_copying(self):
        source = self.root / "dependencies-special"
        source.mkdir()
        fifo = source / "inert-fifo"
        os.mkfifo(fifo)
        destination = self.root / "never-copied-special"
        with self.assertRaises(boundary.BoundaryError):
            acceptance_builder.copy_frontend_dependencies(source, destination)
        self.assertFalse(destination.exists())
        self.assertTrue(fifo.exists())

    def test_duplicate_keys_oversize_and_invalid_json_reject(self):
        path = self.root / "invalid.json"
        for value in (
            b'{"mode":"shipping","mode":"acceptance"}',
            b'{"x":NaN}',
            b"x" * (boundary.MAX_JSON + 1),
        ):
            path.write_bytes(value)
            with self.assertRaises(boundary.BoundaryError):
                boundary.load_json(path)

    def test_inventory_escape_link_and_case_collisions_reject(self):
        for names in (["../LICENSE"], ["LICENSE", "license"], ["/LICENSE"]):
            with self.assertRaises(boundary.BoundaryError):
                boundary.inventory(self.repo, names)
        if hasattr(Path, "symlink_to"):
            link = self.repo / "linked"
            try:
                link.symlink_to(self.repo / "LICENSE")
            except OSError:
                return  # Windows runners may lack link creation privilege.
            with self.assertRaises(boundary.BoundaryError):
                boundary.inventory(self.repo, ["linked"])

    def test_all_native_sidecar_targets_keep_fixed_builder_and_probe_binding(self):
        self.assertEqual(set(boundary.SIDECAR_TARGETS), set(architecture.TARGETS))
        for target in boundary.SIDECAR_TARGETS:
            with self.subTest(target=target):
                suffix = ".exe" if "windows" in target else ""
                binary = self.repo / f"src-tauri/binaries/evidenceloom-runner-{target}{suffix}"
                binary.write_bytes(b"inert simulated native sidecar, never executed")
                path = self.root / f"input-{target}.json"
                with patch.object(boundary.subprocess, "run") as run:
                    boundary.build_shipping_sidecar(
                        self.repo, target, "owned-python", path, self.commit
                    )
                self.assertEqual(run.call_count, 2)
                self.assertEqual(
                    run.call_args_list[0].args[0],
                    ["bash", str(self.repo / "scripts/build_tauri_sidecar.sh"), target],
                )
                self.assertEqual(
                    run.call_args_list[1].args[0],
                    ["owned-python", str(self.repo / "scripts/sidecar_probe.py"), "all", str(binary)],
                )
                boundary.verify_sidecar(self.repo, target, binary, boundary.load_json(path))

    def test_linux_shipping_grammar_keeps_generic_outputs_out_of_macos_batch(self):
        targets = ("aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu")
        for target in targets:
            with self.subTest(target=target):
                binary = self.repo / f"src-tauri/binaries/evidenceloom-runner-{target}"
                binary.write_bytes(b"inert simulated Linux sidecar, never executed")
                path = self.root / f"linux-input-{target}.json"
                boundary.write_json(
                    path,
                    boundary.sidecar_proof(
                        self.repo, target, binary, self.commit, self.completion
                    ),
                )
                directory = self.root / f"linux-stage-{target}"
                stamp = boundary.prepare_shipping(
                    self.repo, directory, target, self.commit, binary, path, {}, self.typed
                )
                executable = self.root / f"inert-desktop-{target}"
                executable.write_bytes(b"unit bytes, never executable\n" + boundary.canonical(stamp))
                proof = boundary.seal_build(directory, executable)
                self.assertEqual(boundary.validate_proof(proof)["target"], target)
                self.assertIsNone(proof["packagedSidecar"])
                self.assertEqual(
                    proof["sidecarTransformation"], "not-observed-in-application-output"
                )
                # Complete inert bundle contents leave only the target boundary
                # before any packaged runner or proof input is hashed.
                bundle = self.root / f"inert-non-macos-bundle-{target}"
                binaries = bundle / "Contents/MacOS"
                binaries.mkdir(parents=True)
                bundled_executable = binaries / "evidenceloom-desktop"
                bundled_executable.write_bytes(executable.read_bytes())
                (binaries / "evidenceloom-runner").write_bytes(b"inert normal output runner")
                with patch.object(boundary, "hash_file", wraps=boundary.hash_file) as hash_file:
                    with self.assertRaises(boundary.BoundaryError):
                        boundary.seal_build(directory, bundled_executable, bundle)
                    hash_file.assert_not_called()

        # Begin with a real, complete seven-asset unit batch. Its parent package
        # proofs remain legal shipping proofs after changing only target/identity.
        public, batch = self.batch_fixture(observed=False)
        self.assertEqual(len(list(public.iterdir())), 7)
        boundary.guard(batch, list(public.iterdir()))
        parent_paths = (
            self.root / "Evidence-Loom-arm64.dmg.proof.json",
            self.root / "intel-proof.json",
        )
        mutant_paths = []
        for target, parent_path in zip(targets, parent_paths):
            proof = boundary.load_json(parent_path)
            proof["target"] = target
            proof["buildId"] = boundary.build_id(
                {key: proof[key] for key in boundary.STAMP_KEYS}
            )
            path = self.root / f"linux-package-proof-{target}.json"
            boundary.write_json(path, proof)
            artifact = public / proof["artifacts"][0]["logicalName"]
            self.assertEqual(boundary.guard(path, [artifact])["target"], target)
            mutant_paths.append(path)
        output = self.root / "never-linux-release-batch.json"
        with self.assertRaises(boundary.BoundaryError):
            boundary.seal_batch(public, mutant_paths, output)
        self.assertFalse(output.exists())

    def test_unknown_native_target_rejects_before_build_and_in_final_proof(self):
        target = "x86_64-arbitrary-build-label"
        with self.assertRaises(boundary.BoundaryError):
            boundary.sidecar_proof(self.repo, target, self.binary, self.commit, self.completion)
        proof = boundary.load_json(self.sidecar_path)
        proof["target"] = target
        with self.assertRaises(boundary.BoundaryError):
            boundary.verify_sidecar(self.repo, target, self.binary, proof)
        with patch.object(boundary.subprocess, "run") as run:
            with self.assertRaises(boundary.BoundaryError):
                boundary.build_shipping_sidecar(
                    self.repo, target, "owned-python", self.root / "never-input.json", self.commit
                )
            run.assert_not_called()
        directory = self.app_stage()
        proof = boundary.load_json(directory / "build-proof.json")
        proof["target"] = target
        proof["buildId"] = boundary.build_id({key: proof[key] for key in boundary.STAMP_KEYS})
        with self.assertRaises(boundary.BoundaryError):
            boundary.validate_stamp({key: proof[key] for key in boundary.STAMP_KEYS}, shipping=True)
        with self.assertRaises(boundary.BoundaryError):
            boundary.validate_proof(proof)

    def test_linux_acceptance_stamp_and_pipeline_reject_before_owned_build(self):
        directory = self.app_stage()
        original = boundary.load_json(directory / "desktop-build-stamp.json")
        for target in ("aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"):
            for stage in ("compile-only", "fixture-only", "app"):
                stamp = {
                    **original,
                    "mode": "acceptance",
                    "stage": stage,
                    "enabledFeatures": ["desktop-acceptance"],
                    "signingPolicy": "unsigned",
                    "permittedOwnedParent": str(self.root),
                    "fixture": {
                        "protocolVersion": 1,
                        "logicalResource": "evidenceloom-desktop-fixture",
                        "sha256": "0" * 64,
                        "bytes": 1,
                    } if stage == "app" else None,
                }
                stamp["buildId"] = boundary.build_id(stamp)
                boundary.validate_stamp(stamp)
                stamp["target"] = target
                stamp["buildId"] = boundary.build_id(stamp)
                with self.subTest(target=target, stage=stage):
                    with self.assertRaises(boundary.BoundaryError):
                        boundary.validate_stamp(stamp)
            args = self.pipeline_args("never-acceptance-" + target)
            args.target = target
            with (
                patch.object(acceptance_builder, "copy_native_source") as copy_source,
                patch.object(acceptance_builder, "compile_owned_source") as compile_source,
            ):
                with self.assertRaises(boundary.BoundaryError):
                    acceptance_builder.pipeline(args)
                copy_source.assert_not_called()
                compile_source.assert_not_called()
            self.assertFalse(Path(args.work_root).exists())

    def test_only_fixed_normal_builder_and_probe_can_produce_reusable_proof(self):
        path = self.root / "fresh-input.json"
        with patch.object(boundary.subprocess, "run") as run:
            boundary.build_shipping_sidecar(
                self.repo, self.target, "owned-python", path, self.commit
            )
        self.assertEqual(run.call_count, 2)
        self.assertEqual(
            run.call_args_list[0].args[0],
            ["bash", str(self.repo / "scripts/build_tauri_sidecar.sh"), self.target],
        )
        self.assertEqual(
            run.call_args_list[1].args[0],
            ["owned-python", str(self.repo / "scripts/sidecar_probe.py"), "all", str(self.binary)],
        )
        boundary.verify_sidecar(self.repo, self.target, self.binary, boundary.load_json(path))
        self.assertEqual(
            boundary.load_json(path)["invocation"]["specSha256"],
            boundary.hash_file(self.repo / "frontend/server/evidenceloom-runner.spec")["sha256"],
        )

    def test_failed_build_or_probe_produces_no_proof(self):
        path = self.root / "never-produced.json"
        with patch.object(
            boundary.subprocess,
            "run",
            side_effect=boundary.subprocess.CalledProcessError(1, "owned-unit-mock"),
        ):
            with self.assertRaises(boundary.subprocess.CalledProcessError):
                boundary.build_shipping_sidecar(
                    self.repo, self.target, "owned-python", path, self.commit
                )
        self.assertFalse(path.exists())

    def test_complete_fixture_cannot_be_renamed_or_relabelled_as_shipping_runner(self):
        self.binary.write_bytes(
            b"complete unit fixture protocol marker evidenceloom-desktop-fixture"
        )
        proof = boundary.load_json(self.sidecar_path)
        proof["sidecar"] = {
            "logicalResource": "evidenceloom-runner",
            **boundary.hash_file(self.binary),
        }
        with self.assertRaises(boundary.BoundaryError):
            boundary.verify_sidecar(self.repo, self.target, self.binary, proof)
        with self.assertRaises(boundary.BoundaryError):
            boundary.sidecar_proof(
                self.repo, self.target, self.binary, self.commit, self.completion
            )

    def test_reuse_rejects_source_target_bytes_and_completion_changes(self):
        original = boundary.load_json(self.sidecar_path)
        for field, value in [("target", boundary.ACCEPTANCE_TARGETS[1]), ("producer", "hash-only-record")]:
            proof = copy.deepcopy(original)
            proof[field] = value
            with self.assertRaises(boundary.BoundaryError):
                boundary.verify_sidecar(self.repo, self.target, self.binary, proof)
        proof = copy.deepcopy(original)
        proof["completion"]["probeExitCode"] = 1
        with self.assertRaises(boundary.BoundaryError):
            boundary.verify_sidecar(self.repo, self.target, self.binary, proof)
        (self.repo / "scripts/sidecar_probe.py").write_bytes(b"changed source")
        with self.assertRaises(boundary.BoundaryError):
            boundary.verify_sidecar(self.repo, self.target, self.binary, original)

    def test_hash_only_or_unknown_stamp_and_acceptance_mode_reject(self):
        directory = self.app_stage()
        original = boundary.load_json(directory / "build-proof.json")
        for patch_value in (
            {"extra": True},
            {"mode": "acceptance"},
            {"stage": "compile-only"},
            {"enabledFeatures": ["desktop-acceptance"]},
        ):
            proof = {**original, **patch_value}
            with self.assertRaises(boundary.BoundaryError):
                boundary.validate_proof(proof)
        missing = {key: value for key, value in original.items() if key != "sourceInventorySha256"}
        with self.assertRaises(boundary.BoundaryError):
            boundary.validate_proof(missing)

    def test_compiled_descriptor_missing_or_changed_bytes_reject_sealing(self):
        directory = self.app_stage()
        (directory / "build-proof.json").unlink()
        executable = self.root / "evidenceloom-desktop"
        executable.write_bytes(b"arbitrary bytes carrying only a shipping filename")
        with self.assertRaises(boundary.BoundaryError):
            boundary.seal_build(directory, executable)

    def mac_bundle_proof(self, runner_bytes):
        # Inert owned files, never Mach-O executables or an executed app build.
        directory = self.app_stage()
        (directory / "build-proof.json").unlink()
        app = self.root / "Evidence Loom.app"
        binaries = app / "Contents/MacOS"
        binaries.mkdir(parents=True)
        executable = binaries / "evidenceloom-desktop"
        executable.write_bytes((self.root / "evidenceloom-desktop").read_bytes())
        (binaries / "evidenceloom-runner").write_bytes(runner_bytes)
        proof = boundary.seal_build(directory, executable, app)
        return directory, app, proof

    def test_pre_sign_input_and_observed_post_bytes_have_separate_explicit_roles(self):
        observed = b"different normal runner bytes: inert signature transformation fixture"
        directory, app, proof = self.mac_bundle_proof(observed)
        input_metadata = boundary.load_json(directory / "sidecar-input.json")["sidecar"]
        self.assertEqual(proof["sidecar"], input_metadata)
        self.assertEqual(proof["sidecarRole"], "normal-build-input-before-tauri-packaging")
        self.assertEqual(
            proof["sidecarInputProofSha256"],
            boundary.hash_file(directory / "sidecar-input.json")["sha256"],
        )
        self.assertEqual(
            proof["packagedSidecar"],
            {
                "logicalResource": "evidenceloom-runner",
                "bytes": len(observed),
                "sha256": boundary.digest(observed),
            },
        )
        self.assertNotEqual(proof["sidecar"]["sha256"], proof["packagedSidecar"]["sha256"])
        self.assertEqual(proof["sidecarTransformation"], "tauri-macos-copy-with-possible-signing")
        self.assertEqual(proof["artifacts"][0]["sha256"], boundary.hash_artifact(app)["sha256"])
        boundary.validate_proof(proof)
        artifact, package_path = self.package(directory)
        package = boundary.guard(package_path, [artifact])
        for key in (
            "target",
            "sidecar",
            "sidecarRole",
            "sidecarInputProofSha256",
            "packagedSidecar",
            "sidecarTransformation",
        ):
            self.assertEqual(package[key], proof[key])

    def test_changed_observed_runner_changes_whole_app_hash_and_fails_existing_seal(self):
        directory, app, proof = self.mac_bundle_proof(b"inert first output bytes")
        runner = app / "Contents/MacOS/evidenceloom-runner"
        runner.write_bytes(b"inert different output bytes")
        self.assertNotEqual(proof["artifacts"][0]["sha256"], boundary.hash_artifact(app)["sha256"])
        with self.assertRaises(boundary.BoundaryError):
            boundary.guard(directory / "build-proof.json", [app])

    def test_unobserved_output_and_private_proof_role_validation_are_explicit(self):
        directory = self.app_stage()
        proof = boundary.load_json(directory / "build-proof.json")
        self.assertIsNone(proof["packagedSidecar"])
        self.assertEqual(proof["sidecarTransformation"], "not-observed-in-application-output")
        windows = copy.deepcopy(proof)
        windows["target"] = boundary.ACCEPTANCE_TARGETS[2]
        windows["buildId"] = boundary.build_id({key: windows[key] for key in boundary.STAMP_KEYS})
        windows["sidecarTransformation"] = "not-observed-in-installer"
        boundary.validate_proof(windows)
        invalid = {**windows, "sidecarTransformation": "tauri-macos-copy-with-possible-signing"}
        with self.assertRaises(boundary.BoundaryError):
            boundary.validate_proof(invalid)
        old_schema = {
            key: value
            for key, value in proof.items()
            if key
            not in {
                "sidecarRole",
                "sidecarInputProofSha256",
                "packagedSidecar",
                "sidecarTransformation",
            }
        }
        with self.assertRaises(boundary.BoundaryError):
            boundary.validate_proof(old_schema)
        invalid = {**proof, "sidecarRole": "packaged-output-equals-input"}
        with self.assertRaises(boundary.BoundaryError):
            boundary.validate_proof(invalid)
        invalid = {**proof, "sidecarInputProofSha256": "not-a-digest"}
        with self.assertRaises(boundary.BoundaryError):
            boundary.validate_proof(invalid)

    def test_packaged_runner_observation_has_strict_shape_bounds_and_no_signing_claim(self):
        _, _, proof = self.mac_bundle_proof(b"inert unsigned output also accepted as observation")
        self.assertEqual(proof["sidecarTransformation"], "tauri-macos-copy-with-possible-signing")
        for patch_value in (
            {"bytes": True},
            {"bytes": boundary.MAX_PACKAGE + 1},
            {"sha256": "bad"},
            {"extra": "unknown"},
        ):
            invalid = copy.deepcopy(proof)
            invalid["packagedSidecar"].update(patch_value)
            with self.assertRaises(boundary.BoundaryError):
                boundary.validate_proof(invalid)

    def test_package_guard_checks_exact_set_and_actual_bytes(self):
        directory = self.app_stage()
        artifact, proof = self.package(directory)
        boundary.guard(proof, [artifact])
        with self.assertRaises(boundary.BoundaryError):
            boundary.guard(proof, [artifact, artifact])
        artifact.write_bytes(b"changed")
        with self.assertRaises(boundary.BoundaryError):
            boundary.guard(proof, [artifact])

    def test_unsigned_test_channel_stays_shipping(self):
        directory = self.app_stage()
        artifact = self.root / "test-installer.exe"
        artifact.write_bytes(b"unit package fixture")
        path = self.root / "unsigned-test-proof.json"
        boundary.seal_package(directory / "build-proof.json", artifact, path, "unsigned-test")
        self.assertEqual(boundary.guard(path, [artifact])["mode"], "shipping")

    def batch_fixture(self, observed=False):
        directory = (
            self.mac_bundle_proof(b"inert ARM observed output")[0] if observed else self.app_stage()
        )
        first, p1 = self.package(directory)
        second = self.root / "Evidence-Loom-x86_64.dmg"
        second.write_bytes(b"owned Intel package")
        p2 = self.root / "intel-proof.json"
        second_proof = boundary.load_json(p1)
        second_proof["target"] = boundary.ACCEPTANCE_TARGETS[1]
        second_proof["buildId"] = boundary.build_id(
            {key: second_proof[key] for key in boundary.STAMP_KEYS}
        )
        if observed:
            second_proof["packagedSidecar"] = {
                "logicalResource": "evidenceloom-runner",
                "bytes": len(b"inert Intel observed output"),
                "sha256": boundary.digest(b"inert Intel observed output"),
            }
        second_proof["artifacts"] = [
            {
                "logicalName": second.name,
                "kind": "package",
                **boundary.hash_file(second),
                "parentProofSha256": "2" * 64,
            }
        ]
        boundary.write_json(p2, second_proof)
        public = self.root / "public"
        public.mkdir()
        for path in (first, second):
            (public / path.name).write_bytes(path.read_bytes())
        for name in (
            "LICENSE",
            "NOTICE",
            "THIRD_PARTY_NOTICES.md",
            "evidenceloom.spdx.json",
            "SHA256SUMS",
        ):
            (public / name).write_bytes(b"owned supporting artifact")
        batch = self.root / "batch.json"
        boundary.seal_batch(public, [p1, p2], batch)
        return public, batch

    def test_batch_exact_seven_assets_and_both_actual_platform_proofs(self):
        public, batch = self.batch_fixture(observed=True)
        batch_proof = boundary.guard(batch, list(public.iterdir()))
        arm_path = self.root / "Evidence-Loom-arm64.dmg.proof.json"
        intel_path = self.root / "intel-proof.json"
        arm, intel = boundary.load_json(arm_path), boundary.load_json(intel_path)
        for key in (
            "target",
            "sidecar",
            "sidecarRole",
            "sidecarInputProofSha256",
            "packagedSidecar",
            "sidecarTransformation",
        ):
            self.assertEqual(batch_proof[key], arm[key])
        self.assertNotEqual(batch_proof["packagedSidecar"], intel["packagedSidecar"])
        self.assertEqual(batch_proof["target"], boundary.ACCEPTANCE_TARGETS[0])
        parent = boundary.digest(
            boundary.canonical(
                sorted(boundary.hash_file(path)["sha256"] for path in (arm_path, intel_path))
            )
        )
        self.assertTrue(
            all(item["parentProofSha256"] == parent for item in batch_proof["artifacts"])
        )
        (public / "unknown-proof.json").write_bytes(b"internal proof must not leak")
        with self.assertRaises(boundary.BoundaryError):
            boundary.seal_batch(
                public,
                [self.root / "Evidence-Loom-arm64.dmg.proof.json", self.root / "intel-proof.json"],
                self.root / "bad-batch.json",
            )

    def test_remote_draft_complete_set_and_bytes_before_publication(self):
        public, batch = self.batch_fixture()
        listing = self.root / "remote.json"
        names = sorted(path.name for path in public.iterdir())
        boundary.write_json(
            listing, {"isDraft": True, "assets": [{"name": name} for name in names]}
        )
        boundary.remote_set(batch, listing)
        boundary.remote_guard(batch, listing, public)
        invalid = boundary.load_json(batch)
        invalid["sidecarRole"] = "output-equivalence-certificate"
        invalid_path = self.root / "invalid-metadata-proof.json"
        boundary.write_json(invalid_path, invalid)
        with self.assertRaises(boundary.BoundaryError):
            boundary.remote_set(invalid_path, listing)
        with self.assertRaises(boundary.BoundaryError):
            boundary.remote_guard(invalid_path, listing, public)
        listing.unlink()
        boundary.write_json(
            listing,
            {"isDraft": True, "assets": [{"name": name} for name in [*names, "old-fixture.dmg"]]},
        )
        with self.assertRaises(boundary.BoundaryError):
            boundary.remote_set(batch, listing)
        with self.assertRaises(boundary.BoundaryError):
            boundary.remote_guard(batch, listing, public)
        listing.unlink()
        boundary.write_json(
            listing, {"isDraft": False, "assets": [{"name": name} for name in names]}
        )
        with self.assertRaises(boundary.BoundaryError):
            boundary.remote_guard(batch, listing, public)

    def test_frontend_fixture_asset_and_external_runner_overlay_reject(self):
        (self.repo / "frontend/out/desktop-acceptance-build.json").write_bytes(b"fixture")
        with self.assertRaises(boundary.BoundaryError):
            boundary.prepare_shipping(
                self.repo,
                self.root / "blocked-app",
                self.target,
                self.commit,
                self.binary,
                self.sidecar_path,
                {},
                self.typed,
            )
        config = boundary.load_json(self.typed)
        config["bundle"]["externalBin"] = ["renamed-fixture"]
        with self.assertRaises(boundary.BoundaryError):
            boundary.reject_acceptance_config(config)


if __name__ == "__main__":
    unittest.main()
