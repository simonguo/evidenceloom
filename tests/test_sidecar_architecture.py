"""Native executable headers and real build-script failure boundaries, offline."""

import os
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys

import pytest

from scripts.sidecar_architecture import (
    ArchitectureError,
    BinaryIdentity,
    TARGETS,
    binary_identity,
    validate_binary,
    validate_interpreter,
)

pytestmark = pytest.mark.unit
REPO = Path(__file__).resolve().parents[1]


def _macho(cpu, endian="<"):
    return struct.pack(endian + "IIIIIIII", 0xFEEDFACF, cpu, 0, 2, 0, 0, 0, 0)


def _elf(cpu, endian="<"):
    identification = b"\x7fELF" + bytes([2, 1 if endian == "<" else 2, 1, 0]) + bytes(8)
    return identification + struct.pack(
        endian + "HHIQQQIHHHHHH", 2, cpu, 1, 0x400000, 0, 0, 0, 64, 0, 0, 0, 0, 0
    )


def _pe(cpu):
    dos = bytearray(128)
    dos[:2] = b"MZ"
    struct.pack_into("<I", dos, 0x3C, 128)
    coff = struct.pack("<HHIIIHH", cpu, 0, 0, 0, 0, 240, 0x22)
    optional = struct.pack("<H", 0x20B) + bytes(238)
    return bytes(dos) + b"PE\x00\x00" + coff + optional


def _universal(*, wide=False, contradictory=False):
    slices = [_macho(0x01000007), _macho(0x0100000C)]
    size = 32 if wide else 20
    first = 8 + 2 * size
    second = first + len(slices[0])
    header = struct.pack(">II", 0xCAFEBABF if wide else 0xCAFEBABE, 2)
    entries = []
    for cpu, offset in ((0x01000007, first), (0x0100000C, second)):
        entries.append(
            struct.pack(
                ">IIQQII" if wide else ">IIIII", cpu, 0, offset, 32, 0, *([0] if wide else [])
            )
        )
    if contradictory:
        slices[1] = slices[0]
    return header + b"".join(entries) + b"".join(slices)


def _binary(path, system, architecture):
    cpu = {"x86_64": 0x01000007, "aarch64": 0x0100000C}[architecture]
    if system == "macos":
        payload = _macho(cpu)
    elif system == "windows":
        payload = _pe(0x8664 if architecture == "x86_64" else 0xAA64)
    else:
        payload = _elf(62 if architecture == "x86_64" else 183)
    path.write_bytes(payload)
    return path


@pytest.mark.parametrize("target", TARGETS)
def test_native_header_identifies_each_supported_release_target(tmp_path, target):
    system, architecture = TARGETS[target]
    path = _binary(tmp_path / "launcher", system, architecture)
    assert validate_binary(path, target) == BinaryIdentity(system, frozenset({architecture}))
    wrong = "aarch64" if architecture == "x86_64" else "x86_64"
    mismatch = next(t for t, identity in TARGETS.items() if identity == (system, wrong))
    with pytest.raises(ArchitectureError, match="architecture mismatch"):
        validate_binary(path, mismatch)


@pytest.mark.parametrize("payload", [_macho(0x01000007, ">"), _elf(183, ">")])
def test_big_endian_headers_are_read_without_host_endian_assumptions(tmp_path, payload):
    path = tmp_path / "launcher"
    path.write_bytes(payload)
    assert binary_identity(path).architectures in (frozenset({"x86_64"}), frozenset({"aarch64"}))


@pytest.mark.parametrize("wide", [False, True])
def test_universal_macho_validates_actual_slices_for_both_native_targets(tmp_path, wide):
    path = tmp_path / "universal"
    path.write_bytes(_universal(wide=wide))
    assert validate_binary(path, "aarch64-apple-darwin").architectures == frozenset(
        {"aarch64", "x86_64"}
    )
    validate_binary(path, "x86_64-apple-darwin")
    path.write_bytes(_universal(wide=wide, contradictory=True))
    with pytest.raises(ArchitectureError, match="slice architecture"):
        validate_binary(path, "aarch64-apple-darwin")


@pytest.mark.parametrize(
    "payload",
    [
        b"#!/bin/sh\necho EVIDENCELOOM_SIDECAR_PLACEHOLDER\n",
        _macho(0x01000007)[:12],
        _pe(0x8664)[:140],
        _elf(62)[:20],
        struct.pack(">II", 0xCAFEBABE, 1) + struct.pack(">IIIII", 0x0100000C, 0, 999999, 32, 0),
    ],
)
def test_placeholder_truncation_and_fake_universal_claims_are_rejected(tmp_path, payload):
    path = tmp_path / "launcher"
    path.write_bytes(payload)
    with pytest.raises(ArchitectureError):
        validate_binary(path, "aarch64-apple-darwin")


