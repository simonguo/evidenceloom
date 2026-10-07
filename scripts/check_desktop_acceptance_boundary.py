#!/usr/bin/env python3
"""Bounded local build records and fail-closed desktop publication checks.

Records attest the reviewed build pipeline's inputs and bytes, not a hostile host.
This module never starts an app, runner, signer, provider or credential service.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import shutil
import sys

if __package__:
    from .sidecar_architecture import TARGETS as NATIVE_TARGETS
else:
    from sidecar_architecture import TARGETS as NATIVE_TARGETS

MAX_JSON = 1024 * 1024
MAX_ENTRIES = 1024
MAX_ARTIFACTS = 64
MAX_PACKAGE = 4 * 1024**3
MAX_FIXTURE = 256 * 1024**2
SHARED_FRONTEND_PREFIXES = ("docs/contracts", "tests/fixtures")
MAX_SHARED_FRONTEND_TREE_BYTES = 16 * MAX_JSON
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
# Normal native sidecar/shipping grammar preserves the architecture checker's six targets.
SIDECAR_TARGETS = tuple(NATIVE_TARGETS)
SHIPPING_TARGETS = SIDECAR_TARGETS
# Acceptance tooling and the public release entry points retain their narrower scope.
ACCEPTANCE_TARGETS = (
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
)
MACOS_RELEASE_TARGETS = ("aarch64-apple-darwin", "x86_64-apple-darwin")
STAMP_KEYS = {
    "schemaVersion",
    "mode",
    "stage",
    "buildId",
    "baseCommit",
    "sourceInventorySha256",
    "target",
    "enabledFeatures",
    "signingPolicy",
    "permittedOwnedParent",
    "effectiveConfigSha256",
    "aclInventorySha256",
    "frontendInputInventorySha256",
    "frontendInventorySha256",
    "cargoLockSha256",
    "frontendLockSha256",
    "fixture",
}
FORBIDDEN = ("desktop-acceptance", "evidenceloom-desktop-fixture")


class BoundaryError(ValueError):
    """Fixed public error; deliberately excludes paths or input contents."""


def require(condition):
    if not condition:
        raise BoundaryError("desktop_proof_invalid")


def canonical(value):
    return (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink())
    return path


def hash_file(path, maximum=MAX_PACKAGE, allow_empty=False):
    path = regular(path)
    size = path.stat().st_size
    require((size >= 0 if allow_empty else size > 0) and size <= maximum)
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    require(path.stat().st_size == size)
    return {"bytes": size, "sha256": h.hexdigest()}


def load_json(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result

    path = regular(path)
    with path.open("rb") as stream:
        data = stream.read(MAX_JSON + 1)
    require(len(data) <= MAX_JSON)
    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=lambda _: require(False))
    except (ValueError, UnicodeError) as error:
        raise BoundaryError("desktop_proof_invalid") from error


def write_json(path, value):
    data = canonical(value)
    require(len(data) <= MAX_JSON)
    path = Path(path)
    require(not path.exists() and not path.is_symlink())
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)


def relative_name(name):
    require(isinstance(name, str) and 0 < len(name.encode()) <= 512)
    require("\\" not in name and ":" not in name and not name.startswith("/"))
    require(all(part not in ("", ".", "..") for part in name.split("/")))
    return name


def inventory(root, names):
    root = Path(root).resolve(strict=True)
    names = sorted(names)
    require(0 < len(names) <= MAX_ENTRIES)
    require(len({name.casefold() for name in names}) == len(names))
    records = []
    for name in names:
        relative_name(name)
        path = root / name
        require(root in path.resolve(strict=True).parents)
        require(
            all(
                not parent.is_symlink() for parent in [path, *path.parents] if parent != root.parent
            )
        )
        records.append({"path": name, **hash_file(path, allow_empty=True)})
    return records


def tree_names(root):
    root = Path(root)
    require(root.is_dir() and not root.is_symlink())
    result = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        require(all(not (Path(directory) / name).is_symlink() for name in dirs))
        for name in files:
            result.append((Path(directory) / name).relative_to(root).as_posix())
            require(len(result) <= MAX_ENTRIES)
    return sorted(result)


def shared_frontend_directory(path, allow_missing=False):
    try:
        metadata = Path(path).lstat()
    except FileNotFoundError:
        require(allow_missing)
        return False
    except OSError:
        raise BoundaryError("desktop_proof_invalid") from None
    require(stat.S_ISDIR(metadata.st_mode))
    require(not getattr(metadata, "st_file_attributes", 0) & 0x400)
    return True


def shared_frontend_tree_names(root):
    """Bound every node before reading or copying a fixed shared input tree."""
    root = Path(root)
    shared_frontend_directory(root.parent)
    shared_frontend_directory(root)
    directories, result, seen = [root], [], set()
    total = 0
    try:
        while directories:
            with os.scandir(directories.pop()) as entries:
                for entry in entries:
                    path = Path(entry.path)
                    name = relative_name(path.relative_to(root).as_posix())
                    require(name.casefold() not in seen)
                    seen.add(name.casefold())
                    require(len(seen) <= MAX_ENTRIES)
                    metadata = path.lstat()
                    require(not getattr(metadata, "st_file_attributes", 0) & 0x400)
                    if stat.S_ISDIR(metadata.st_mode):
                        directories.append(path)
                    else:
                        require(stat.S_ISREG(metadata.st_mode))
                        require(metadata.st_size <= MAX_JSON)
                        total += metadata.st_size
                        require(total <= MAX_SHARED_FRONTEND_TREE_BYTES)
                        result.append(name)
    except (OSError, RuntimeError):
        raise BoundaryError("desktop_proof_invalid") from None
    return sorted(result)


def source_names(repo):
    repo = Path(repo)
    result = []
    ignored = {"target", "node_modules", "out", ".next", "__pycache__", "binaries", "gen", ".venv"}
    for prefix in ("src-tauri", "frontend", "scripts", "tradingagents", ".github/workflows"):
        directory = repo / prefix
        if not directory.exists():
            continue
        for current, dirs, files in os.walk(directory, followlinks=False):
            dirs[:] = sorted(name for name in dirs if name not in ignored)
            require(all(not (Path(current) / name).is_symlink() for name in dirs))
            for name in files:
                if name in ("next-env.d.ts", ".eslintcache") or name.endswith(
                    (".pyc", ".DS_Store", ".tsbuildinfo")
                ):
                    continue
                result.append((Path(current) / name).relative_to(repo).as_posix())
    for prefix in SHARED_FRONTEND_PREFIXES:
        directory = repo / prefix
        if not shared_frontend_directory(directory.parent, allow_missing=True):
            continue
        if not shared_frontend_directory(directory, allow_missing=True):
            continue
        result.extend(prefix + "/" + name for name in shared_frontend_tree_names(directory))
    for name in ("pyproject.toml", "uv.lock", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"):
        if (repo / name).exists():
            result.append(name)
    return sorted(result)


def merge(base, patch):
    if not isinstance(patch, dict):
        return patch
    result = dict(base) if isinstance(base, dict) else {}
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        else:
            result[key] = merge(result.get(key), value)
    return result


def effective_config(repo, target, overlay=None):
    repo = Path(repo)
    value = load_json(repo / "src-tauri/tauri.conf.json")
    platform = "windows" if "windows" in target else "macos" if "apple" in target else "linux"
    path = repo / f"src-tauri/tauri.{platform}.conf.json"
    if path.exists():
        value = merge(value, load_json(path))
    return merge(value, overlay or {})


def acl_inventory(repo, acceptance=False):
    names = (
        ["src-tauri/acceptance/capability.json", "src-tauri/acceptance/permissions/default.toml"]
        if acceptance
        else [
            "src-tauri/capabilities/" + name
            for name in tree_names(Path(repo) / "src-tauri/capabilities")
        ]
    )
    if not acceptance and (Path(repo) / "src-tauri/permissions").exists():
        names += [
            "src-tauri/permissions/" + name
            for name in tree_names(Path(repo) / "src-tauri/permissions")
        ]
    return inventory(repo, names)


def build_id(stamp):
    return digest(
        canonical(
            {
                key: value
                for key, value in stamp.items()
                if key not in ("buildId", "frontendInventorySha256")
            }
        )
    )


def validate_stamp(stamp, shipping=False):
    require(isinstance(stamp, dict) and set(stamp) == STAMP_KEYS)
    require(type(stamp["schemaVersion"]) is int and stamp["schemaVersion"] == 1)
    require(stamp["mode"] in ("shipping", "acceptance"))
    require(stamp["stage"] in ("compile-only", "fixture-only", "app"))
    require(isinstance(stamp["enabledFeatures"], list))
    require(
        stamp["enabledFeatures"] == ([] if stamp["mode"] == "shipping" else ["desktop-acceptance"])
    )
    targets = SHIPPING_TARGETS if stamp["mode"] == "shipping" else ACCEPTANCE_TARGETS
    require(stamp["target"] in targets)
    for key in STAMP_KEYS:
        if key.endswith("Sha256") or key == "buildId":
            require(isinstance(stamp[key], str) and HEX64.fullmatch(stamp[key]))
    require(
        isinstance(stamp["baseCommit"], str) and re.fullmatch(r"[0-9a-f]{40}", stamp["baseCommit"])
    )
    require(build_id(stamp) == stamp["buildId"])
    if shipping:
        require(stamp["mode"] == "shipping" and stamp["stage"] == "app")
        require(stamp["fixture"] is None and stamp["permittedOwnedParent"] == "")
        require(stamp["signingPolicy"] == "platform")
    elif stamp["mode"] == "acceptance":
        require(stamp["signingPolicy"] == "unsigned")
        if stamp["stage"] == "app":
            fixture = stamp["fixture"]
            require(
                isinstance(fixture, dict)
                and set(fixture) == {"protocolVersion", "logicalResource", "sha256", "bytes"}
            )
            require(type(fixture["protocolVersion"]) is int and fixture["protocolVersion"] == 1)
            require(fixture["logicalResource"] == "evidenceloom-desktop-fixture")
            require(type(fixture["bytes"]) is int and 0 < fixture["bytes"] <= MAX_FIXTURE)
            require(HEX64.fullmatch(fixture["sha256"]))
            require(Path(stamp["permittedOwnedParent"]).is_absolute())
    return stamp


def source_binding(repo):
    return digest(canonical(inventory(repo, source_names(repo))))


def sidecar_proof(repo, target, binary, base_commit, completion):
    require(target in SIDECAR_TARGETS and re.fullmatch(r"[0-9a-f]{40}", base_commit))
    require(
        completion
        == {
            "buildExitCode": 0,
            "probeExitCode": 0,
            "sourceBeforeSha256": source_binding(repo),
            "sourceAfterSha256": source_binding(repo),
        }
    )
    require(not any(contains_bytes(binary, term.encode()) for term in FORBIDDEN))
    return {
        "schemaVersion": 1,
        "mode": "shipping",
        "stage": "sidecar-input",
        "baseCommit": base_commit,
        "sourceInventorySha256": source_binding(repo),
        "target": target,
        "producer": "normal-sidecar-build-v1",
        "completion": completion,
        "invocation": {
            "script": "scripts/build_tauri_sidecar.sh",
            "target": target,
            "scriptSha256": hash_file(Path(repo) / "scripts/build_tauri_sidecar.sh")["sha256"],
            "spec": "frontend/server/evidenceloom-runner.spec",
            "specSha256": hash_file(Path(repo) / "frontend/server/evidenceloom-runner.spec")[
                "sha256"
            ],
            "probe": "scripts/sidecar_probe.py",
            "probeSha256": hash_file(Path(repo) / "scripts/sidecar_probe.py")["sha256"],
        },
        "sidecar": {"logicalResource": "evidenceloom-runner", **hash_file(binary)},
    }


def build_shipping_sidecar(repo, target, python, proof_path, base_commit):
    """The sole producer: execute the fixed normal build and bounded real probe.

    A hash-only relabel command is deliberately unavailable. This function is
    not invoked by unit validation; subprocess boundaries are mocked there.
    """
    require("EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY" not in os.environ)
    repo = Path(repo).resolve(strict=True)
    require(target in SIDECAR_TARGETS and re.fullmatch(r"[0-9a-f]{40}", base_commit))
    before = source_binding(repo)
    environment = dict(os.environ)
    environment["PYTHON"] = str(python)
    subprocess.run(
        ["bash", str(repo / "scripts/build_tauri_sidecar.sh"), target],
        cwd=repo,
        env=environment,
        check=True,
    )
    suffix = ".exe" if "windows" in target else ""
    binary = repo / "src-tauri/binaries" / f"evidenceloom-runner-{target}{suffix}"
    require(not any(contains_bytes(binary, term.encode()) for term in FORBIDDEN))
    subprocess.run(
        [str(python), str(repo / "scripts/sidecar_probe.py"), "all", str(binary)],
        cwd=repo,
        env=environment,
        check=True,
    )
    after = source_binding(repo)
    require(before == after)
    proof = sidecar_proof(
        repo,
        target,
        binary,
        base_commit,
        {
            "buildExitCode": 0,
            "probeExitCode": 0,
            "sourceBeforeSha256": before,
            "sourceAfterSha256": after,
        },
    )
    # This one generated reusable input record is renewed only after completion.
    path = Path(proof_path)
    if path.exists():
        regular(path)
        require(path.stat().st_size <= MAX_JSON)
        path.unlink()
    write_json(path, proof)


def verify_sidecar(repo, target, binary, proof):
    require(target in SIDECAR_TARGETS)
    require(
        set(proof)
        == {
            "schemaVersion",
            "mode",
            "stage",
            "baseCommit",
            "sourceInventorySha256",
            "target",
            "sidecar",
            "producer",
            "invocation",
            "completion",
        }
    )
    require(
        type(proof["schemaVersion"]) is int
        and proof["schemaVersion"] == 1
        and proof["mode"] == "shipping"
        and proof["stage"] == "sidecar-input"
    )
    require(proof["target"] == target and proof["sourceInventorySha256"] == source_binding(repo))
    require(proof["sidecar"] == {"logicalResource": "evidenceloom-runner", **hash_file(binary)})
    require(sidecar_proof(repo, target, binary, proof["baseCommit"], proof["completion"]) == proof)


def prepare_shipping(
    repo,
    directory,
    target,
    base_commit,
    sidecar,
    sidecar_input,
    overlay,
    typed_config,
    frontend_proof,
):
    repo, directory = Path(repo).resolve(strict=True), Path(directory)
    import desktop_frontend_evidence as frontend_evidence

    frontend_evidence.reject_shipping_selector(os.environ)
    frontend_evidence.verify_frontend_proof(frontend_proof, "normal", repo / "frontend/out")
    verify_sidecar(repo, target, sidecar, load_json(sidecar_input))
    require(load_json(sidecar_input)["baseCommit"] == base_commit)
    require(not directory.exists())
    directory.mkdir(parents=True)
    config = load_json(typed_config)
    # build.rs recomputes from the actual SDK-parsed raw overlay at real compile.
    reject_acceptance_config(config)
    frontend = repo / "frontend/out"
    records = inventory(frontend, tree_names(frontend))
    require(not any(any(term in entry["path"] for term in FORBIDDEN) for entry in records))
    source = inventory(repo, source_names(repo))
    acl = acl_inventory(repo)
    stamp = {
        "schemaVersion": 1,
        "mode": "shipping",
        "stage": "app",
        "buildId": "0" * 64,
        "baseCommit": base_commit,
        "sourceInventorySha256": digest(canonical(source)),
        "target": target,
        "enabledFeatures": [],
        "signingPolicy": "platform",
        "permittedOwnedParent": "",
        "effectiveConfigSha256": hash_file(typed_config)["sha256"],
        "aclInventorySha256": digest(canonical(acl)),
        "frontendInputInventorySha256": digest(canonical(records)),
        "frontendInventorySha256": digest(canonical(records)),
        "cargoLockSha256": hash_file(repo / "src-tauri/Cargo.lock")["sha256"],
        "frontendLockSha256": hash_file(repo / "frontend/package-lock.json")["sha256"],
        "fixture": None,
    }
    stamp["buildId"] = build_id(stamp)
    validate_stamp(stamp, shipping=True)
    for name, value in [
        ("source-inventory.json", source),
        ("acl-inventory.json", acl),
        ("frontend-input-inventory.json", records),
        ("frontend-inventory.json", records),
        ("desktop-build-stamp.json", stamp),
        ("effective-config.json", config),
    ]:
        write_json(directory / name, value)
    write_json(directory / "sidecar-input.json", load_json(sidecar_input))
    shutil.copyfile(regular(frontend_proof), directory / "frontend-proof.json")
    write_json(
        directory / "frontend-proof-origin.json",
        {"path": str(Path(frontend_proof).resolve(strict=True))},
    )
    frontend_evidence.freeze_files(
        repo, [row["path"] for row in source], directory / "source-input-bytes"
    )
    write_json(directory / "source-proof-origin.json", {"path": str(repo)})
    proof_names = [path.name for path in directory.iterdir() if path.is_file()]
    proof_records = inventory(directory, sorted(proof_names))
    frontend_evidence.freeze_files(directory, sorted(proof_names), directory / "stage-proof-bytes")
    write_json(directory / "stage-proof-inventory.json", proof_records)
    return stamp


def reject_acceptance_config(config):
    require(config.get("identifier") == "io.github.simonguo.evidenceloom")
    require("desktop-acceptance" not in json.dumps(config))
    require(config["bundle"].get("externalBin") == ["binaries/evidenceloom-runner"])
    require(config["build"].get("frontendDist") == "../frontend/out")


def hash_artifact(path):
    path = Path(path)
    if path.is_dir():
        records = inventory(path, tree_names(path))
        size = sum(item["bytes"] for item in records)
        require(0 < size <= MAX_PACKAGE)
        return {"bytes": size, "sha256": digest(canonical(records))}
    return hash_file(path)


def contains_bytes(path, needle):
    tail = b""
    with regular(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            data = tail + block
            if needle in data:
                return True
            tail = data[-max(1, len(needle) - 1) :]
    return False


def seal_build(directory, executable, bundle=None):
    """Record input and observed output of the fixed, trusted build pipeline.

    This is not a stand-alone cryptographic origin check for arbitrary app trees.
    Tauri can re-sign a copied macOS runner. Its produced bytes must be recorded
    separately from the normal builder's pre-packaging input; the entire app's
    actual inventory remains sealed in artifacts.
    """
    directory = Path(directory)
    import desktop_frontend_evidence as frontend_evidence

    frontend_evidence.reject_shipping_selector(os.environ)
    stamp = validate_stamp(load_json(directory / "desktop-build-stamp.json"), shipping=True)
    if bundle:
        require("apple-darwin" in stamp["target"])
        require(
            Path(executable).resolve()
            == (Path(bundle) / "Contents/MacOS/evidenceloom-desktop").resolve()
        )
    proof_records = load_json(directory / "stage-proof-inventory.json")
    frontend_evidence.verify_frozen(directory, directory / "stage-proof-bytes", proof_records)
    source_root = load_json(directory / "source-proof-origin.json")["path"]
    frontend_evidence.verify_frozen(
        source_root,
        directory / "source-input-bytes",
        load_json(directory / "source-inventory.json"),
    )
    original_frontend_proof = load_json(directory / "frontend-proof-origin.json")["path"]
    frontend_evidence.same_bytes(original_frontend_proof, directory / "frontend-proof.json")
    frontend_evidence.verify_frontend_proof(original_frontend_proof, "normal")
    # The native entry point retains and uses these exact compiled bytes.
    require(contains_bytes(executable, canonical(stamp)))
    require(not any(contains_bytes(executable, term.encode()) for term in FORBIDDEN))
    output = Path(bundle) if bundle else Path(executable)
    packaged_sidecar = None
    transformation = (
        "not-observed-in-installer"
        if "windows" in stamp["target"]
        else "not-observed-in-application-output"
    )
    if bundle:
        require("apple-darwin" in stamp["target"])
        require(
            Path(executable).resolve() == (output / "Contents/MacOS/evidenceloom-desktop").resolve()
        )
        runner = output / "Contents/MacOS/evidenceloom-runner"
        packaged_sidecar = {"logicalResource": "evidenceloom-runner", **hash_file(runner)}
        transformation = "tauri-macos-copy-with-possible-signing"
        require(not any(contains_bytes(runner, term.encode()) for term in FORBIDDEN))
        require(not any(any(term in name for term in FORBIDDEN) for name in tree_names(output)))
    proof = {
        **stamp,
        "deliveryChannel": "normal",
        "sidecar": load_json(directory / "sidecar-input.json")["sidecar"],
        "sidecarRole": "normal-build-input-before-tauri-packaging",
        "sidecarInputProofSha256": hash_file(directory / "sidecar-input.json")["sha256"],
        "packagedSidecar": packaged_sidecar,
        "sidecarTransformation": transformation,
        "artifacts": [
            {
                "logicalName": output.name,
                "kind": "application",
                **hash_artifact(output),
                "parentProofSha256": hash_file(directory / "desktop-build-stamp.json")["sha256"],
            }
        ],
    }
    write_json(directory / "build-proof.json", proof)
    return proof


def validate_proof(proof):
    require(
        isinstance(proof, dict)
        and set(proof)
        == STAMP_KEYS
        | {
            "deliveryChannel",
            "sidecar",
            "sidecarRole",
            "sidecarInputProofSha256",
            "packagedSidecar",
            "sidecarTransformation",
            "artifacts",
        }
    )
    validate_stamp({key: proof[key] for key in STAMP_KEYS}, shipping=True)
    require(proof["deliveryChannel"] in ("normal", "unsigned-test"))
    sidecar = proof["sidecar"]
    require(isinstance(sidecar, dict) and set(sidecar) == {"logicalResource", "sha256", "bytes"})
    require(
        sidecar["logicalResource"] == "evidenceloom-runner"
        and isinstance(sidecar["sha256"], str)
        and HEX64.fullmatch(sidecar["sha256"])
    )
    require(type(sidecar["bytes"]) is int and 0 < sidecar["bytes"] <= MAX_PACKAGE)
    require(proof["sidecarRole"] == "normal-build-input-before-tauri-packaging")
    require(
        isinstance(proof["sidecarInputProofSha256"], str)
        and HEX64.fullmatch(proof["sidecarInputProofSha256"])
    )
    packaged = proof["packagedSidecar"]
    if packaged is None:
        require(
            proof["sidecarTransformation"]
            == (
                "not-observed-in-installer"
                if "windows" in proof["target"]
                else "not-observed-in-application-output"
            )
        )
    else:
        require("apple-darwin" in proof["target"] and isinstance(packaged, dict))
        require(set(packaged) == {"logicalResource", "bytes", "sha256"})
        require(packaged["logicalResource"] == "evidenceloom-runner")
        require(type(packaged["bytes"]) is int and 0 < packaged["bytes"] <= MAX_PACKAGE)
        require(isinstance(packaged["sha256"], str) and HEX64.fullmatch(packaged["sha256"]))
        require(proof["sidecarTransformation"] == "tauri-macos-copy-with-possible-signing")
    artifacts = proof["artifacts"]
    require(isinstance(artifacts, list) and 0 < len(artifacts) <= MAX_ARTIFACTS)
    names = []
    for item in artifacts:
        require(set(item) == {"logicalName", "kind", "bytes", "sha256", "parentProofSha256"})
        relative_name(item["logicalName"])
        require(
            "/" not in item["logicalName"]
            and not any(term in item["logicalName"] for term in FORBIDDEN)
        )
        require(item["kind"] in ("application", "package", "supporting"))
        require(type(item["bytes"]) is int and 0 < item["bytes"] <= MAX_PACKAGE)
        require(HEX64.fullmatch(item["sha256"]) and HEX64.fullmatch(item["parentProofSha256"]))
        names.append(item["logicalName"])
    require(len({name.casefold() for name in names}) == len(names))
    return proof


def seal_package(parent_path, artifact, output, channel):
    parent = validate_proof(load_json(parent_path))
    require(channel in ("normal", "unsigned-test"))
    proof = {
        **parent,
        "deliveryChannel": channel,
        "artifacts": [
            {
                "logicalName": Path(artifact).name,
                "kind": "package",
                **hash_file(artifact),
                "parentProofSha256": hash_file(parent_path)["sha256"],
            }
        ],
    }
    validate_proof(proof)
    write_json(output, proof)


def guard(proof_path, artifacts):
    proof = validate_proof(load_json(proof_path))
    names = {Path(path).name: Path(path) for path in artifacts}
    require(len(names) == len(artifacts) == len(proof["artifacts"]))
    for item in proof["artifacts"]:
        require(item["logicalName"] in names)
        require(
            hash_artifact(names[item["logicalName"]])
            == {"bytes": item["bytes"], "sha256": item["sha256"]}
        )
    return proof


def seal_batch(directory, proof_paths, output):
    """Bind both platform proofs; inherited observations describe only target.

    The batch keeps the first parent's target and sidecar metadata. It does not
    assert that its observation describes the other architecture. Every asset's
    parent digest also binds the two independent platform proof files.
    """
    directory = Path(directory)
    require(len(proof_paths) == 2)
    proofs = [validate_proof(load_json(path)) for path in proof_paths]
    require({proof["target"] for proof in proofs} == set(MACOS_RELEASE_TARGETS))
    # Platform config/frontend outputs can differ; source commit/locks must agree.
    for key in ("baseCommit", "sourceInventorySha256", "cargoLockSha256", "frontendLockSha256"):
        require(proofs[0][key] == proofs[1][key])
    require(
        all(
            proof["deliveryChannel"] == "normal" and len(proof["artifacts"]) == 1
            for proof in proofs
        )
    )
    expected = {proof["artifacts"][0]["logicalName"] for proof in proofs}
    require(len(expected) == 2 and all(name.endswith(".dmg") for name in expected))
    expected |= {
        "LICENSE",
        "NOTICE",
        "THIRD_PARTY_NOTICES.md",
        "evidenceloom.spdx.json",
        "SHA256SUMS",
    }
    require(set(tree_names(directory)) == expected)
    for path, proof in zip(proof_paths, proofs):
        guard(path, [directory / proof["artifacts"][0]["logicalName"]])
    parent_digest = digest(canonical(sorted(hash_file(path)["sha256"] for path in proof_paths)))
    batch = {
        **proofs[0],
        "artifacts": [
            {
                "logicalName": name,
                "kind": "package" if name.endswith(".dmg") else "supporting",
                **hash_file(directory / name),
                "parentProofSha256": parent_digest,
            }
            for name in sorted(expected)
        ],
    }
    write_json(output, batch)


def remote_guard(proof_path, listing_path, downloaded):
    proof = validate_proof(load_json(proof_path))
    listing = load_json(listing_path)
    require(isinstance(listing, dict) and isinstance(listing.get("assets"), list))
    require(listing.get("isDraft") is True)
    expected = {item["logicalName"] for item in proof["artifacts"]}
    names = [item.get("name") for item in listing["assets"]]
    require(len(names) == len(expected) and set(names) == expected)
    guard(proof_path, [Path(downloaded) / name for name in names])
    require(set(tree_names(downloaded)) == expected)


def remote_set(proof_path, listing_path):
    proof = validate_proof(load_json(proof_path))
    listing = load_json(listing_path)
    require(
        isinstance(listing, dict)
        and listing.get("isDraft") is True
        and isinstance(listing.get("assets"), list)
    )
    expected = {item["logicalName"] for item in proof["artifacts"]}
    names = [item.get("name") for item in listing["assets"]]
    require(len(names) == len(set(names)) and set(names) <= expected)


def main():
    require("EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY" not in os.environ)
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    for command in ("build-shipping-sidecar", "sidecar-check", "prepare-shipping"):
        p = subs.add_parser(command)
        for name in ("repo", "target", "binary", "proof"):
            p.add_argument("--" + name, required=True)
        if command != "sidecar-check":
            p.add_argument("--base-commit", required=True)
        if command == "prepare-shipping":
            p.add_argument("--directory", required=True)
            p.add_argument("--overlay")
            p.add_argument("--typed-config", required=True)
            p.add_argument("--frontend-proof", required=True)
        elif command == "build-shipping-sidecar":
            p.add_argument("--python", required=True)
    p = subs.add_parser("seal-build")
    p.add_argument("--directory", required=True)
    p.add_argument("--executable", required=True)
    p.add_argument("--bundle")
    p = subs.add_parser("seal-package")
    for name in ("parent", "artifact", "output"):
        p.add_argument("--" + name, required=True)
    p.add_argument("--channel", choices=("normal", "unsigned-test"), default="normal")
    p = subs.add_parser("guard")
    p.add_argument("--proof", required=True)
    p.add_argument("artifacts", nargs="+")
    p = subs.add_parser("seal-batch")
    p.add_argument("--directory", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("proofs", nargs=2)
    p = subs.add_parser("remote-guard")
    for name in ("proof", "listing", "downloaded"):
        p.add_argument("--" + name, required=True)
    p = subs.add_parser("remote-set")
    p.add_argument("--proof", required=True)
    p.add_argument("--listing", required=True)
    args = parser.parse_args()
    try:
        if args.command == "build-shipping-sidecar":
            build_shipping_sidecar(
                args.repo, args.target, args.python, args.proof, args.base_commit
            )
        elif args.command == "sidecar-check":
            verify_sidecar(args.repo, args.target, args.binary, load_json(args.proof))
        elif args.command == "prepare-shipping":
            overlay = load_json(args.overlay) if args.overlay else {}
            prepare_shipping(
                args.repo,
                args.directory,
                args.target,
                args.base_commit,
                args.binary,
                args.proof,
                overlay,
                args.typed_config,
                args.frontend_proof,
            )
        elif args.command == "seal-build":
            seal_build(args.directory, args.executable, args.bundle)
        elif args.command == "seal-package":
            seal_package(args.parent, args.artifact, args.output, args.channel)
        elif args.command == "guard":
            guard(args.proof, args.artifacts)
        elif args.command == "seal-batch":
            seal_batch(args.directory, args.proofs, args.output)
        elif args.command == "remote-guard":
            remote_guard(args.proof, args.listing, args.downloaded)
        else:
            remote_set(args.proof, args.listing)
    except (
        BoundaryError,
        OSError,
        ValueError,
        KeyError,
        TypeError,
        RecursionError,
        subprocess.CalledProcessError,
    ):
        print("desktop_proof_invalid", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
