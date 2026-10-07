"""Fail-closed npm audit gate with exact reviewed, unresolved development graphs.

After npm ci, require a fresh report from this exact trusted full-audit invocation:
npm audit --include=dev --include=optional --include=peer --json

This checks report/lock/count consistency, not included dependency scope: an
omit-dev report can have the same metadata counts as a full report. The trusted
invocation supplies the scope guarantee. Registry authenticity and unreported
bugs are outside this check. The independent npm audit --omit=dev gate is required.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ADVISORY = "GHSA-vfj7-8cjw-p6xm"
ADVISORY_URL = f"https://github.com/advisories/{ADVISORY}"
SEVERITIES = ("info", "low", "moderate", "high", "critical")
MAX_BYTES = 16 * 1024 * 1024
TYPOGRAPHY = "@tailwindcss/typography"
TYPOGRAPHY_NODE = "node_modules/@tailwindcss/typography"
TYPOGRAPHY_RANGE = "<=0.0.0-insiders.fda8ce5 || >=0.5.0-alpha.1"
TYPOGRAPHY_PEER = ">=3.0.0 || >=4.0.0 || insiders"

# Exact reviewed instances, not blanket package-name or semver exemptions.
INSTANCES = {
    "node_modules/@next/eslint-plugin-next": ("@next/eslint-plugin-next", "15.5.27"),
    "node_modules/braces": ("braces", "3.0.3"),
    "node_modules/chokidar": ("chokidar", "3.6.0"),
    "node_modules/eslint-config-next": ("eslint-config-next", "15.5.27"),
    "node_modules/fast-glob": ("fast-glob", "3.3.1"),
    "node_modules/micromatch": ("micromatch", "4.0.8"),
    "node_modules/tailwindcss": ("tailwindcss", "3.4.19"),
    "node_modules/tailwindcss/node_modules/fast-glob": ("fast-glob", "3.3.3"),
}
VIA = {
    "@next/eslint-plugin-next": {"fast-glob"},
    "braces": set(),
    "chokidar": {"braces"},
    "eslint-config-next": {"@next/eslint-plugin-next"},
    "fast-glob": {"micromatch"},
    "micromatch": {"braces"},
    "tailwindcss": {"chokidar", "fast-glob", "micromatch"},
}
# npm effects is not always the inverse of via: metavulnerability aggregation
# across distinct installed versions can omit an inverse name. Freeze the actual
# reviewed report, rather than inventing a stricter graph npm does not produce.
EFFECTS = {
    "@next/eslint-plugin-next": {"eslint-config-next"},
    "braces": {"chokidar", "micromatch"},
    "chokidar": {"tailwindcss"},
    "eslint-config-next": set(),
    "fast-glob": {"@next/eslint-plugin-next"},
    "micromatch": {"fast-glob", "tailwindcss"},
    "tailwindcss": set(),
}
RANGES = {
    "@next/eslint-plugin-next": ">=14.3.0-canary.0",
    "braces": "*",
    "chokidar": "2.0.0 - 3.6.0",
    "eslint-config-next": ">=14.3.0-canary.0",
    "fast-glob": "*",
    "micromatch": ">=0.2.0",
    "tailwindcss": "<=0.0.0-oxide-insiders.ff2c25f || 2.1.0-canary.1 - 3.4.19",
}


class FrontendAuditError(ValueError):
    """Fixed diagnostics intentionally exclude raw registry errors and local paths."""


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise FrontendAuditError(reason)


def _keys(value: Any, expected: set[str]) -> None:
    _require(type(value) is dict and set(value) == expected, "Unsupported audit schema.")


def _count(value: Any) -> bool:
    return type(value) is int and 0 <= value <= 1_000_000


def _strings(value: Any) -> bool:
    return (
        type(value) is list
        and all(type(item) is str and 0 < len(item) <= 1000 for item in value)
        and len(value) == len(set(value))
    )


def _pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for key, value in pairs:
        _require(key not in result, "Duplicate JSON field.")
        result[key] = value
    return result


def _nonfinite(_value: str) -> None:
    raise FrontendAuditError("Non-finite JSON number.")


def load_json(path: Path) -> dict[str, Any]:
    try:
        with path.open("rb") as stream:
            raw = stream.read(MAX_BYTES + 1)
        _require(len(raw) <= MAX_BYTES, "Audit input exceeds the size limit.")
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=_nonfinite)
    except FrontendAuditError:
        raise
    except (OSError, UnicodeError, ValueError, RecursionError):
        raise FrontendAuditError("Audit input could not be read as JSON.") from None


def _lock_packages(lock: Any) -> dict[str, dict[str, Any]]:
    _require(type(lock) is dict, "Unsupported lock schema.")
    _require(
        set(lock) == {"name", "version", "lockfileVersion", "requires", "packages"}
        and type(lock["lockfileVersion"]) is int
        and lock["lockfileVersion"] == 3
        and lock["requires"] is True
        and type(lock["name"]) is str
        and bool(lock["name"])
        and type(lock["version"]) is str
        and bool(lock["version"]),
        "Unsupported lock schema.",
    )
    packages = lock["packages"]
    _require(type(packages) is dict and "" in packages, "Unsupported lock schema.")
    for node, package in packages.items():
        _require(type(package) is dict, "Unsupported lock package.")
        _require(
            type(node) is str
            and (not node or node.startswith("node_modules/"))
            and not any(part in {"", ".", ".."} for part in node.split("/") if node)
            and "\\" not in node
            and package.get("link") is not True
            and type(package.get("version")) is str
            and bool(package["version"]),
            "Unsupported lock package.",
        )
        for flag in ("dev", "optional", "peer", "devOptional"):
            _require(flag not in package or type(package[flag]) is bool, "Invalid lock flags.")
        _require("peerOptional" not in package, "Unsupported lock flags.")
    root = packages[""]
    _require(
        root.get("name") == lock["name"] and root.get("version") == lock["version"],
        "Lock root identity mismatch.",
    )
    for group in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
        entries = root.get(group, {})
        _require(
            type(entries) is dict
            and all(type(k) is str and type(v) is str for k, v in entries.items()),
            "Unsupported root dependencies.",
        )
    return packages


def _metadata(report: dict[str, Any], packages: dict[str, Any]) -> None:
    _keys(report["metadata"], {"vulnerabilities", "dependencies"})
    counts = report["metadata"]["vulnerabilities"]
    _keys(counts, {*SEVERITIES, "total"})
    _require(all(_count(x) for x in counts.values()), "Invalid audit counts.")
    _require(
        all(
            type(v.get("severity")) is str and v["severity"] in SEVERITIES
            for v in report["vulnerabilities"].values()
        ),
        "Unsupported vulnerability severity.",
    )
    actual = Counter(value.get("severity") for value in report["vulnerabilities"].values())
    _require(
        all(counts[severity] == actual[severity] for severity in SEVERITIES)
        and counts["total"] == len(report["vulnerabilities"]),
        "Audit vulnerability counts do not match the findings.",
    )
    dependencies = report["metadata"]["dependencies"]
    _keys(dependencies, {"prod", "dev", "optional", "peer", "peerOptional", "total"})
    _require(all(_count(x) for x in dependencies.values()), "Invalid dependency counts.")
    # npm Arborist counts overlapping flags; prod includes the root, total excludes it.
    expected = {key: 0 for key in dependencies}
    expected["total"] = len(packages) - 1
    for package in packages.values():
        flags = [flag for flag in ("dev", "optional", "peer") if package.get(flag) is True]
        for flag in flags:
            expected[flag] += 1
        if not flags:
            expected["prod"] += 1
    _require(dependencies == expected, "Audit dependency counts do not match the lock.")


def _advisory(value: Any) -> None:
    _keys(
        value, {"source", "name", "dependency", "title", "url", "severity", "cwe", "cvss", "range"}
    )
    _require(
        value["url"] == ADVISORY_URL
        and value["name"] == value["dependency"] == "braces"
        and value["severity"] == "high"
        and value["range"] == "<=3.0.3"
        and type(value["source"]) is int
        and value["source"] == 1240992
        and type(value["title"]) is str
        and 0 < len(value["title"]) <= 1000
        and value["cwe"] == ["CWE-674"],
        "An unreviewed advisory is present.",
    )
    _keys(value["cvss"], {"score", "vectorString"})
    score = value["cvss"]["score"]
    _require(
        type(score) in (int, float)
        and score == 7.5
        and math.isfinite(score)
        and value["cvss"]["vectorString"] == "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
        "Unreviewed advisory severity metadata.",
    )


def _resolved_dependency(packages: dict[str, Any], parent: str, name: str) -> str | None:
    while True:
        candidate = f"{parent}/node_modules/{name}" if parent else f"node_modules/{name}"
        if candidate in packages:
            return candidate
        if not parent:
            return None
        parent = parent.rsplit("/node_modules/", 1)[0] if "/node_modules/" in parent else ""


def _fix(value: Any, name: str) -> None:
    if name == TYPOGRAPHY:
        _keys(value, {"name", "version", "isSemVerMajor"})
        _require(
            value["name"] == TYPOGRAPHY
            and value["version"] == "0.4.1"
            and value["isSemVerMajor"] is True,
            "Unreviewed typography fix metadata.",
        )
        return
    if type(value) is bool:
        return
    _keys(value, {"name", "version", "isSemVerMajor"})
    _require(
        type(value["name"]) is str
        and value["name"] in {"eslint-config-next", "tailwindcss"}
        and type(value["version"]) is str
        and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value["version"]) is not None
        and type(value["isSemVerMajor"]) is bool,
        "Unsupported suggested fix metadata.",
    )


def validate_audit(report: Any, lock: Any) -> dict[str, Any]:
    """Return a clear/exception result, or reject an incomplete/unreviewed report."""
    _keys(report, {"auditReportVersion", "vulnerabilities", "metadata"})
    _require(
        type(report["auditReportVersion"]) is int
        and report["auditReportVersion"] == 2
        and type(report["vulnerabilities"]) is dict
        and all(type(v) is dict for v in report["vulnerabilities"].values()),
        "Unsupported audit schema.",
    )
    packages = _lock_packages(lock)
    _metadata(report, packages)
    findings = report["vulnerabilities"]
    if not findings:
        return {
            "status": "clear",
            "vulnerable_packages": 0,
            "reviewed_lock_instances": 0,
            "unresolved_advisory": None,
        }
    # Select one complete reviewed graph, never optional names/effects/edges.
    _require(
        set(findings) in (set(VIA), set(VIA) | {TYPOGRAPHY}),
        "Findings differ from the reviewed exception chain.",
    )
    via_graph, effects, instances, ranges = dict(VIA), dict(EFFECTS), dict(INSTANCES), dict(RANGES)
    if TYPOGRAPHY in findings:
        via_graph[TYPOGRAPHY] = {"tailwindcss"}
        effects[TYPOGRAPHY] = set()
        effects["tailwindcss"] = {TYPOGRAPHY}
        instances[TYPOGRAPHY_NODE] = (TYPOGRAPHY, "0.5.20")
        ranges[TYPOGRAPHY] = TYPOGRAPHY_RANGE
    observed = {
        node for node in packages if node and node.rsplit("node_modules/", 1)[-1] in via_graph
    }
    _require(observed == set(instances), "Lock instances differ from the reviewed exception.")
    root = packages[""]
    # Validate referenced node lists before following edges. JSON object order
    # must not turn a malformed downstream finding into a raw exception.
    for finding in findings.values():
        _keys(
            finding,
            {"name", "severity", "isDirect", "via", "effects", "range", "nodes", "fixAvailable"},
        )
        _require(_strings(finding["nodes"]), "Unsupported vulnerability nodes.")
    for name, finding in findings.items():
        nodes = {node for node, instance in instances.items() if instance[0] == name}
        direct = name in root.get("devDependencies", {})
        _require(
            finding["name"] == name
            and finding["severity"] == "high"
            and type(finding["isDirect"]) is bool
            and finding["isDirect"] == direct
            and (name != TYPOGRAPHY or direct)
            and name not in root.get("dependencies", {})
            and name not in root.get("optionalDependencies", {})
            and name not in root.get("peerDependencies", {})
            and finding["range"] == ranges[name]
            and set(finding["nodes"]) == nodes,
            "Unreviewed vulnerability or runtime instance.",
        )
        _require(
            _strings(finding["effects"]) and set(finding["effects"]) == effects[name],
            "Incomplete vulnerability effects graph.",
        )
        via = finding["via"]
        _require(type(via) is list, "Unsupported vulnerability references.")
        if name == "braces":
            _require(len(via) == 1, "Incomplete advisory leaf.")
            _advisory(via[0])
        else:
            _require(
                _strings(via) and set(via) == via_graph[name],
                "Incomplete or unreviewed vulnerability references.",
            )
        _fix(finding["fixAvailable"], name)
        for node in nodes:
            package = packages[node]
            _require(
                package.get("version") == instances[node][1]
                and package.get("name", name) == name
                and package.get("dev") is True
                and package.get("devOptional") is not True,
                "Unreviewed lock version or runtime instance.",
            )
            for dependency in via_graph[name]:
                group = "peerDependencies" if name == TYPOGRAPHY else "dependencies"
                _require(
                    type(package.get(group)) is dict
                    and type(package[group].get(dependency)) is str
                    and (name != TYPOGRAPHY or package[group][dependency] == TYPOGRAPHY_PEER)
                    and _resolved_dependency(packages, node, dependency)
                    in findings[dependency]["nodes"],
                    "Vulnerability references do not match locked dependency edges.",
                )
    result = {
        "status": "unresolved_development_exception",
        "vulnerable_packages": len(findings),
        "reviewed_lock_instances": len(instances),
        "unresolved_advisory": ADVISORY,
    }
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report",
        required=True,
        type=Path,
        help=(
            "Fresh JSON from trusted npm audit --include=dev --include=optional "
            "--include=peer --json; report metadata cannot attest included scope."
        ),
    )
    parser.add_argument("--lock", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = validate_audit(load_json(args.report), load_json(args.lock))
    except FrontendAuditError as exc:
        print(f"Frontend audit rejected: {exc}", file=sys.stderr)
        return 1
    if result["status"] == "clear":
        print("Frontend audit clear: zero reported vulnerabilities.")
    else:
        print(
            "Frontend audit accepted with UNRESOLVED development exception "
            f"{result['unresolved_advisory']}: "
            f"{result['vulnerable_packages']} vulnerable package names, "
            f"{result['reviewed_lock_instances']} reviewed dev-only lock instances. "
            "This is not zero vulnerabilities; the separate production audit is still required."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
