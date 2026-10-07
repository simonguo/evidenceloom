#!/usr/bin/env python3
"""Build an unsigned local acceptance app from isolated, explicit inputs.

This is a source implementation, not authorization to execute the pipeline.
It uses Cargo and the current frontend, never Tauri bundler/codesign/notarization.
App startup and session launching belong to a separately reviewed launcher.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys

import check_desktop_acceptance_boundary as boundary
import desktop_frontend_evidence as frontend_evidence


def native_source_inventory(repo):
    names = boundary.source_names(repo)
    for name in names:
        parts = Path(name).parts
        boundary.require(not any(part.casefold() == ".git" for part in parts))
        boundary.require(not any(part.casefold().startswith(".env") for part in parts))
    return boundary.inventory(repo, names)


def verify_native_source(original, copied, expected):
    boundary.require(native_source_inventory(original) == expected)
    boundary.require(native_source_inventory(copied) == expected)


def copy_native_source(original, destination):
    """Create a fresh source-only compile cwd; SDK outputs stay in this copy."""
    original, destination = Path(original), Path(destination)
    boundary.require(destination.is_absolute())
    for directory in reversed([destination.parent, *destination.parent.parents]):
        metadata = directory.lstat()
        boundary.require(stat.S_ISDIR(metadata.st_mode))
        boundary.require(not getattr(metadata, "st_file_attributes", 0) & 0x400)
    boundary.require(not destination.exists() and not destination.is_symlink())
    records = native_source_inventory(original)
    destination.mkdir()
    for record in records:
        source = boundary.regular(original / record["path"])
        copied = destination / record["path"]
        copied.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, copied)
        copied.chmod(stat.S_IMODE(source.stat().st_mode) & 0o777)
    verify_native_source(original, destination, records)
    return records


def copy_shared_frontend_inputs(repo, work):
    """Copy only bounded fixed siblings needed by the current frontend."""
    repo, work = Path(repo), Path(work)
    boundary.require(work.is_dir() and not work.is_symlink())
    names = [
        prefix + "/" + name
        for prefix in boundary.SHARED_FRONTEND_PREFIXES
        for name in boundary.shared_frontend_tree_names(repo / prefix)
    ]
    records = boundary.inventory(repo, names)
    for prefix in boundary.SHARED_FRONTEND_PREFIXES:
        destination = work / prefix
        boundary.require(not destination.exists() and not destination.is_symlink())
        boundary.require(not destination.parent.is_symlink())
    for record in records:
        destination = work / record["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repo / record["path"], destination)
    boundary.require(boundary.inventory(work, names) == records)
    boundary.require(boundary.inventory(repo, names) == records)


def copy_frontend_dependencies(source, destination):
    """Preserve inward npm links after validating the whole dependency tree."""
    try:
        source = Path(source)
        boundary.require(source.is_absolute())
        source = source.resolve(strict=True)
        boundary.require(source.is_dir())
        directories, links = [source], []
        while directories:
            with os.scandir(directories.pop()) as entries:
                for entry in entries:
                    path = Path(entry.path)
                    metadata = path.lstat()
                    if stat.S_ISLNK(metadata.st_mode):
                        target = Path(os.readlink(path))
                        boundary.require(not target.is_absolute() and not target.drive)
                        lexical = Path(os.path.abspath(path.parent / target))
                        boundary.require(lexical == source or source in lexical.parents)
                        links.append(path)
                    else:
                        # Junctions and other reparse nodes are not relative npm
                        # symlinks. Do not traverse a hidden external directory.
                        boundary.require(not getattr(metadata, "st_file_attributes", 0) & 0x400)
                        boundary.require(
                            stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode)
                        )
                        if stat.S_ISDIR(metadata.st_mode):
                            directories.append(path)
        # Check all literal links before resolving chains, so an absolute or
        # escaping intermediate link is rejected before following that chain.
        for path in links:
            actual = path.resolve(strict=True)
            boundary.require(actual == source or source in actual.parents)
            mode = actual.stat().st_mode
            boundary.require(stat.S_ISREG(mode) or stat.S_ISDIR(mode))
    except (OSError, RuntimeError, ValueError):
        raise boundary.BoundaryError("desktop_proof_invalid") from None
    destination = Path(destination)
    boundary.require(not destination.exists() and not destination.is_symlink())
    shutil.copytree(source, destination, symlinks=True)


def owned_environment(work, tool_path, cargo_home, rustup_home):
    work = Path(work)
    for name in ("home", "temp", "sessions"):
        (work / name).mkdir()
    environment = {
        key: value
        for key, value in os.environ.items()
        if key
        in {
            "SystemRoot",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "PROCESSOR_ARCHITECTURE",
            "NUMBER_OF_PROCESSORS",
        }
    }
    environment.update(
        {
            "PATH": tool_path,
            "HOME": str(work / "home"),
            "USERPROFILE": str(work / "home"),
            "TMPDIR": str(work / "temp"),
            "TMP": str(work / "temp"),
            "TEMP": str(work / "temp"),
            "CARGO_HOME": str(cargo_home),
            "RUSTUP_HOME": str(rustup_home),
            "CARGO_TARGET_DIR": str(work / "target"),
            "NEXT_TELEMETRY_DISABLED": "1",
            "NPM_CONFIG_UPDATE_NOTIFIER": "false",
            "PYTHON_DOTENV_DISABLED": "1",
            "TAURI": "1",
        }
    )
    return environment


def cargo_metadata(repo, target, environment, binary, command="check", stamp=None):
    env = dict(environment)
    env.pop("EVIDENCELOOM_DESKTOP_BUILD_STAMP", None)
    if stamp is not None:
        env["EVIDENCELOOM_DESKTOP_BUILD_STAMP"] = str(stamp)
    cargo = shutil.which("cargo", path=env["PATH"])
    boundary.require(cargo is not None)
    result = subprocess.run(
        [
            cargo,
            command,
            "--manifest-path",
            str(Path(repo) / "src-tauri/Cargo.toml"),
            "--locked",
            "--offline",
            "--release",
            "--target",
            target,
            "--features",
            "desktop-acceptance",
            "--bin",
            binary,
            "--message-format=json",
        ],
        cwd=repo,
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    messages = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
    directories = [
        Path(item["out_dir"])
        for item in messages
        if item.get("reason") == "build-script-executed"
        and "evidenceloom-desktop" in item.get("package_id", "")
    ]
    boundary.require(len(directories) == 1)
    out = directories[0].resolve(strict=True)
    boundary.require(Path(env["CARGO_TARGET_DIR"]).resolve() in out.parents)
    return out


def descriptor(
    repo,
    directory,
    target,
    base_commit,
    stage,
    config_path,
    parent,
    fixture=None,
    frontend_input=None,
    frontend=None,
):
    repo, directory = Path(repo), Path(directory)
    directory.mkdir()
    source = boundary.inventory(repo, boundary.source_names(repo))
    acl = boundary.acl_inventory(repo, acceptance=stage == "app")
    stamp = {
        "schemaVersion": 1,
        "mode": "acceptance",
        "stage": stage,
        "buildId": "0" * 64,
        "baseCommit": base_commit,
        "sourceInventorySha256": boundary.digest(boundary.canonical(source)),
        "target": target,
        "enabledFeatures": ["desktop-acceptance"],
        "signingPolicy": "unsigned",
        "permittedOwnedParent": str(parent),
        "effectiveConfigSha256": boundary.hash_file(config_path)["sha256"],
        "aclInventorySha256": boundary.digest(boundary.canonical(acl)),
        "frontendInputInventorySha256": boundary.digest(boundary.canonical(frontend_input))
        if frontend_input
        else "0" * 64,
        "frontendInventorySha256": boundary.digest(boundary.canonical(frontend))
        if frontend
        else "0" * 64,
        "cargoLockSha256": boundary.hash_file(repo / "src-tauri/Cargo.lock")["sha256"],
        "frontendLockSha256": boundary.hash_file(repo / "frontend/package-lock.json")["sha256"],
        "fixture": fixture,
    }
    stamp["buildId"] = boundary.build_id(stamp)
    for name, value in [
        ("source-inventory.json", source),
        ("acl-inventory.json", acl),
        ("desktop-build-stamp.json", stamp),
    ]:
        boundary.write_json(directory / name, value)
    if frontend_input is not None:
        boundary.write_json(directory / "frontend-input-inventory.json", frontend_input)
    if frontend is not None:
        boundary.write_json(directory / "frontend-inventory.json", frontend)
    shutil.copyfile(boundary.regular(config_path), directory / "desktop-effective-config.json")
    return stamp


def assemble_app(repo, output, target, executable, fixture, stamp_path, stamp, frontend_proof):
    """Copy only fixed files; no bundler, installer, signer or user-path lookup."""
    output = Path(output)
    boundary.require(not output.exists())
    if "apple-darwin" in target:
        app = output / "Evidence Loom Acceptance.app"
        binaries, resources = app / "Contents/MacOS", app / "Contents/Resources"
    else:
        app = output / "Evidence Loom Acceptance"
        binaries, resources = app, app / "resources"
    binaries.mkdir(parents=True)
    resources.mkdir()
    suffix = ".exe" if "windows" in target else ""
    shutil.copyfile(boundary.regular(executable), binaries / f"evidenceloom-desktop{suffix}")
    shutil.copyfile(boundary.regular(fixture), resources / f"evidenceloom-desktop-fixture{suffix}")
    for name in ("LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"):
        shutil.copyfile(boundary.regular(Path(repo) / name), resources / name)
    shutil.copyfile(boundary.regular(stamp_path), resources / "desktop-build-stamp.json")
    if "apple-darwin" in target:
        for path in (binaries / "evidenceloom-desktop", resources / "evidenceloom-desktop-fixture"):
            path.chmod(0o755)
        plist = {
            "CFBundleIdentifier": "io.github.simonguo.evidenceloom.acceptance",
            "CFBundleExecutable": "evidenceloom-desktop",
            "CFBundleName": "Evidence Loom Acceptance",
            "CFBundleDisplayName": "Evidence Loom Acceptance",
            "CFBundleInfoDictionaryVersion": "6.0",
            "CFBundlePackageType": "APPL",
            "CFBundleVersion": "1",
            "CFBundleShortVersionString": "1.0",
            "NSHighResolutionCapable": True,
        }
        with (app / "Contents/Info.plist").open("xb") as stream:
            plistlib.dump(plist, stream, sort_keys=True)
    records = boundary.inventory(app, boundary.tree_names(app))
    boundary.write_json(
        output / "acceptance-output-proof.json",
        {
            "schemaVersion": 1,
            "mode": "acceptance",
            "stage": "app",
            "signingPolicy": "unsigned",
            "buildId": stamp["buildId"],
            "compiledStampSha256": boundary.hash_file(stamp_path)["sha256"],
            "target": target,
            "sourceInventorySha256": stamp["sourceInventorySha256"],
            "artifacts": records,
            "evidence": {
                "sourceRoot": str(repo),
                "sourceSnapshot": str(output.parent / "source-input-bytes"),
                "sourceInventory": str(output.parent / "native-source-input-inventory.json"),
                "stageRoot": str(stamp_path.parent),
                "stageSnapshot": str(output.parent / "stage-proof-bytes"),
                "stageInventory": str(output.parent / "stage-proof-inventory.json"),
                "frontendProof": str(frontend_proof),
                "frozenApp": str(output / "frozen-app"),
            },
            "limitations": [
                "local app assembly only",
                "not executed or notarized",
                "not shipping publication proof",
            ],
        },
    )
    frontend_evidence.freeze_files(app, [row["path"] for row in records], output / "frozen-app")
    frontend_evidence.same_bytes(stamp_path, resources / "desktop-build-stamp.json")
    return app


def pipeline(args):
    repo = Path(args.repo).resolve(strict=True)
    work = Path(args.work_root)
    boundary.require(work.is_absolute() and not work.exists())
    work = work.parent.resolve(strict=True) / work.name
    boundary.require(work != repo and repo not in work.parents)
    boundary.require(
        args.target in boundary.ACCEPTANCE_TARGETS
        and re.fullmatch(r"[0-9a-f]{40}", args.base_commit)
    )
    # Only this acceptance builder creates its private selector/evidence inputs.
    boundary.require(
        frontend_evidence.SELECTOR not in os.environ
        and frontend_evidence.METADATA not in os.environ
    )
    # Signing inputs are rejected before starting any tool, not merely ignored.
    boundary.require(
        not any(key.startswith("APPLE_") or key.startswith("TAURI_SIGNING_") for key in os.environ)
    )
    for path in (args.cargo_home, args.rustup_home, args.frontend_dependencies):
        boundary.require(Path(path).is_absolute() and Path(path).is_dir())
    work.mkdir()
    work = work.resolve(strict=True)
    environment = owned_environment(work, args.tool_path, args.cargo_home, args.rustup_home)
    source = work / "native-source"
    inputs = copy_native_source(repo, source)
    boundary.write_json(work / "native-source-input-inventory.json", inputs)
    frontend_evidence.freeze_files(
        source, [row["path"] for row in inputs], work / "source-input-bytes"
    )
    try:
        return compile_owned_source(source, work, args, environment)
    finally:
        verify_native_source(repo, source, inputs)
        frontend_evidence.verify_frozen(source, work / "source-input-bytes", inputs)
        boundary.write_json(
            work / "native-source-validation.json",
            {
                "schemaVersion": 1,
                "sourceInventorySha256": boundary.digest(boundary.canonical(inputs)),
                "sourceEntryCount": len(inputs),
                "originalAndCopiedInputsUnchanged": True,
            },
        )


def compile_owned_source(repo, work, args, environment):
    """Compile and assemble only from the identically bound owned source copy."""
    overlay = boundary.load_json(repo / "src-tauri/acceptance/tauri.conf.json")
    overlay["build"]["frontendDist"] = str(work / "frontend/out")
    # Fixture compilation does not load acceptance ACL or compile app assets.
    fixture_overlay = boundary.merge(overlay, {"app": {"security": {"capabilities": ["default"]}}})
    fixture_environment = {
        **environment,
        "TAURI_CONFIG": boundary.canonical(fixture_overlay).decode(),
    }
    metadata = cargo_metadata(
        repo, args.target, fixture_environment, "evidenceloom-desktop-fixture"
    )
    descriptor(
        repo,
        work / "fixture-stage",
        args.target,
        args.base_commit,
        "fixture-only",
        metadata / "desktop-effective-config.json",
        work / "sessions",
    )
    cargo_metadata(
        repo,
        args.target,
        fixture_environment,
        "evidenceloom-desktop-fixture",
        "build",
        work / "fixture-stage/desktop-build-stamp.json",
    )
    suffix = ".exe" if "windows" in args.target else ""
    fixture_path = work / f"target/{args.target}/release/evidenceloom-desktop-fixture{suffix}"
    fixture = {
        "protocolVersion": 1,
        "logicalResource": "evidenceloom-desktop-fixture",
        **boundary.hash_file(fixture_path, boundary.MAX_FIXTURE),
    }
    # Build the real current frontend in an owned copy using already present deps.
    shutil.copytree(
        repo / "frontend",
        work / "frontend",
        ignore=shutil.ignore_patterns("node_modules", "out", ".next", "*.tsbuildinfo"),
    )
    copy_shared_frontend_inputs(repo, work)
    copy_frontend_dependencies(args.frontend_dependencies, work / "frontend/node_modules")
    frontend_proof = frontend_evidence.run_frontend(
        work / "frontend", work, "acceptance", environment
    )
    frontend = work / "frontend/out"
    inputs = boundary.inventory(frontend, boundary.tree_names(frontend))
    boundary.require(not (frontend / "desktop-acceptance-build.json").exists())
    app_environment = {**environment, "TAURI_CONFIG": boundary.canonical(overlay).decode()}
    metadata = cargo_metadata(repo, args.target, app_environment, "evidenceloom-desktop-fixture")
    # Calculate identity before adding its asset; the final inventory is excluded.
    stamp = descriptor(
        repo,
        work / "app-stage",
        args.target,
        args.base_commit,
        "app",
        metadata / "desktop-effective-config.json",
        work / "sessions",
        fixture,
        inputs,
        inputs,
    )
    boundary.write_json(
        frontend / "desktop-acceptance-build.json",
        {"schemaVersion": 1, "buildId": stamp["buildId"]},
    )
    final = boundary.inventory(frontend, boundary.tree_names(frontend))
    stamp["frontendInventorySha256"] = boundary.digest(boundary.canonical(final))
    # These new owned staging files are finalized before the sole app compilation.
    for name, value in [("frontend-inventory.json", final), ("desktop-build-stamp.json", stamp)]:
        path = work / "app-stage" / name
        path.unlink()
        boundary.write_json(path, value)
    frontend_proof = frontend_evidence.reseal_acceptance(frontend_proof)
    frontend_evidence.verify_frontend_proof(frontend_proof, "acceptance", frontend)
    shutil.copyfile(boundary.regular(frontend_proof), work / "app-stage/frontend-proof.json")
    shutil.copyfile(fixture_path, work / "app-stage" / fixture_path.name)
    stage_records = boundary.inventory(work / "app-stage", boundary.tree_names(work / "app-stage"))
    frontend_evidence.freeze_files(
        work / "app-stage", [row["path"] for row in stage_records], work / "stage-proof-bytes"
    )
    boundary.write_json(work / "stage-proof-inventory.json", stage_records)
    boundary.validate_stamp(stamp)
    cargo_metadata(
        repo,
        args.target,
        app_environment,
        "evidenceloom-desktop",
        "build",
        work / "app-stage/desktop-build-stamp.json",
    )
    executable = work / f"target/{args.target}/release/evidenceloom-desktop{suffix}"
    boundary.require(boundary.contains_bytes(executable, boundary.canonical(stamp)))
    frontend_evidence.verify_frozen(
        work / "app-stage", work / "stage-proof-bytes", stage_records, exact_tree=True
    )
    frontend_evidence.verify_frontend_proof(frontend_proof, "acceptance", frontend)
    return assemble_app(
        repo,
        work / "output",
        args.target,
        executable,
        fixture_path,
        work / "app-stage/desktop-build-stamp.json",
        stamp,
        frontend_proof,
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "repo",
        "work-root",
        "target",
        "base-commit",
        "cargo-home",
        "rustup-home",
        "frontend-dependencies",
        "tool-path",
    ):
        parser.add_argument("--" + name, required=True)
    try:
        pipeline(parser.parse_args())
    except (
        boundary.BoundaryError,
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.CalledProcessError,
        RecursionError,
    ):
        print("desktop_proof_invalid", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(frontend_evidence.supervised_entrypoint(main))
