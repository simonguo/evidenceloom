#!/usr/bin/env python3
"""Verify that all public Evidence Loom application versions are synchronized."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def cargo_package_version(path: Path) -> str:
    """Read the package version without requiring tomllib on Python 3.10."""
    in_package = False
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_package = stripped == "[package]"
            continue
        if in_package and (match := re.fullmatch(r'version\s*=\s*"([^"]+)"', stripped)):
            return match.group(1)
    raise ValueError(f"No [package] version found in {path}")


def main() -> int:
    frontend = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    tauri = json.loads((ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
    versions = {
        "frontend/package.json": frontend["version"],
        "src-tauri/Cargo.toml": cargo_package_version(ROOT / "src-tauri" / "Cargo.toml"),
        "src-tauri/tauri.conf.json": tauri["version"],
    }
    expected = next(iter(versions.values()))
    mismatches = {path: version for path, version in versions.items() if version != expected}
    if mismatches:
        print("Evidence Loom application versions are not synchronized:", file=sys.stderr)
        for path, version in versions.items():
            print(f"  {path}: {version}", file=sys.stderr)
        return 1

    tag = next(
        (
            argument.removeprefix("--tag=")
            for argument in sys.argv[1:]
            if argument.startswith("--tag=")
        ),
        "",
    )
    if tag and tag.removeprefix("v") != expected:
        print(
            f"Release tag {tag!r} does not match application version {expected!r}", file=sys.stderr
        )
        return 1

    print(f"Evidence Loom application version: {expected}")
    print("Embedded TradingAgents core version: 0.2.5")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
