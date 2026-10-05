"""Hash the research core's readable sources without importing its runtime.

The manifest scope remains tradingagents/**/*.py, with prompts restricted to
tradingagents/agents/**/*.py. CLI and desktop application sources are outside
these hashes, as they were before this helper was shared with diagnostics.
"""

import hashlib
import json
from pathlib import Path


def context_sha256(value) -> str:
    """Hash reproducibility inputs using the evidence bundle's canonical JSON."""
    return hashlib.sha256(
        json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
        ).encode("utf-8")
    ).hexdigest()


def source_code_sha256(directory: Path) -> str:
    """Hash local source content, without exposing its absolute filesystem path."""
    try:
        sources = {
            path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(directory.rglob("*.py"))
        }
    except OSError:
        raise ValueError("Research source files could not be read for code verification") from None
    if not sources:
        raise ValueError("Research source files are unavailable for code and prompt verification")
    return context_sha256(sources)


def research_manifest(package: Path) -> dict:
    return {
        "type": "evidence_ready",
        "schema_version": 1,
        "code_sha256": source_code_sha256(package),
        "prompt_templates_sha256": source_code_sha256(package / "agents"),
        "source_file_count": len(list(package.rglob("*.py"))),
    }