def test_same_cpu_on_wrong_os_and_arbitrary_target_names_are_rejected(tmp_path):
    binary = _binary(tmp_path / "linux", "linux", "x86_64")
    with pytest.raises(ArchitectureError, match="architecture mismatch"):
        validate_binary(binary, "x86_64-apple-darwin")
    with pytest.raises(ArchitectureError, match="Unsupported sidecar target"):
        validate_binary(binary, "x86_64-arbitrary-build-label")


def _native_target():
    for target in TARGETS:
        try:
            validate_interpreter(target)
            return target
        except ArchitectureError:
            continue
    pytest.skip("Test requires a supported native 64-bit Python interpreter")


def _fixture_repo(tmp_path):
    root = tmp_path / "fixture repo"
    (root / "scripts").mkdir(parents=True)
    (root / "frontend").mkdir()
    (root / "src-tauri" / "binaries").mkdir(parents=True)
    for name in (
        "build_tauri_sidecar.sh",
        "build_desktop_sidecar.sh",
        "sidecar_architecture.py",
        "sidecar_probe.py",
    ):
        shutil.copyfile(REPO / "scripts" / name, root / "scripts" / name)
    return root


def _environment(tmp_path):
    environment = dict(os.environ)
    for key in ("APPLE_SIGNING_IDENTITY", "APPLE_TEAM_ID", "PYTHONPATH"):
        environment.pop(key, None)
    environment["TMPDIR"] = str(tmp_path / "build temp")
    Path(environment["TMPDIR"]).mkdir()
    return environment


