"""Offline npm v2 cases for the observed seven/eight-package braces exception variants."""

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from scripts.check_frontend_audit import FrontendAuditError, load_json, validate_audit


@pytest.fixture
def inputs():
    # Retain the real graph, exact versions and nested fast-glob instance, but omit
    # unrelated packages. Counts describe this small complete lock, not production.
    entries = {
        "@next/eslint-plugin-next": (
            "15.5.27",
            {"fast-glob": "3.3.1"},
            ["fast-glob"],
            ">=14.3.0-canary.0",
        ),
        "braces": ("3.0.3", {"fill-range": "^7.1.1"}, [], "*"),
        "chokidar": ("3.6.0", {"braces": "~3.0.2"}, ["braces"], "2.0.0 - 3.6.0"),
        "eslint-config-next": (
            "15.5.27",
            {"@next/eslint-plugin-next": "15.5.27"},
            ["@next/eslint-plugin-next"],
            ">=14.3.0-canary.0",
        ),
        "fast-glob": ("3.3.1", {"micromatch": "^4.0.4"}, ["micromatch"], "*"),
        "micromatch": ("4.0.8", {"braces": "^3.0.3"}, ["braces"], ">=0.2.0"),
        "tailwindcss": (
            "3.4.19",
            {"chokidar": "^3.6.0", "fast-glob": "^3.3.2", "micromatch": "^4.0.8"},
            ["chokidar", "fast-glob", "micromatch"],
            "<=0.0.0-oxide-insiders.ff2c25f || 2.1.0-canary.1 - 3.4.19",
        ),
    }
    packages = {
        "": {
            "name": "audit-fixture",
            "version": "1.0.0",
            "devDependencies": {"eslint-config-next": "15.5.27", "tailwindcss": "^3.4.17"},
        }
    }
    findings = {}
    for name, (version, dependencies, via, affected_range) in entries.items():
        node = f"node_modules/{name}"
        packages[node] = {"version": version, "dev": True, "dependencies": dependencies}
        findings[name] = {
            "name": name,
            "severity": "high",
            "isDirect": name in {"eslint-config-next", "tailwindcss"},
            "via": via,
            "effects": [parent for parent, entry in entries.items() if name in entry[2]],
            "range": affected_range,
            "nodes": [node],
            "fixAvailable": {"name": "tailwindcss", "version": "4.3.3", "isSemVerMajor": True},
        }
    findings["braces"]["via"] = [
        {
            "source": 1240992,
            "name": "braces",
            "dependency": "braces",
            "title": "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
            "url": "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
            "severity": "high",
            "cwe": ["CWE-674"],
            "cvss": {
                "score": 7.5,
                "vectorString": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
            },
            "range": "<=3.0.3",
        }
    ]
    packages["node_modules/tailwindcss/node_modules/fast-glob"] = {
        "version": "3.3.3",
        "dev": True,
        "dependencies": {"micromatch": "^4.0.8"},
    }
    findings["fast-glob"]["nodes"].append("node_modules/tailwindcss/node_modules/fast-glob")
    # The real npm v2 report omits Tailwind from fast-glob effects even though
    # Tailwind via includes fast-glob; do not assume via/effects are reciprocal.
    findings["fast-glob"]["effects"] = ["@next/eslint-plugin-next"]
    lock = {
        "name": "audit-fixture",
        "version": "1.0.0",
        "lockfileVersion": 3,
        "requires": True,
        "packages": packages,
    }
    report = {
        "auditReportVersion": 2,
        "vulnerabilities": findings,
        "metadata": {
            "vulnerabilities": {
                "info": 0,
                "low": 0,
                "moderate": 0,
                "high": 7,
                "critical": 0,
                "total": 7,
            },
            "dependencies": {
                "prod": 1,
                "dev": 8,
                "optional": 0,
                "peer": 0,
                "peerOptional": 0,
                "total": 8,
            },
        },
    }
    return report, lock


def test_reviewed_exception_is_explicitly_unresolved(inputs):
    report, lock = inputs
    result = validate_audit(report, lock)
    assert result == {
        "status": "unresolved_development_exception",
        "vulnerable_packages": 7,
        "reviewed_lock_instances": 8,
        "unresolved_advisory": "GHSA-vfj7-8cjw-p6xm",
    }


def test_future_zero_report_passes_without_extending_the_exception(inputs):
    report, lock = inputs
    report["vulnerabilities"] = {}
    report["metadata"]["vulnerabilities"] = {
        "info": 0,
        "low": 0,
        "moderate": 0,
        "high": 0,
        "critical": 0,
        "total": 0,
    }
    lock["packages"]["node_modules/braces"]["version"] = "4.0.0"
    assert validate_audit(report, lock)["status"] == "clear"


