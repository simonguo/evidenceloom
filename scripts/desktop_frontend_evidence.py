"""Trusted builder's whole-registry closure and byte-preserving input/output gate.

No standalone origin certificate: reviewers bind these exact scripts and original
subprocess records. Read-only snapshots preserve bytes, not OS-level immutability.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import threading
import time

import check_desktop_acceptance_boundary as boundary

SELECTOR = "EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY"
METADATA = "EVIDENCELOOM_DESKTOP_FRONTEND_EVIDENCE_DIR"
NEXT_VERSION = "15.5.27"
WEBPACK_VERSION = "5.98.0"
REGISTRY_SCHEMA = "evidenceloom-desktop-frontend-compiler-evidence-v1"
MARKER = "evidenceloom-private-ui-driver-v1"
SOURCE_MAX = 16 * 1024 * 1024
ASSET_MAX = 64 * 1024 * 1024
TREE_MAX = 4 * 1024 * 1024 * 1024
REGISTRY_MAX = 1024 * 1024
RAW_MAX = 8 * 1024 * 1024


def physical(path, directory=False):
    path = Path(path)
    boundary.require(path.is_absolute() and path == Path(os.path.abspath(path)))
    for component in reversed([path, *path.parents]):
        metadata = component.lstat()
        boundary.require(not stat.S_ISLNK(metadata.st_mode))
        boundary.require(not getattr(metadata, "st_file_attributes", 0) & 0x400)
        boundary.require(
            stat.S_ISDIR(metadata.st_mode)
            if component != path or directory
            else stat.S_ISREG(metadata.st_mode)
        )
    boundary.require(path.resolve(strict=True) == path)
    return path


def private_directory(path, fresh=False):
    path = physical(path, True)
    info = path.stat()
    boundary.require(stat.S_IMODE(info.st_mode) == 0o700)
    boundary.require(not hasattr(os, "getuid") or info.st_uid == os.getuid())
    if fresh:
        boundary.require(not any(path.iterdir()))
    return path


def compiler_directory_binding(metadata):
    directory = private_directory(Path(metadata) / "compiler")
    info = directory.stat()
    return {"path": str(directory), "device": info.st_dev, "inode": info.st_ino}


def read_bytes(path, maximum=REGISTRY_MAX):
    path = physical(path)
    before = path.stat()
    boundary.require(before.st_size <= maximum)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    with os.fdopen(os.open(path, flags), "rb") as stream:
        opened = os.fstat(stream.fileno())
        boundary.require(
            (before.st_dev, before.st_ino, before.st_size)
            == (opened.st_dev, opened.st_ino, opened.st_size)
        )
        raw = stream.read(maximum + 1)
        after = os.fstat(stream.fileno())
    final = path.stat()

    def identity(item):
        return (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)

    boundary.require(
        identity(opened) == identity(after) == identity(final) and len(raw) == before.st_size
    )
    return raw


def same_bytes(left, right, maximum=TREE_MAX):
    left, right = physical(left), physical(right)
    before = [item.stat() for item in (left, right)]
    boundary.require(before[0].st_size == before[1].st_size <= maximum)
    with left.open("rb") as a, right.open("rb") as b:
        total = 0
        while True:
            x, y = a.read(65536), b.read(65536)
            boundary.require(x == y)
            total += len(x)
            boundary.require(total <= maximum)
            if not x:
                break
    for path, original in zip((left, right), before, strict=True):
        now = path.stat()
        boundary.require(
            (
                original.st_dev,
                original.st_ino,
                original.st_size,
                original.st_mtime_ns,
                original.st_ctime_ns,
            )
            == (now.st_dev, now.st_ino, now.st_size, now.st_mtime_ns, now.st_ctime_ns)
        )


def freeze_files(root, names, destination, maximum=TREE_MAX):
    root = physical(root, True)
    destination = Path(destination)
    physical(destination.parent, True)
    boundary.require(not destination.exists() and not destination.is_symlink())
    records = boundary.inventory(root, names)
    boundary.require(records and sum(row["bytes"] for row in records) <= maximum)
    destination.mkdir(mode=0o700)
    for row in records:
        source = physical(root / row["path"])
        copy = destination / row["path"]
        copy.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(source, copy)
        copy.chmod(0o555 if source.stat().st_mode & 0o111 else 0o444)
        same_bytes(source, copy, maximum)
    boundary.require(boundary.inventory(destination, names) == records)
    return records


def verify_frozen(root, snapshot, records, exact_tree=False):
    root, snapshot = physical(root, True), physical(snapshot, True)
    names = [row["path"] for row in records]
    if exact_tree:
        boundary.require(boundary.tree_names(root) == names == boundary.tree_names(snapshot))
    boundary.require(
        boundary.inventory(root, names) == records == boundary.inventory(snapshot, names)
    )
    for name in names:
        same_bytes(root / name, snapshot / name)


def reject_shipping_selector(environment):
    boundary.require(SELECTOR not in environment)


def frontend_inputs(frontend):
    frontend = physical(frontend, True)
    # Same real input closure as B source_names, including shared docs/fixtures.
    names = boundary.source_names(frontend.parent)
    return boundary.inventory(frontend.parent, names)


def backend_binding(frontend, node):
    frontend = physical(frontend, True)
    node = physical(node)
    names = (
        "node_modules/next/package.json",
        "node_modules/next/dist/bin/next",
        "node_modules/next/dist/build/index.js",
        "node_modules/next/dist/build/webpack-build/impl.js",
        "node_modules/next/dist/build/webpack-config.js",
        "node_modules/next/dist/build/compiler.js",
        "node_modules/next/dist/build/webpack-build/index.js",
        "node_modules/next/dist/compiled/webpack/webpack.js",
        "node_modules/next/dist/compiled/webpack/bundle5.js",
        "node_modules/next/dist/compiled/webpack/package.json",
        "package-lock.json",
    )
    rows = boundary.inventory(frontend, list(names))
    package = boundary.load_json(frontend / names[0])
    lock = boundary.load_json(frontend / "package-lock.json")
    boundary.require(package["version"] == NEXT_VERSION)
    boundary.require(lock["packages"]["node_modules/next"]["version"] == NEXT_VERSION)
    config = read_bytes(frontend / "next.config.mjs", SOURCE_MAX)
    boundary.require(
        b"webpackBuildWorker: false" in config
        and b"parallelServerCompiles: false" in config
        and b"parallelServerBuildTraces: false" in config
    )
    return {
        "nextVersion": NEXT_VERSION,
        "webpackVersion": WEBPACK_VERSION,
        "backend": "webpack",
        "buildWorker": False,
        "node": {"path": str(node), **boundary.hash_file(node)},
        "files": rows,
    }


def validate_registry(registry, frontend, mode, child_pid, backend):
    boundary.require(
        set(registry)
        == {
            "schema",
            "runId",
            "registryClosed",
            "compilerOwner",
            "proofBoundary",
            "persistedEvidence",
            "records",
        }
    )
    boundary.require(
        registry["schema"] == REGISTRY_SCHEMA
        and registry["registryClosed"] is False
        and registry["persistedEvidence"] is True
    )
    boundary.require(re.fullmatch(r"[a-f0-9]{32}", registry["runId"]) is not None)
    owner = registry["compilerOwner"]
    boundary.require(set(owner) == {"pid", "nodeVersion", "nextVersion", "backend", "buildWorker"})
    boundary.require(
        type(owner["pid"]) is int
        and owner["pid"] == child_pid
        and owner["backend"] == "webpack"
        and owner["nextVersion"] == backend["nextVersion"]
        and owner["buildWorker"] is False
    )
    boundary.require(re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", owner["nodeVersion"]) is not None)
    records = registry["records"]
    boundary.require(isinstance(records, list) and 1 <= len(records) <= 16)
    builds, versions, clients, servers = set(), set(), 0, 0
    neutral_replacements = 0
    for ordinal, record in enumerate(records, 1):
        boundary.require(
            record["callbackOrdinal"] == ordinal
            and record["selection"] == mode
            and record["dev"] is False
            and type(record["isServer"]) is bool
        )
        boundary.require(
            record["status"] == "complete"
            and record["compilerApplied"] is True
            and record["iteration"] == 1
            and record["webpackMode"] == "production"
        )
        boundary.require(
            record["nextRuntime"] in (None, "nodejs", "edge")
            and record["webpackVersion"] == WEBPACK_VERSION
        )
        boundary.require(
            record["buildId"]
            and record["compilationHash"]
            and [phase["phase"] for phase in record["phases"]] == ["finishModules", "done"]
        )
        builds.add(record["buildId"])
        versions.add(record["webpackVersion"])
        for field in ("configSource", "tsconfigSource", "selectedSource"):
            row = record[field]
            boundary.require(set(row) == {"sourcePath", "sourceSha256"})
            boundary.require(
                boundary.hash_file(physical(frontend / row["sourcePath"]))["sha256"]
                == row["sourceSha256"]
            )
        selected = (
            "src/features/desktop-acceptance/entry.tsx"
            if mode == "acceptance"
            else "src/features/desktop-verification/disabled.tsx"
        )
        boundary.require(record["selectedSource"]["sourcePath"] == selected)
        # Next injects an absolute physical client path from its server RSC graph;
        # that client resolution need not repeat the neutral specifier replacement.
        for field in ("replacements", "resolutions"):
            rows = record[field]
            boundary.require(type(rows) is list and len(rows) <= 256)
            keys = {"sourcePath", "sourceSha256"}
            keys.add("originalSpecifier" if field == "replacements" else "resourceSha256")
            for row in rows:
                boundary.require(type(row) is dict and set(row) == keys)
                boundary.require(
                    row["sourcePath"] == selected
                    and row["sourceSha256"] == record["selectedSource"]["sourceSha256"]
                )
                if field == "replacements":
                    boundary.require(row["originalSpecifier"] == "@desktop-verification-entry")
                else:
                    boundary.require(
                        type(row["resourceSha256"]) is str
                        and re.fullmatch(r"[a-f0-9]{64}", row["resourceSha256"]) is not None
                    )
            if field == "replacements":
                neutral_replacements += len(rows)
        boundary.require(not record["replacements"] or record["resolutions"])
        boundary.require(
            len(record["moduleRows"]) <= 256
            and record["assets"] is not None
            and record["emittedAssets"] is not None
        )
        for row in record["moduleRows"]:
            boundary.require(
                row["phase"] in ("finishModules", "done")
                and row["kind"] in ("physical-source", "identifier-reference")
            )
            boundary.require(
                boundary.hash_file(physical(frontend / row["sourcePath"]))["sha256"]
                == row["sourceSha256"]
            )
            boundary.require(
                not (
                    mode == "normal"
                    and row["sourcePath"].startswith("src/features/desktop-acceptance/")
                )
            )
            boundary.require(
                not (
                    mode == "acceptance"
                    and row["sourcePath"] == "src/features/desktop-verification/disabled.tsx"
                )
            )
        if record["isServer"]:
            servers += 1
        else:
            clients += 1
            required = [selected]
            if mode == "acceptance":
                required += [
                    "src/features/desktop-acceptance/lib/api.ts",
                    "src/features/desktop-acceptance/lib/driver.ts",
                ]
            for required_source in required:
                for phase in ("finishModules", "done"):
                    boundary.require(
                        any(
                            row["kind"] == "physical-source"
                            and row["sourcePath"] == required_source
                            and row["phase"] == phase
                            for row in record["moduleRows"]
                        )
                    )
            boundary.require(record["resolutions"])
        for field in ("assets", "emittedAssets"):
            asset = record[field]
            boundary.require(
                len(asset["rows"]) <= 10000
                and asset["totals"]["bytes"] <= 256 * 1024 * 1024
                and asset["totals"]["decodedBytes"] <= 256 * 1024 * 1024
            )
            boundary.require(
                mode != "normal" or not any(row["privateMarkerHits"] for row in asset["rows"])
            )
        if not record["isServer"] and mode == "acceptance":
            boundary.require(
                any(MARKER in row["privateMarkerHits"] for row in record["assets"]["rows"])
            )
    # Pinned Next 15.5.27 impl.js creates all three configurations via Promise.all
    # and runs server, edge server and client in this direct process. Missing a
    # callback is not excused by an apparently successful client or export.
    boundary.require(
        len(records) == 3 and clients == 1 and servers == 2 and len(builds) == len(versions) == 1
    )
    boundary.require(
        sum(record["isServer"] and record["nextRuntime"] == "nodejs" for record in records) == 1
    )
    boundary.require(
        sum(record["isServer"] and record["nextRuntime"] == "edge" for record in records) == 1
    )
    # The whole original build must actually consume the neutral entry at least
    # once, even when Next subsequently injects it as a physical client path.
    boundary.require(neutral_replacements > 0)
    return records


def raw_output_sizes(directory, label):
    """Observe actual regular raw files, never infer their bytes from child exit."""
    directory = physical(directory, True)
    return {
        name: physical(directory / (label + "." + name)).stat().st_size
        for name in ("stdout", "stderr")
    }


class SupervisorTerminated(Exception):
    """A local entrypoint SIGTERM request; never a success/certificate."""


def supervised_entrypoint(main):
    """Install only for an actual main-thread CLI call; imports change no signals."""
    boundary.require(threading.current_thread() is threading.main_thread())
    previous = signal.getsignal(signal.SIGTERM)

    def terminated(_number, _frame):
        raise SupervisorTerminated()

    try:
        signal.signal(signal.SIGTERM, terminated)
        return main()
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except SupervisorTerminated:
        raise SystemExit(143) from None
    finally:
        signal.signal(signal.SIGTERM, previous)


def cleanup_original_child(child, wait_observed, return_code):
    """Best-effort failure cleanup of the retained original; group truth unknown."""
    facts = {
        "actualDirectWaitObserved": wait_observed,
        "killAttempted": False,
        "pollError": False,
        "killError": False,
        "waitError": None,
        "processGroupCleanup": "unknown",
    }
    if child is None or wait_observed:
        return False, return_code, facts
    pending_interrupt = None
    try:
        running = child.poll() is None
    except (KeyboardInterrupt, SupervisorTerminated) as interrupt:
        pending_interrupt = interrupt
        facts["pollError"], running = True, True
    except Exception:
        facts["pollError"], running = True, True
    if running:
        facts["killAttempted"] = True
        try:
            if os.name != "nt":
                os.killpg(child.pid, signal.SIGKILL)
            else:
                child.kill()
        except (KeyboardInterrupt, SupervisorTerminated) as interrupt:
            if pending_interrupt is None:
                pending_interrupt = interrupt
            facts["killError"] = True
        except Exception:
            facts["killError"] = True
    # Even poll/kill error cannot skip the actual same original bounded wait.
    try:
        return_code = child.wait(timeout=3)
        facts["actualDirectWaitObserved"] = True
    except (KeyboardInterrupt, SupervisorTerminated) as interrupt:
        if pending_interrupt is None:
            pending_interrupt = interrupt
        return_code, facts["waitError"] = None, "interrupted"
    except subprocess.TimeoutExpired:
        return_code, facts["waitError"] = None, "timeout"
    except Exception:
        return_code, facts["waitError"] = None, "error"
    if pending_interrupt is not None:
        raise pending_interrupt
    return facts["killAttempted"], return_code, facts


def best_effort_failure_json(path, document):
    try:
        boundary.write_json(path, document)
        return True
    except (KeyboardInterrupt, SupervisorTerminated):
        raise
    except Exception:
        return False


def observed_failure_sizes(directory, label):
    try:
        return raw_output_sizes(directory, label)
    except (KeyboardInterrupt, SupervisorTerminated):
        raise
    except Exception:
        return None


def run_child(argv, cwd, environment, directory, label, deadline_seconds):
    """Every post-Popen path retains cleanup; interruption never certifies exit."""
    directory = physical(directory, True)
    started = time.monotonic()
    child, result, wait_observed, completed = None, None, False, False
    reason = "producer_error"
    try:
        with (
            (directory / (label + ".stdout")).open("xb") as stdout,
            (directory / (label + ".stderr")).open("xb") as stderr,
        ):
            child = subprocess.Popen(
                argv,
                cwd=cwd,
                env=environment,
                stdout=stdout,
                stderr=stderr,
                start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
            )
            boundary.write_json(
                directory / (label + "-start.json"),
                {
                    "argv": argv,
                    "cwd": str(cwd),
                    "pid": child.pid,
                    "newProcessGroup": True,
                    "environment": environment,
                },
            )
            while child.poll() is None:
                if time.monotonic() - started >= deadline_seconds:
                    reason = "deadline"
                    raise boundary.BoundaryError("desktop_proof_invalid")
                if any(size > RAW_MAX for size in raw_output_sizes(directory, label).values()):
                    reason = "raw_output_limit"
                    raise boundary.BoundaryError("desktop_proof_invalid")
                time.sleep(0.1)
            result = child.wait(timeout=0)
            wait_observed = True
        # Required last-poll gates are unchanged; zero wait does not override.
        raw_sizes = raw_output_sizes(directory, label)
        elapsed = time.monotonic() - started
        terminal = {
            "pid": child.pid,
            "returnCode": result,
            "seconds": elapsed,
            "actualDirectWait": True,
            "rawOutputBytes": raw_sizes,
        }
        terminal_reason = (
            "raw_output_limit"
            if any(size > RAW_MAX for size in raw_sizes.values())
            else "deadline"
            if elapsed > deadline_seconds
            else None
        )
        if terminal_reason is not None:
            reason = terminal_reason
            raise boundary.BoundaryError("desktop_proof_invalid")
        if result != 0:
            reason = "producer_exit_failed"
            raise boundary.BoundaryError("desktop_proof_invalid")
        boundary.write_json(directory / (label + "-terminal.json"), terminal)
        completed = True
        return child.pid
    except KeyboardInterrupt:
        reason = "supervisor_keyboard_interrupt"
        raise
    except SupervisorTerminated:
        reason = "supervisor_sigterm"
        raise
    except subprocess.TimeoutExpired:
        reason = "deadline"
        raise boundary.BoundaryError("desktop_proof_invalid") from None
    finally:
        # SystemExit and unknown exceptions keep their original propagation,
        # after the same bounded owned-handle attempt. No broad exception catch.
        if not completed:
            intervention, result, cleanup = cleanup_original_child(child, wait_observed, result)
            raw_sizes = observed_failure_sizes(directory, label)
            best_effort_failure_json(
                directory / (label + "-failure.json"),
                {
                    "reason": reason,
                    "pid": None if child is None else child.pid,
                    "directReturnCode": result,
                    "rawOutputBytes": raw_sizes,
                    "seconds": time.monotonic() - started,
                    "cleanup": cleanup,
                    "launcherIntervened": intervention,
                    "processGroupCleanup": "unknown",
                    "certificate": False,
                },
            )


def scanner_inventory(records):
    return [
        {"relativePath": row["path"], "bytes": row["bytes"], "sha256": row["sha256"]}
        for row in records
    ]


def seal_export(frontend, metadata, mode, node, environment, registry, terminal, backend):
    output = physical(frontend / "out", True)
    records = boundary.inventory(output, boundary.tree_names(output))
    rows = scanner_inventory(records)
    digest = boundary.digest(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode())
    request = {
        "outputDirectory": str(output),
        "inventory": rows,
        "expectedInventorySha256": digest,
        "expectedSelection": mode,
    }
    ordinal = len(list(metadata.glob("scan-request-*.json"))) + 1
    request_path = metadata / f"scan-request-{ordinal}.json"
    scan_path = metadata / f"export-scan-{ordinal}.json"
    boundary.write_json(request_path, request)
    scan_environment = dict(environment)
    scan_environment.pop(METADATA, None)
    adapter = (
        physical(frontend.parent / "native-source/scripts/desktop_frontend_evidence.mjs")
        if (frontend.parent / "native-source").exists()
        else physical(frontend.parent / "scripts/desktop_frontend_evidence.mjs")
    )
    run_child(
        [
            str(node),
            str(adapter),
            str(frontend / "next.config.mjs"),
            str(request_path),
            str(scan_path),
        ],
        frontend,
        scan_environment,
        metadata,
        f"scan-{ordinal}",
        60,
    )
    scan = boundary.load_json(scan_path)
    boundary.require(
        scan["schema"] == "evidenceloom-desktop-frontend-export-scan-v1"
        and scan["selection"] == mode
        and scan["inventorySha256"] == digest
    )
    boundary.require(
        [row["relativePath"] for row in scan["rows"]] == [row["path"] for row in records]
    )
    if mode == "acceptance":
        boundary.require(any(MARKER in row["privateMarkerHits"] for row in scan["rows"]))
    else:
        boundary.require(not any(row["privateMarkerHits"] for row in scan["rows"]))
    snapshot = metadata / f"export-bytes-{ordinal}"
    freeze_files(output, [row["path"] for row in records], snapshot, 256 * 1024 * 1024)
    verify_frozen(output, snapshot, records, exact_tree=True)
    proof = {
        "schemaVersion": 1,
        "mode": mode,
        "registryClosed": True,
        "terminal": terminal,
        "backend": backend,
        "outputDirectory": str(output),
        "outputSnapshot": str(snapshot),
        "inventory": records,
        "scanPath": str(scan_path),
        "scanRequest": str(request_path),
        "scanOrdinal": ordinal,
        "compilerMetadata": boundary.load_json(metadata / "compiler-directory.json"),
        "rawRegistryFile": str(metadata / "compiler/compiler-records.json"),
        "rawRegistrySha256": boundary.hash_file(metadata / "compiler/compiler-records.json")[
            "sha256"
        ],
        "inputRoot": str(frontend.parent),
        "inputSnapshot": str(metadata / "input-bytes"),
        "inputs": boundary.load_json(metadata / "frontend-input-inventory.json"),
        "proofBoundary": "trusted retained subprocess and exact byte snapshots; not standalone hostile-origin certification",
    }
    path = metadata / f"frontend-proof-{ordinal}.json"
    boundary.write_json(path, proof)
    scan_names = [
        request_path.name,
        scan_path.name,
        path.name,
        f"scan-{ordinal}.stdout",
        f"scan-{ordinal}.stderr",
        f"scan-{ordinal}-start.json",
        f"scan-{ordinal}-terminal.json",
    ]
    freeze_files(metadata, scan_names, metadata / f"scan-proof-bytes-{ordinal}")
    return path


def run_frontend(frontend, evidence_parent, mode, environment, deadline_seconds=300):
    boundary.require(
        mode in ("normal", "acceptance")
        and type(deadline_seconds) is int
        and 1 <= deadline_seconds <= 300
    )
    if mode == "normal":
        reject_shipping_selector(environment)
    frontend = physical(frontend, True)
    evidence_parent = physical(evidence_parent, True)
    boundary.require(frontend != evidence_parent and frontend not in evidence_parent.parents)
    metadata = evidence_parent / ("frontend-evidence-" + os.urandom(16).hex())
    metadata.mkdir(mode=0o700)
    private_directory(metadata, fresh=True)
    compiler_metadata = metadata / "compiler"
    compiler_metadata.mkdir(mode=0o700)
    private_directory(compiler_metadata, fresh=True)
    compiler_binding = compiler_directory_binding(metadata)
    boundary.write_json(metadata / "compiler-directory.json", compiler_binding)
    node_name = shutil.which("node", path=environment["PATH"])
    boundary.require(node_name is not None)
    node = Path(node_name).resolve(strict=True)
    backend = backend_binding(frontend, node)
    inputs = frontend_inputs(frontend)
    freeze_files(frontend.parent, [row["path"] for row in inputs], metadata / "input-bytes")
    boundary.write_json(metadata / "frontend-input-inventory.json", inputs)
    env = dict(environment)
    boundary.require(
        METADATA not in env and "NEXT_RSPACK" not in env and "NEXT_PRIVATE_LOCAL_WEBPACK" not in env
    )
    env[METADATA], env["TAURI"], env["NEXT_TELEMETRY_DISABLED"] = str(compiler_metadata), "1", "1"
    if mode == "acceptance":
        boundary.require(SELECTOR not in env)
        env[SELECTOR] = "acceptance"
    # Direct Node/Next CLI, avoiding npm/shell ancestor IDs as compiler ownership.
    pid = run_child(
        [str(node), str(frontend / "node_modules/next/dist/bin/next"), "build"],
        frontend,
        env,
        metadata,
        "next",
        deadline_seconds,
    )
    terminal = boundary.load_json(metadata / "next-terminal.json")
    boundary.require(compiler_directory_binding(metadata) == compiler_binding)
    registry = boundary.load_json(compiler_metadata / "compiler-records.json")
    validate_registry(registry, frontend, mode, pid, backend)
    compiler_names = [
        "compiler/compiler-records.json",
        "compiler-directory.json",
        "next-start.json",
        "next-terminal.json",
        "next.stdout",
        "next.stderr",
    ]
    freeze_files(metadata, compiler_names, metadata / "compiler-proof-bytes")
    boundary.require(backend_binding(frontend, node) == backend)
    freeze_files(
        frontend,
        [row["path"] for row in backend["files"]],
        metadata / "backend-bytes",
        256 * 1024 * 1024,
    )
    verify_frozen(frontend.parent, metadata / "input-bytes", inputs)
    return seal_export(frontend, metadata, mode, node, env, registry, terminal, backend)


def reseal_acceptance(proof_path):
    proof = load_closed_proof(proof_path)
    boundary.require(proof["mode"] == "acceptance" and proof["registryClosed"] is True)
    frontend = Path(proof["outputDirectory"]).parent
    metadata = Path(proof_path).parent
    env = boundary.load_json(metadata / "next-start.json")["environment"]
    validate_registry(
        proof["registry"], frontend, "acceptance", proof["terminal"]["pid"], proof["backend"]
    )
    verify_frozen(proof["inputRoot"], proof["inputSnapshot"], proof["inputs"])
    # Only the fixed handshake asset may be added after successful export.
    expected = [row["path"] for row in proof["inventory"]]
    boundary.require(
        boundary.tree_names(frontend / "out")
        == sorted(expected + ["desktop-acceptance-build.json"])
    )
    for name in expected:
        same_bytes(frontend / "out" / name, Path(proof["outputSnapshot"]) / name)
    return seal_export(
        frontend,
        metadata,
        "acceptance",
        Path(proof["backend"]["node"]["path"]),
        env,
        proof["registry"],
        proof["terminal"],
        proof["backend"],
    )


def load_closed_proof(proof_path):
    proof_path = physical(proof_path)
    proof = boundary.load_json(proof_path)
    for name in (
        "compiler/compiler-records.json",
        "compiler-directory.json",
        "next-start.json",
        "next-terminal.json",
        "next.stdout",
        "next.stderr",
    ):
        same_bytes(proof_path.parent / name, proof_path.parent / "compiler-proof-bytes" / name)
    ordinal = proof["scanOrdinal"]
    boundary.require(type(ordinal) is int and 1 <= ordinal <= 2)
    for name in (
        f"scan-request-{ordinal}.json",
        f"export-scan-{ordinal}.json",
        proof_path.name,
        f"scan-{ordinal}.stdout",
        f"scan-{ordinal}.stderr",
        f"scan-{ordinal}-start.json",
        f"scan-{ordinal}-terminal.json",
    ):
        same_bytes(
            proof_path.parent / name, proof_path.parent / f"scan-proof-bytes-{ordinal}" / name
        )
    boundary.require(
        boundary.load_json(proof_path.parent / "next-terminal.json") == proof["terminal"]
    )
    compiler_binding = boundary.load_json(proof_path.parent / "compiler-directory.json")
    boundary.require(
        proof["compilerMetadata"]
        == compiler_binding
        == compiler_directory_binding(proof_path.parent)
    )
    boundary.require(
        boundary.load_json(proof_path.parent / "next-start.json")["environment"][METADATA]
        == compiler_binding["path"]
    )
    boundary.require(
        proof["rawRegistryFile"] == str(proof_path.parent / "compiler/compiler-records.json")
    )
    boundary.require(proof["scanPath"] == str(proof_path.parent / f"export-scan-{ordinal}.json"))
    boundary.require(
        proof["scanRequest"] == str(proof_path.parent / f"scan-request-{ordinal}.json")
    )
    boundary.require(proof["inputSnapshot"] == str(proof_path.parent / "input-bytes"))
    boundary.require(proof["outputSnapshot"] == str(proof_path.parent / f"export-bytes-{ordinal}"))
    proof["registry"] = boundary.load_json(proof["rawRegistryFile"])
    proof["scan"] = boundary.load_json(proof["scanPath"])
    return proof


def verify_frontend_proof(proof_path, mode, output=None):
    proof_path = physical(proof_path)
    proof = load_closed_proof(proof_path)
    boundary.require(
        proof["schemaVersion"] == 1 and proof["mode"] == mode and proof["registryClosed"] is True
    )
    boundary.require(
        proof["terminal"]["returnCode"] == 0 and proof["terminal"]["actualDirectWait"] is True
    )
    frontend = Path(proof["outputDirectory"]).parent
    validate_registry(proof["registry"], frontend, mode, proof["terminal"]["pid"], proof["backend"])
    boundary.require(
        boundary.hash_file(proof["rawRegistryFile"])["sha256"] == proof["rawRegistrySha256"]
    )
    boundary.require(boundary.load_json(proof["rawRegistryFile"]) == proof["registry"])
    boundary.require(
        backend_binding(frontend, Path(proof["backend"]["node"]["path"])) == proof["backend"]
    )
    verify_frozen(frontend, proof_path.parent / "backend-bytes", proof["backend"]["files"])
    verify_frozen(proof["inputRoot"], proof["inputSnapshot"], proof["inputs"])
    verify_frozen(
        proof["outputDirectory"], proof["outputSnapshot"], proof["inventory"], exact_tree=True
    )
    if output is not None:
        verify_frozen(output, proof["outputSnapshot"], proof["inventory"], exact_tree=True)
    scan = proof["scan"]
    boundary.require(scan["selection"] == mode and len(scan["rows"]) == len(proof["inventory"]))
    for row, original in zip(scan["rows"], proof["inventory"], strict=True):
        boundary.require(
            {"path": row["relativePath"], "bytes": row["bytes"], "sha256": row["sha256"]}
            == original
        )
    boundary.require(mode != "normal" or not any(row["privateMarkerHits"] for row in scan["rows"]))
    boundary.require(
        mode != "acceptance" or any(MARKER in row["privateMarkerHits"] for row in scan["rows"])
    )
    return proof


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frontend", required=True)
    parser.add_argument("--evidence-parent", required=True)
    parser.add_argument("--receipt-output", required=True)
    args = parser.parse_args()
    reject_shipping_selector(os.environ)
    boundary.require(
        METADATA not in os.environ
        and "NEXT_RSPACK" not in os.environ
        and "NEXT_PRIVATE_LOCAL_WEBPACK" not in os.environ
    )
    # Shipping wrappers retain their existing explicit tool environment. These
    # receipts may contain tool/home paths, never provider keys; no env dump.
    allowed = {
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SystemRoot",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "NEXT_TELEMETRY_DISABLED",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    proof = run_frontend(Path(args.frontend), Path(args.evidence_parent), "normal", environment)
    boundary.write_json(args.receipt_output, {"frontendProof": str(proof)})


if __name__ == "__main__":
    try:
        supervised_entrypoint(main)
    except (
        boundary.BoundaryError,
        OSError,
        ValueError,
        KeyError,
        TypeError,
        subprocess.SubprocessError,
    ):
        raise SystemExit("desktop_proof_invalid") from None