def _fake_python(tmp_path, marker, binary=None):
    path = tmp_path / "python-shim"
    path.write_text(
        f"#!{sys.executable}\n"
        "import pathlib, shutil, subprocess, sys\n"
        "args = sys.argv[1:]\n"
        "if args and args[0].endswith('sidecar_architecture.py'):\n"
        "    raise SystemExit(subprocess.call([sys.executable, *args]))\n"
        f"pathlib.Path({str(marker)!r}).write_text('invoked: ' + repr(args))\n"
        "if args[:2] == ['-m', 'PyInstaller']:\n"
        "    output = pathlib.Path(args[args.index('--distpath') + 1])\n"
        "    output.mkdir(parents=True, exist_ok=True)\n"
        f"    shutil.copyfile({str(binary)!r}, output / 'evidenceloom-runner')\n"
        "    raise SystemExit(0)\n"
        "raise SystemExit(1)\n",
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def _compiled_probe(tmp_path, output, target):
    compiler = shutil.which("cc")
    if compiler is None:
        pytest.skip("A C compiler is required for the native release-probe fixture")
    source = tmp_path / "probe.c"
    source.write_text(
        r"""
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
    char line[4096];
    if (!fgets(line, sizeof(line), stdin)) return 2;
    const char *log = getenv("SIDECAR_TEST_COMMAND_LOG");
    if (log) {
        FILE *file = fopen(log, "a");
        if (file) { fputs(line, file); fclose(file); }
    }
    if (!strstr(line, "smoke_test")) { puts("{\"type\":\"error\"}"); return 3; }
    const char *mode = getenv("SIDECAR_TEST_PROBE_MODE");
    if (mode && !strcmp(mode, "stderr_ready")) {
        fputs("private/path api_key=top-secret {\"type\":\"ready\"}\n", stderr);
        return 0;
    }
    if (mode && !strcmp(mode, "nonzero_ready")) {
        puts("{\"type\":\"ready\"}"); return 7;
    }
    if (mode && !strcmp(mode, "malformed")) {
        puts("log mentions ready"); return 0;
    }
    if (mode && !strcmp(mode, "multiple")) {
        puts("{\"type\":\"ready\"}\n{\"type\":\"error\"}"); return 0;
    }
    if (mode && !strcmp(mode, "error")) {
        puts("{\"type\":\"error\",\"message\":\"private/path api_key=top-secret\"}"); return 0;
    }
    if (strstr(line, "verifyRuntime") && getenv("SIDECAR_TEST_RUNTIME_ERROR")) {
        puts("{\"type\":\"error\"}"); return 1;
    }
    if (strstr(line, "verifyRuntime") && !getenv("SIDECAR_TEST_LEGACY"))
        puts("{\"type\":\"runtime_ready\"}");
    else puts("{\"type\":\"ready\"}");
    return 0;
}
""",
        encoding="utf-8",
    )
    args = [compiler, str(source), "-o", str(output)]
    if TARGETS[target][0] == "macos":
        args += ["-arch", "arm64" if TARGETS[target][1] == "aarch64" else "x86_64"]
    built = subprocess.run(args, capture_output=True, text=True)
    if built.returncode != 0:
        pytest.skip("Local compiler cannot build the requested fixture target")
    validate_binary(output, target)


@pytest.mark.parametrize("script", ["build_tauri_sidecar.sh", "build_desktop_sidecar.sh"])
@pytest.mark.skipif(
    os.name == "nt", reason="Disposable interpreter shim requires POSIX executable scripts"
)
def test_interpreter_mismatch_prevents_invocation_install_and_cleanup(tmp_path, script):
    native = _native_target()
    requested = next(target for target in TARGETS if TARGETS[target][0] != TARGETS[native][0])
    root = _fixture_repo(tmp_path)
    environment = _environment(tmp_path)
    marker = tmp_path / "pyinstaller-or-pip-invoked"
    interpreter = _fake_python(tmp_path, marker)
    for name in ("evidenceloom-runner-dist", "evidenceloom-runner-build"):
        directory = Path(environment["TMPDIR"]) / name
        directory.mkdir()
        (directory / "keep").write_text("untouched")
    args = ["bash", str(root / "scripts" / script)]
    if script == "build_tauri_sidecar.sh":
        args.append(requested)
        environment["PYTHON"] = str(interpreter)
    else:
        args += ["--target", requested, "--python", str(interpreter), "--skip-tauri"]
    result = subprocess.run(args, env=environment, capture_output=True, text=True)
    assert result.returncode != 0 and "Python is" in result.stderr
    assert not marker.exists()
    for name in ("evidenceloom-runner-dist", "evidenceloom-runner-build"):
        assert (Path(environment["TMPDIR"]) / name / "keep").read_text() == "untouched"
    assert list((root / "src-tauri" / "binaries").iterdir()) == []


@pytest.mark.skipif(
    os.name == "nt", reason="Disposable interpreter shim requires POSIX executable scripts"
)
def test_build_output_mismatch_is_rejected_before_target_named_copy(tmp_path):
    target = _native_target()
    system, architecture = TARGETS[target]
    if system == "windows":
        pytest.skip("Shell fixture emits a POSIX sidecar filename")
    root = _fixture_repo(tmp_path)
    wrong = "aarch64" if architecture == "x86_64" else "x86_64"
    binary = _binary(tmp_path / "wrong-architecture", system, wrong)
    destination = root / "src-tauri" / "binaries" / ("evidenceloom-runner-" + target)
    destination.write_bytes(b"prior complete sidecar")
    marker = tmp_path / "build-invoked"
    interpreter = _fake_python(tmp_path, marker, binary)
    environment = _environment(tmp_path)
    environment["PYTHON"] = str(interpreter)
    result = subprocess.run(
        ["bash", str(root / "scripts" / "build_tauri_sidecar.sh"), target],
        env=environment,
        capture_output=True,
        text=True,
    )
    assert marker.exists() and result.returncode != 0
    assert "binary is" in result.stderr and "architecture mismatch" in result.stderr
    assert destination.read_bytes() == b"prior complete sidecar"


@pytest.mark.skipif(os.name == "nt", reason="Disposable npm shim requires POSIX executable scripts")
def test_skip_sidecar_checks_reused_architecture_before_packaging(tmp_path):
    target = _native_target()
    system, architecture = TARGETS[target]
    root = _fixture_repo(tmp_path)
    suffix = ".exe" if system == "windows" else ""
    reused = root / "src-tauri" / "binaries" / ("evidenceloom-runner-" + target + suffix)
    wrong = "aarch64" if architecture == "x86_64" else "x86_64"
    _binary(reused, system, wrong)
    tools = tmp_path / "tools"
    tools.mkdir()
    marker = tmp_path / "npm-invoked"
    npm = tools / "npm"
    npm.write_text(f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(marker)!r}).touch()\n")
    npm.chmod(0o755)
    environment = _environment(tmp_path)
    environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
    args = [
        "bash",
        str(root / "scripts" / "build_desktop_sidecar.sh"),
        "--target",
        target,
        "--python",
        sys.executable,
        "--skip-sidecar",
    ]
    result = subprocess.run(args, env=environment, capture_output=True, text=True)
    assert result.returncode != 0 and "architecture mismatch" in result.stderr
    assert not marker.exists()
    _binary(reused, system, architecture)
    header_only = subprocess.run(
        args + ["--skip-tauri"], env=environment, capture_output=True, text=True
    )
    assert (
        header_only.returncode != 0 and "Sidecar OS and architecture verified" in header_only.stdout
    )
    assert "bootstrap verification failed" in header_only.stderr
    assert not marker.exists()


