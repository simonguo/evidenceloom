"""Dispatch bootstrap diagnostics before importing the research runtime."""

import json
from pathlib import Path
import sys

from .research_manifest import research_manifest
from .runner_protocol import emit


def emit_error(exc: Exception, error: str) -> None:
    """Emit a caller-supplied safe diagnostic, never the exception's body."""
    print(
        f"Evidence Loom runner error ({type(exc).__name__}): {error}",
        file=sys.stderr,
        flush=True,
    )
    emit({"type": "error", "error": error, "message": error, "messageType": "Error"})


def verify_runtime_requested(payload: dict) -> bool:
    flag = payload.get("verifyRuntime", False)
    if not isinstance(flag, bool):
        raise ValueError("verifyRuntime must be a boolean")
    return flag


def bootstrap() -> tuple[int | None, dict | None]:
    """Read stdin once; return ordinary analysis requests to the existing main."""
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if not isinstance(payload, dict):
            raise ValueError("Runner request must be a JSON object")
        command = payload.get("__command")
        if command == "smoke_test":
            if not verify_runtime_requested(payload):
                emit({"type": "ready"})
                return 0, None
            return None, payload
        if command == "evidence_manifest":
            # __file__ has this same relative location in a PyInstaller PYZ.
            # The spec retains the readable tradingagents sources beside it.
            package = Path(__file__).resolve().parents[1] / "tradingagents"
            emit(research_manifest(package))
            return 0, None
        return None, payload
    except Exception as exc:  # noqa: BLE001 - bootstrap failures must remain visible
        if isinstance(exc, json.JSONDecodeError):
            # JSONDecodeError's message contains syntax and position, never input.
            error = str(exc)
        elif isinstance(exc, ValueError) and str(exc) in {
            "Runner request must be a JSON object",
            "verifyRuntime must be a boolean",
            "Research source files could not be read for code verification",
            "Research source files are unavailable for code and prompt verification",
        }:
            error = str(exc)
        else:
            error = "Runner diagnostic failed"
        emit_error(exc, error)
        return 1, None