@pytest.mark.parametrize(
    "change",
    [
        "new_advisory",
        "dropped_leaf",
        "dropped_via",
        "dangling_via",
        "cycle",
        "dropped_effect",
        "dropped_finding",
        "dropped_nested_node",
        "severity_count",
        "total_count",
        "dependency_count",
        "boolean_count",
        "unknown_schema",
        "network_error",
    ],
)
def test_incomplete_and_unreviewed_reports_fail_closed(inputs, change):
    report, lock = inputs
    findings = report["vulnerabilities"]
    if change == "new_advisory":
        extra = copy.deepcopy(findings["braces"]["via"][0])
        extra["url"] = "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz"
        findings["braces"]["via"].append(extra)
    elif change == "dropped_leaf":
        findings["braces"]["via"] = []
    elif change == "dropped_via":
        findings["tailwindcss"]["via"].remove("chokidar")
    elif change == "dangling_via":
        findings["chokidar"]["via"] = ["not-present"]
    elif change == "cycle":
        findings["micromatch"]["via"] = ["fast-glob"]
    elif change == "dropped_effect":
        findings["braces"]["effects"].remove("chokidar")
    elif change == "dropped_finding":
        del findings["chokidar"]
        report["metadata"]["vulnerabilities"].update(high=6, total=6)
    elif change == "dropped_nested_node":
        findings["fast-glob"]["nodes"].pop()
    elif change == "severity_count":
        report["metadata"]["vulnerabilities"].update(high=6, low=1)
    elif change == "total_count":
        report["metadata"]["vulnerabilities"]["total"] = 0
    elif change == "dependency_count":
        report["metadata"]["dependencies"]["total"] = 9
    elif change == "boolean_count":
        report["metadata"]["dependencies"]["prod"] = True
    elif change == "unknown_schema":
        report["auditReportVersion"] = 3
    else:
        report = {"error": {"code": "ECONNREFUSED", "summary": "private endpoint"}}
    with pytest.raises(FrontendAuditError):
        validate_audit(report, lock)


@pytest.fixture
def inputs_eight(inputs):
    report, lock = inputs
    name = "@tailwindcss/typography"
    lock["packages"][""]["devDependencies"][name] = "^0.5.16"
    lock["packages"]["node_modules/@tailwindcss/typography"] = {
        "version": "0.5.20",
        "dev": True,
        "peerDependencies": {"tailwindcss": ">=3.0.0 || >=4.0.0 || insiders"},
    }
    report["vulnerabilities"][name] = {
        "name": name,
        "severity": "high",
        "isDirect": True,
        "via": ["tailwindcss"],
        "effects": [],
        "range": "<=0.0.0-insiders.fda8ce5 || >=0.5.0-alpha.1",
        "nodes": ["node_modules/@tailwindcss/typography"],
        "fixAvailable": {"name": name, "version": "0.4.1", "isSemVerMajor": True},
    }
    report["vulnerabilities"]["tailwindcss"]["effects"] = [name]
    report["metadata"]["vulnerabilities"].update(high=8, total=8)
    report["metadata"]["dependencies"].update(dev=9, total=9)
    return report, lock


def test_eighth_name_requires_exact_reviewed_peer_instance(inputs_eight):
    report, lock = inputs_eight
    result = validate_audit(report, lock)
    assert result["status"] == "unresolved_development_exception"
    assert result["vulnerable_packages"] == 8
    assert result["reviewed_lock_instances"] == 9
    assert result["unresolved_advisory"] == "GHSA-vfj7-8cjw-p6xm"


@pytest.mark.parametrize(
    "change",
    [
        "missing_peer",
        "ordinary_dependency",
        "changed_peer",
        "changed_version",
        "runtime",
        "not_direct",
        "unknown_leaf",
        "missing_effect",
        "extra_effect",
        "different_via",
        "different_range",
        "mixed_seven",
    ],
)
def test_typography_does_not_become_a_blanket_exception(inputs_eight, change):
    report, lock = inputs_eight
    name = "@tailwindcss/typography"
    package = lock["packages"]["node_modules/@tailwindcss/typography"]
    finding = report["vulnerabilities"][name]
    if change == "missing_peer":
        package.pop("peerDependencies")
    elif change == "ordinary_dependency":
        package["dependencies"] = package.pop("peerDependencies")
    elif change == "changed_peer":
        package["peerDependencies"]["tailwindcss"] = "*"
    elif change == "changed_version":
        package["version"] = "0.5.21"
    elif change == "runtime":
        package["dev"] = False
        report["metadata"]["dependencies"].update(prod=2, dev=8)
    elif change == "not_direct":
        del lock["packages"][""]["devDependencies"][name]
        finding["isDirect"] = False
    elif change == "unknown_leaf":
        leaf = copy.deepcopy(report["vulnerabilities"]["braces"]["via"][0])
        leaf["url"] = "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz"
        finding["via"].append(leaf)
    elif change == "missing_effect":
        report["vulnerabilities"]["tailwindcss"]["effects"] = []
    elif change == "extra_effect":
        finding["effects"] = ["tailwindcss"]
    elif change == "different_via":
        finding["via"] = ["braces"]
    elif change == "different_range":
        finding["range"] = "*"
    else:
        del report["vulnerabilities"][name]
        report["metadata"]["vulnerabilities"].update(high=7, total=7)
        # The eighth-name effects attribution must not be accepted without it.
    with pytest.raises(FrontendAuditError):
        validate_audit(report, lock)