@pytest.mark.skipif(os.name == "nt", reason="Disposable npm shim requires POSIX executable scripts")
@pytest.mark.parametrize("mode", ["current", "legacy", "missing_runtime"])
def test_reused_sidecar_requires_bootstrap_and_legacy_safe_research_probe(tmp_path, mode):
    target = _native_target()
    root = _fixture_repo(tmp_path)
    sidecar = root / "src-tauri" / "binaries" / ("evidenceloom-runner-" + target)
    _compiled_probe(tmp_path, sidecar, target)
    environment = _environment(tmp_path)
    commands = tmp_path / "probe-commands.jsonl"
    environment["SIDECAR_TEST_COMMAND_LOG"] = str(commands)
    tools = tmp_path / "tools"
    tools.mkdir()
    packaged = tmp_path / "npm-invoked"
    npm = tools / "npm"
    npm.write_text(
        f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(packaged)!r}).touch()\n"
    )
    npm.chmod(0o755)
    environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
    if mode == "legacy":
        environment["SIDECAR_TEST_LEGACY"] = "1"
    elif mode == "missing_runtime":
        environment["SIDECAR_TEST_RUNTIME_ERROR"] = "1"
    args = [
        "bash",
        str(root / "scripts" / "build_desktop_sidecar.sh"),
        "--target",
        target,
        "--python",
        sys.executable,
        "--skip-sidecar",
    ]
    if mode == "current":
        args.append("--skip-tauri")
    result = subprocess.run(
        args,
        env=environment,
        capture_output=True,
        text=True,
    )
    assert [json.loads(line) for line in commands.read_text().splitlines()] == [
        {"__command": "smoke_test"},
        {"__command": "smoke_test", "verifyRuntime": True},
    ]
    assert "bootstrap check passed" in result.stdout
    assert not packaged.exists()
    if mode == "current":
        assert result.returncode == 0 and "runtime check passed" in result.stdout
    else:
        assert result.returncode != 0 and "Rebuild the sidecar before distribution" in result.stderr
        assert "runtime check passed" not in result.stdout


@pytest.mark.skipif(os.name == "nt", reason="Disposable npm shim requires POSIX executable scripts")
@pytest.mark.parametrize(
    "mode", ["stderr_ready", "nonzero_ready", "malformed", "multiple", "error"]
)
def test_desktop_wrapper_rejects_false_readiness_before_distribution(tmp_path, mode):
    target = _native_target()
    root = _fixture_repo(tmp_path)
    sidecar = root / "src-tauri" / "binaries" / ("evidenceloom-runner-" + target)
    _compiled_probe(tmp_path, sidecar, target)
    environment = _environment(tmp_path)
    environment["SIDECAR_TEST_PROBE_MODE"] = mode
    command_log = tmp_path / "commands.jsonl"
    environment["SIDECAR_TEST_COMMAND_LOG"] = str(command_log)
    tools = tmp_path / "tools"
    tools.mkdir()
    packaged = tmp_path / "npm-invoked"
    npm = tools / "npm"
    npm.write_text(
        f"#!{sys.executable}\nfrom pathlib import Path\nPath({str(packaged)!r}).touch()\n"
    )
    npm.chmod(0o755)
    environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
    result = subprocess.run(
        [
            "bash",
            str(root / "scripts" / "build_desktop_sidecar.sh"),
            "--target",
            target,
            "--python",
            sys.executable,
            "--skip-sidecar",
        ],
        env=environment,
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert result.returncode != 0 and not packaged.exists()
    assert "bootstrap verification failed" in result.stderr
    assert "Rebuild the sidecar before distribution" in result.stderr
    assert "top-secret" not in result.stderr and "private/path" not in result.stderr
    assert "check passed" not in result.stdout
    assert [json.loads(line) for line in command_log.read_text().splitlines()] == [
        {"__command": "smoke_test"}
    ]
