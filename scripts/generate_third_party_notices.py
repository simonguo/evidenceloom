#!/usr/bin/env python3
"""Generate a deterministic dependency/license inventory for release bundles."""

from __future__ import annotations

import importlib.metadata
import json
import re
import subprocess
from pathlib import Path

from packaging.markers import default_environment
from packaging.requirements import Requirement

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10
    import tomli as tomllib

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "THIRD_PARTY_NOTICES.md"
FORBIDDEN_LICENSE = re.compile(r"\b(?:AGPL|GPL|SSPL)(?:[- v]?\d[^ ]*)?\b", re.IGNORECASE)
PYTHON_LICENSE_CLASSIFIERS = {
    "License :: OSI Approved :: Apache Software License": "Apache-2.0",
    "License :: OSI Approved :: BSD License": "BSD",
    "License :: OSI Approved :: ISC License (ISCL)": "ISC",
    "License :: OSI Approved :: MIT License": "MIT",
    "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "License :: OSI Approved :: Python Software Foundation License": "PSF-2.0",
}
PYTHON_LICENSE_OVERRIDES = {
    # peewee 4.2.6 ships an MIT LICENSE file but declares no license metadata.
    ("peewee", "4.2.6"): "MIT",
}


def normalize_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def existing_packages(title: str) -> dict[tuple[str, str], tuple[str, str, str, str]]:
    """Read previously observed target-specific metadata from the generated inventory."""
    if not OUTPUT.is_file():
        return {}
    packages: dict[tuple[str, str], tuple[str, str, str, str]] = {}
    in_section = False
    row_pattern = re.compile(r"^\| `([^`]+)` \| `([^`]+)` \| (.*?) \| (.*?) \|$")
    for line in OUTPUT.read_text(encoding="utf-8").splitlines():
        if line == f"## {title}":
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if not in_section:
            continue
        match = row_pattern.match(line)
        if not match:
            continue
        name, version, license_value, project = match.groups()
        homepage = project[7:-1] if project.startswith("[link](") and project.endswith(")") else ""
        packages[(normalize_name(name), version)] = (name, version, license_value, homepage)
    return packages


def prefer_existing_metadata(
    existing: tuple[str, str, str, str],
    observed: tuple[str, str, str, str],
    *,
    preserve_homepage: bool = True,
) -> tuple[str, str, str, str]:
    """Keep stable metadata while filling any gaps found on the current build target."""
    name, version, existing_license, existing_homepage = existing
    _, _, observed_license, observed_homepage = observed
    license_value = (
        observed_license
        if existing_license == "UNKNOWN" and observed_license != "UNKNOWN"
        else existing_license
    )
    homepage = existing_homepage or observed_homepage if preserve_homepage else observed_homepage
    return name, version, license_value, homepage


def locked_python_packages() -> set[tuple[str, str]]:
    lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    return {
        (normalize_name(package["name"]), str(package["version"]))
        for package in lock.get("package", [])
    }


def python_packages() -> list[tuple[str, str, str, str]]:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    pending = [dependency_name(item) for item in project["project"]["dependencies"]]
    distributions = {
        normalize_name(distribution.metadata["Name"]): distribution
        for distribution in importlib.metadata.distributions()
        if distribution.metadata.get("Name")
    }
    discovered: dict[str, tuple[str, str, str, str]] = {}
    while pending:
        normalized = normalize_name(pending.pop())
        if normalized in discovered:
            continue
        distribution = distributions.get(normalized)
        if distribution is None:
            discovered[normalized] = (normalized, "not-installed", "UNKNOWN", "")
            continue
        metadata = distribution.metadata
        name = metadata.get("Name", normalized)
        license_value = PYTHON_LICENSE_OVERRIDES.get(
            (normalized, distribution.version), declared_python_license(metadata)
        )
        homepage = project_url(metadata)
        discovered[normalized] = (
            name,
            distribution.version,
            clean_license(license_value),
            homepage,
        )
        for raw_requirement in distribution.requires or []:
            requirement = Requirement(raw_requirement)
            environment = default_environment() | {"extra": ""}
            if requirement.marker is None or requirement.marker.evaluate(environment):
                pending.append(requirement.name)
    packages = {
        key: package
        for key, package in existing_packages("Python runtime").items()
        if key in locked_python_packages()
    }
    for package in discovered.values():
        key = (normalize_name(package[0]), package[1])
        packages[key] = (
            prefer_existing_metadata(packages[key], package) if key in packages else package
        )
    return sorted(packages.values(), key=lambda item: (item[0].lower(), item[1]))


def node_packages() -> list[tuple[str, str, str, str]]:
    lock = json.loads((ROOT / "frontend" / "package-lock.json").read_text(encoding="utf-8"))
    existing = existing_packages("Node.js frontend")
    packages: dict[tuple[str, str], tuple[str, str, str, str]] = {}
    for path, metadata in lock.get("packages", {}).items():
        if not path or "node_modules/" not in path:
            continue
        name = package_name_from_path(path)
        version = str(metadata.get("version", "UNKNOWN"))
        installed_metadata = installed_node_metadata(path, version)
        license_value = clean_license(
            metadata.get("license")
            or installed_metadata.get("license")
            or node_family_license(name)
            or "UNKNOWN"
        )
        # package-lock.json is platform independent, while package.json files under
        # node_modules only exist for native packages installed on the current host.
        # Using the latter for project URLs makes the generated inventory drift
        # between macOS, Linux, and Windows.
        homepage = node_project_url(metadata)
        package = (name, version, license_value, homepage)
        key = (normalize_name(name), version)
        packages[key] = (
            prefer_existing_metadata(existing[key], package, preserve_homepage=False)
            if key in existing
            else package
        )
    return sorted(packages.values(), key=lambda item: (item[0].lower(), item[1]))


