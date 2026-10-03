"""Fail closed on sidecar OS/CPU mismatches using native executable headers.

This checks the launcher architecture, not its signing, libc ABI, or embedded
dependencies. PyInstaller builds must first use a Python process matching the
requested native target. No third-party package or executable is required.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
import platform
import struct
import sys
from typing import BinaryIO


class ArchitectureError(ValueError):
    """The target cannot be established or does not match the executable."""


@dataclass(frozen=True)
class BinaryIdentity:
    system: str
    architectures: frozenset[str]


TARGETS = {
    "aarch64-apple-darwin": ("macos", "aarch64"),
    "x86_64-apple-darwin": ("macos", "x86_64"),
    "aarch64-pc-windows-msvc": ("windows", "aarch64"),
    "x86_64-pc-windows-msvc": ("windows", "x86_64"),
    "aarch64-unknown-linux-gnu": ("linux", "aarch64"),
    "x86_64-unknown-linux-gnu": ("linux", "x86_64"),
}
_MACH_CPUS = {0x01000007: "x86_64", 0x0100000C: "aarch64"}
_ELF_CPUS = {62: "x86_64", 183: "aarch64"}
_PE_CPUS = {0x8664: "x86_64", 0xAA64: "aarch64"}
_MACH_MAGICS = {b"\xcf\xfa\xed\xfe": "<", b"\xfe\xed\xfa\xcf": ">"}
_FAT_MAGICS = {
    b"\xca\xfe\xba\xbe": (">", False),
    b"\xbe\xba\xfe\xca": ("<", False),
    b"\xca\xfe\xba\xbf": (">", True),
    b"\xbf\xba\xfe\xca": ("<", True),
}


def _read(stream: BinaryIO, offset: int, size: int, length: int) -> bytes:
    if offset < 0 or size < 0 or offset + size > length:
        raise ArchitectureError("Sidecar executable header is truncated or invalid")
    stream.seek(offset)
    value = stream.read(size)
    if len(value) != size:
        raise ArchitectureError("Sidecar executable header is truncated or invalid")
    return value


def _cpu(value: int, supported: dict[int, str]) -> str:
    if value not in supported:
        raise ArchitectureError("Sidecar executable has an unsupported CPU architecture")
    return supported[value]


def _macho(stream: BinaryIO, offset: int, length: int) -> str:
    header = _read(stream, offset, 32, length)
    endian = _MACH_MAGICS.get(header[:4])
    if endian is None:
        raise ArchitectureError("Sidecar Mach-O slice is not a supported 64-bit executable")
    cpu, _, file_type = struct.unpack(endian + "III", header[4:16])
    if file_type != 2:  # MH_EXECUTE, rather than an object or shared library
        raise ArchitectureError("Sidecar Mach-O file is not an executable")
    return _cpu(cpu, _MACH_CPUS)


def binary_identity(path: str | Path) -> BinaryIdentity:
    try:
        with Path(path).open("rb") as stream:
            stream.seek(0, 2)
            length = stream.tell()
            magic = _read(stream, 0, 4, length)
            if magic in _MACH_MAGICS:
                return BinaryIdentity("macos", frozenset({_macho(stream, 0, length)}))
            if magic in _FAT_MAGICS:
                endian, wide = _FAT_MAGICS[magic]
                count = struct.unpack(endian + "I", _read(stream, 4, 4, length))[0]
                if not 1 <= count <= 16:
                    raise ArchitectureError("Sidecar universal Mach-O header is invalid")
                entry_size = 32 if wide else 20
                table_end = 8 + count * entry_size
                architectures = set()
                for index in range(count):
                    entry = _read(stream, 8 + index * entry_size, entry_size, length)
                    cpu, _ = struct.unpack(endian + "II", entry[:8])
                    offset, size = struct.unpack(
                        endian + ("QQ" if wide else "II"), entry[8:24] if wide else entry[8:16]
                    )
                    if offset < table_end or size < 32 or offset + size > length:
                        raise ArchitectureError("Sidecar universal Mach-O slice is invalid")
                    expected = _cpu(cpu, _MACH_CPUS)
                    actual = _macho(stream, offset, offset + size)
                    if actual != expected or actual in architectures:
                        raise ArchitectureError(
                            "Sidecar universal Mach-O slice architecture is invalid"
                        )
                    architectures.add(actual)
                return BinaryIdentity("macos", frozenset(architectures))
            if magic == b"\x7fELF":
                header = _read(stream, 0, 64, length)
                if header[4] != 2 or header[5] not in (1, 2) or header[6] != 1:
                    raise ArchitectureError("Sidecar ELF file is not a supported 64-bit executable")
                if header[7] not in (0, 3):  # System V or GNU/Linux ABI
                    raise ArchitectureError("Sidecar ELF OS ABI is not supported for Linux")
                endian = "<" if header[5] == 1 else ">"
                file_type, cpu = struct.unpack(endian + "HH", header[16:20])
                if file_type not in (2, 3) or struct.unpack(endian + "Q", header[24:32])[0] == 0:
                    raise ArchitectureError("Sidecar ELF file is not an executable")
                return BinaryIdentity("linux", frozenset({_cpu(cpu, _ELF_CPUS)}))
            if magic[:2] == b"MZ":
                offset = struct.unpack("<I", _read(stream, 0x3C, 4, length))[0]
                header = _read(stream, offset, 24, length)
                if header[:4] != b"PE\x00\x00":
                    raise ArchitectureError("Sidecar PE executable signature is invalid")
                cpu = struct.unpack("<H", header[4:6])[0]
                optional_size, flags = struct.unpack("<HH", header[20:24])
                if optional_size < 2 or not flags & 2 or flags & 0x2000:
                    raise ArchitectureError("Sidecar PE file is not an executable")
                optional = _read(stream, offset + 24, optional_size, length)
                if struct.unpack("<H", optional[:2])[0] != 0x20B:
                    raise ArchitectureError("Sidecar PE file is not a supported 64-bit executable")
                return BinaryIdentity("windows", frozenset({_cpu(cpu, _PE_CPUS)}))
            raise ArchitectureError(
                "Sidecar is not a recognized native executable (placeholder or script)"
            )
    except OSError as exc:
        raise ArchitectureError("Sidecar executable could not be read") from exc


def _target(target: str) -> tuple[str, str]:
    if target not in TARGETS:
        raise ArchitectureError(
            "Unsupported sidecar target; supported targets: " + ", ".join(TARGETS)
        )
    return TARGETS[target]


def validate_binary(path: str | Path, target: str) -> BinaryIdentity:
    system, architecture = _target(target)
    identity = binary_identity(path)
    if identity.system != system or architecture not in identity.architectures:
        actual = identity.system + "/" + ",".join(sorted(identity.architectures))
        raise ArchitectureError(
            f"Sidecar architecture mismatch: binary is {actual}; requested {target}"
        )
    return identity


def validate_interpreter(target: str) -> BinaryIdentity:
    system, architecture = _target(target)
    process_system = {"darwin": "macos", "linux": "linux", "win32": "windows"}.get(sys.platform)
    executable = binary_identity(sys.executable)
    if len(executable.architectures) == 1:
        active = next(iter(executable.architectures))
    else:
        active = {
            "arm64": "aarch64",
            "aarch64": "aarch64",
            "amd64": "x86_64",
            "x86_64": "x86_64",
        }.get(platform.machine().lower())
    if (
        struct.calcsize("P") != 8
        or executable.system != process_system
        or active not in executable.architectures
    ):
        raise ArchitectureError(
            "Python interpreter OS and active 64-bit architecture could not be established"
        )
    if (process_system, active) != (system, architecture):
        raise ArchitectureError(
            f"Sidecar architecture mismatch: Python is {process_system}/{active}; requested {target}. "
            "Use a Python interpreter matching the requested target."
        )
    return BinaryIdentity(process_system, frozenset({active}))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("interpreter", "binary"))
    parser.add_argument("target")
    parser.add_argument("path", nargs="?")
    args = parser.parse_args(argv)
    try:
        if args.mode == "interpreter":
            validate_interpreter(args.target)
        elif args.path is None:
            parser.error("binary mode requires an executable path")
        else:
            validate_binary(args.path, args.target)
    except ArchitectureError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