@pytest.mark.parametrize(
    "change",
    [
        "runtime_node",
        "direct_runtime",
        "dev_flag_number",
        "version_drift",
        "alias",
        "missing_node",
        "extra_instance",
        "removed_dependency",
        "shadow_dependency",
    ],
)
def test_report_cannot_extend_or_disguise_locked_runtime_exposure(inputs, change):
    report, lock = inputs
    packages = lock["packages"]
    if change == "runtime_node":
        packages["node_modules/braces"]["dev"] = False
        report["metadata"]["dependencies"].update(prod=2, dev=7)
    elif change == "direct_runtime":
        packages[""]["dependencies"] = {"braces": "3.0.3"}
    elif change == "dev_flag_number":
        packages["node_modules/braces"]["dev"] = 1
    elif change == "version_drift":
        packages["node_modules/braces"]["version"] = "3.0.2"
    elif change == "alias":
        packages["node_modules/braces"]["name"] = "other-package"
    elif change == "missing_node":
        del packages["node_modules/tailwindcss/node_modules/fast-glob"]
        report["metadata"]["dependencies"].update(dev=7, total=7)
    elif change == "extra_instance":
        packages["node_modules/other/node_modules/braces"] = {"version": "3.0.3", "dev": True}
        report["metadata"]["dependencies"].update(dev=9, total=9)
    elif change == "removed_dependency":
        del packages["node_modules/chokidar"]["dependencies"]["braces"]
    else:
        packages["node_modules/chokidar/node_modules/braces"] = {"version": "3.0.3", "dev": True}
        report["metadata"]["dependencies"].update(dev=9, total=9)
    with pytest.raises(FrontendAuditError):
        validate_audit(report, lock)


@pytest.mark.parametrize(
    "text",
    [
        "{",
        '{"error":{"code":"EAI_AGAIN"}}',
        '{"auditReportVersion":2,"auditReportVersion":2}',
        '{"score":NaN}',
        '{"number":' + "9" * 5000 + "}",
    ],
)
def test_cli_bad_input_returns_fixed_diagnostic(tmp_path, text):
    report = tmp_path / "report.json"
    report.write_text(text, encoding="utf-8")
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).parents[1] / "scripts/check_frontend_audit.py"),
            "--report",
            str(report),
            "--lock",
            str(tmp_path / "missing-secret-path.json"),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 1
    assert result.stdout == ""
    assert "Frontend audit rejected:" in result.stderr
    assert "missing-secret-path" not in result.stderr
    assert "Traceback" not in result.stderr


def test_cli_success_reports_unresolved_not_zero(tmp_path, inputs, capsys):
    from scripts.check_frontend_audit import main

    report, lock = inputs
    report_path, lock_path = tmp_path / "audit.json", tmp_path / "lock.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    assert main(["--report", str(report_path), "--lock", str(lock_path)]) == 0
    output = capsys.readouterr().out
    assert "UNRESOLVED" in output
    assert "not zero vulnerabilities" in output


def test_duplicate_nested_fields_are_not_silently_overwritten(tmp_path):
    path = tmp_path / "audit.json"
    path.write_text('{"metadata":{"total":7,"total":0}}', encoding="utf-8")
    with pytest.raises(FrontendAuditError, match="Duplicate JSON field"):
        load_json(path)


@pytest.mark.parametrize("field", ["severity", "fixAvailable", "nodes"])
def test_malformed_leaf_types_cannot_trigger_raw_exception(inputs, field):
    report, lock = inputs
    # The earlier @next record references fast-glob, so nodes=None also covers
    # traversal before the downstream record's own iteration.
    finding = report["vulnerabilities"]["fast-glob"]
    finding[field] = {
        "severity": {},
        "fixAvailable": {"name": {}, "version": "4.3.3", "isSemVerMajor": True},
        "nodes": None,
    }[field]
    with pytest.raises(FrontendAuditError):
        validate_audit(report, lock)