def rust_packages() -> list[tuple[str, str, str, str]]:
    result = subprocess.run(
        [
            "cargo",
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--manifest-path",
            str(ROOT / "src-tauri" / "Cargo.toml"),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    metadata = json.loads(result.stdout)
    root_package = "evidenceloom-desktop"
    packages = {
        (package["name"], package["version"]): (
            package["name"],
            package["version"],
            clean_license(package.get("license") or "UNKNOWN"),
            package.get("homepage") or package.get("repository") or "",
        )
        for package in metadata["packages"]
        if package["name"] != root_package
    }
    return sorted(packages.values(), key=lambda item: (item[0].lower(), item[1]))


def dependency_name(requirement: str) -> str:
    match = re.match(r"\s*([A-Za-z0-9_.-]+)", requirement)
    if not match:
        raise ValueError(f"Cannot parse dependency requirement: {requirement}")
    return match.group(1)


def declared_python_license(metadata: importlib.metadata.PackageMetadata) -> str:
    expression = metadata.get("License-Expression")
    if expression:
        return clean_license(expression)
    classifiers = {
        PYTHON_LICENSE_CLASSIFIERS[classifier]
        for classifier in metadata.get_all("Classifier") or []
        if classifier in PYTHON_LICENSE_CLASSIFIERS
    }
    if classifiers:
        return " OR ".join(sorted(classifiers))
    license_value = metadata.get("License") or "UNKNOWN"
    if "Permission is hereby granted, free of charge" in license_value:
        return "MIT"
    return clean_license(license_value)


def installed_node_metadata(path: str, expected_version: str) -> dict:
    package_json = ROOT / "frontend" / path / "package.json"
    if not package_json.is_file():
        return {}
    metadata = json.loads(package_json.read_text(encoding="utf-8"))
    return metadata if str(metadata.get("version")) == expected_version else {}


def node_family_license(name: str) -> str:
    if name.startswith("@tauri-apps/cli-"):
        return "Apache-2.0 OR MIT"
    if name.startswith("@unrs/resolver-binding-") or name == "@emnapi/runtime":
        return "MIT"
    return ""


def node_project_url(metadata: dict) -> str:
    homepage = metadata.get("homepage")
    if isinstance(homepage, str):
        return homepage
    repository = metadata.get("repository")
    if isinstance(repository, str):
        return repository
    if isinstance(repository, dict):
        return str(repository.get("url", ""))
    return ""


def project_url(metadata: importlib.metadata.PackageMetadata) -> str:
    for value in metadata.get_all("Project-URL") or []:
        _, separator, url = value.partition(",")
        if separator and url.strip().startswith("http"):
            return url.strip()
    return metadata.get("Home-page") or ""


def package_name_from_path(path: str) -> str:
    suffix = path.rsplit("node_modules/", 1)[1]
    if suffix.startswith("@"):
        return suffix
    return suffix.rsplit("/", 1)[-1]


def clean_license(value: object) -> str:
    text = " ".join(str(value).split())
    return text[:160] if text else "UNKNOWN"


def render_section(title: str, packages: list[tuple[str, str, str, str]]) -> str:
    rows = [
        f"## {title}",
        "",
        "| Package | Version | Declared license | Project |",
        "| --- | --- | --- | --- |",
    ]
    for name, version, license_value, homepage in packages:
        project = f"[link]({homepage})" if homepage.startswith("http") else "—"
        rows.append(f"| `{name}` | `{version}` | {license_value.replace('|', '/')} | {project} |")
    rows.append("")
    return "\n".join(rows)


def validate_licenses(sections: dict[str, list[tuple[str, str, str, str]]]) -> None:
    incompatible: list[str] = []
    for ecosystem, packages in sections.items():
        for name, version, license_value, _ in packages:
            # A permissive alternative in an explicit dual-license expression can be selected.
            dual_permissive = " OR " in license_value.upper() and re.search(
                r"\b(?:MIT|APACHE|BSD|ISC)\b", license_value, re.IGNORECASE
            )
            if FORBIDDEN_LICENSE.search(license_value) and not dual_permissive:
                incompatible.append(f"{ecosystem}: {name} {version} ({license_value})")
    if incompatible:
        details = "\n".join(f"- {item}" for item in incompatible)
        raise SystemExit(f"Incompatible strong-copyleft runtime licenses detected:\n{details}")


def main() -> None:
    sections = {
        "Python runtime": python_packages(),
        "Node.js frontend": node_packages(),
        "Rust desktop": rust_packages(),
    }
    validate_licenses(sections)
    content = """# Third-party notices

Evidence Loom includes third-party open-source software. This generated inventory records package versions and their declared license metadata; the corresponding source distributions and license texts remain authoritative. Target-specific rows that remain in the lockfiles are retained so the inventory is stable across supported release hosts. Regenerate it after dependency changes with:

```bash
uv run python scripts/generate_third_party_notices.py
```

"""
    for title, packages in sections.items():
        content += render_section(title, packages)
    OUTPUT.write_text(content, encoding="utf-8")


if __name__ == "__main__":
    main()