# Historical ten-name selector/braces graph: retained only as a rejection fixture.
@pytest.fixture
def inputs_ten(inputs_eight):
    report, lock = inputs_eight
    findings, packages = report["vulnerabilities"], lock["packages"]
    selector = "postcss-selector-parser"
    parent = "postcss-nested"
    packages["node_modules/@tailwindcss/typography"]["dependencies"] = {selector: "6.0.10"}
    packages["node_modules/tailwindcss"]["dependencies"].update(
        {parent: "^6.2.0", selector: "^6.1.2"}
    )
    packages["node_modules/tailwindcss"]["peer"] = True
    packages["node_modules/postcss-nested"] = {
        "version": "6.2.0",
        "dev": True,
        "dependencies": {selector: "^6.1.1"},
        "peerDependencies": {"postcss": "^8.2.14"},
    }
    selector_nodes = [
        ("node_modules/postcss-nested/node_modules/postcss-selector-parser", "6.1.4"),
        ("node_modules/postcss-selector-parser", "6.0.10"),
        ("node_modules/tailwindcss/node_modules/postcss-selector-parser", "6.1.4"),
    ]
    for node, version in selector_nodes:
        packages[node] = {"version": version, "dev": True}
    findings["@tailwindcss/typography"].update(
        severity="moderate",
        via=[selector],
        range="<=0.0.0-insiders.fda8ce5 || >=0.5.5",
        fixAvailable={"name": "@tailwindcss/typography", "version": "0.5.4", "isSemVerMajor": True},
    )
    findings[parent] = {
        "name": parent,
        "severity": "moderate",
        "isDirect": False,
        "via": [selector],
        "effects": [],
        "range": "2.0.3 - 6.2.0",
        "nodes": ["node_modules/postcss-nested"],
        "fixAvailable": True,
    }
    findings[selector] = {
        "name": selector,
        "severity": "moderate",
        "isDirect": False,
        "via": [
            {
                "source": 1241232,
                "name": selector,
                "dependency": selector,
                "title": "PostCSS: Quadratic complexity in flat selector parsing allows CPU exhaustion",
                "url": "https://github.com/advisories/GHSA-rj75-hqrm-r3gf",
                "severity": "moderate",
                "cwe": ["CWE-400", "CWE-407"],
                "cvss": {
                    "score": 5.9,
                    "vectorString": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H",
                },
                "range": "<7.1.6",
            }
        ],
        "effects": ["@tailwindcss/typography", parent, "tailwindcss"],
        "range": "<7.1.6",
        "nodes": [node for node, _ in selector_nodes],
        "fixAvailable": {
            "name": "@tailwindcss/typography",
            "version": "0.5.4",
            "isSemVerMajor": True,
        },
    }
    findings["tailwindcss"].update(
        via=["chokidar", "fast-glob", "micromatch", parent, selector],
        effects=[],
        range="<=0.0.0-oxide-insiders.ff2c25f || 0.5.0 - 3.4.19",
    )
    for name in ("@next/eslint-plugin-next", "eslint-config-next", "fast-glob"):
        findings[name]["fixAvailable"] = {
            "name": "eslint-config-next",
            "version": "14.2.35",
            "isSemVerMajor": True,
        }
    report["metadata"]["vulnerabilities"].update(high=7, moderate=3, total=10)
    report["metadata"]["dependencies"].update(dev=13, peer=1, total=13)
    return report, lock


def test_historical_selector_and_braces_ten_name_graph_is_rejected(inputs_ten):
    report, lock = inputs_ten
    with pytest.raises(
        FrontendAuditError, match="Findings differ from the reviewed exception chain"
    ):
        validate_audit(report, lock)


def test_cli_rejects_historical_ten_name_graph_without_exception_output(
    tmp_path, inputs_ten, capsys
):
    from scripts.check_frontend_audit import main

    report, lock = inputs_ten
    report_path, lock_path = tmp_path / "audit.json", tmp_path / "lock.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    assert main(["--report", str(report_path), "--lock", str(lock_path)]) == 1
    output = capsys.readouterr()
    assert output.out == ""
    assert output.err == (
        "Frontend audit rejected: Findings differ from the reviewed exception chain.\n"
    )


@pytest.mark.parametrize("input_fixture", ["inputs", "inputs_eight"])
def test_cli_allowed_braces_graph_does_not_report_retired_selector_exception(
    tmp_path, request, input_fixture, capsys
):
    from scripts.check_frontend_audit import main

    report, lock = request.getfixturevalue(input_fixture)
    report_path, lock_path = tmp_path / "audit.json", tmp_path / "lock.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    lock_path.write_text(json.dumps(lock), encoding="utf-8")
    assert main(["--report", str(report_path), "--lock", str(lock_path)]) == 0
    output = capsys.readouterr()
    assert output.err == ""
    assert "UNRESOLVED development exception GHSA-vfj7-8cjw-p6xm" in output.out
    assert "GHSA-rj75-hqrm-r3gf" not in output.out
    assert "not zero vulnerabilities" in output.out
