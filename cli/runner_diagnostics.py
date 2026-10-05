"""Dispatch bootstrap diagnostics before importing the research runtime."""

import json
import os
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


def memory_inventory_requested(payload: dict) -> bool:
    flag = payload.get("memoryInventory", False)
    if not isinstance(flag, bool):
        raise ValueError("memoryInventory must be a boolean")
    if flag and verify_runtime_requested(payload):
        raise ValueError("Conflicting runner diagnostic flags")
    return flag


def _request_fields(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Runner request contains duplicate fields")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError("Runner request contains invalid JSON numbers")


def read_request() -> dict:
    payload = json.loads(
        sys.stdin.read() or "{}",
        object_pairs_hook=_request_fields,
        parse_constant=_invalid_constant,
    )
    if not isinstance(payload, dict):
        raise ValueError("Runner request must be a JSON object")
    return payload


def read_memory_inventory(payload):
    previous = os.environ.get("EVIDENCELOOM_BOOTSTRAP_ONLY")
    os.environ["EVIDENCELOOM_BOOTSTRAP_ONLY"] = "1"
    try:
        from .memory_inventory import inventory

        return inventory(payload)
    finally:
        if previous is None:
            os.environ.pop("EVIDENCELOOM_BOOTSTRAP_ONLY", None)
        else:
            os.environ["EVIDENCELOOM_BOOTSTRAP_ONLY"] = previous


def bootstrap() -> tuple[int | None, dict | None]:
    """Read stdin once; return ordinary analysis requests to the existing main."""
    try:
        payload = read_request()
        command = payload.get("__command")
        if command == "smoke_test":
            verify_runtime = verify_runtime_requested(payload)
            memory_requested = memory_inventory_requested(payload)
            if memory_requested:
                emit(read_memory_inventory(payload))
                return 0, None
            if not verify_runtime:
                emit({"type": "ready"})
                return 0, None
            return None, payload
        if command == "evidence_manifest":
            # __file__ has this same relative location in a PyInstaller PYZ.
            # The spec retains the readable tradingagents sources beside it.
            package = Path(__file__).resolve().parents[1] / "tradingagents"
            emit(research_manifest(package))
            return 0, None
        if command is not None and command not in {"resolve_instrument", "load_ohlcv_chart"}:
            raise ValueError("Unknown runner command")
        return None, payload
    except Exception as exc:  # noqa: BLE001 - bootstrap failures must remain visible
        if isinstance(exc, json.JSONDecodeError):
            # JSONDecodeError's message contains syntax and position, never input.
            error = str(exc)
        elif isinstance(exc, ValueError) and str(exc) in {
            "Runner request must be a JSON object",
            "Runner request contains duplicate fields",
            "Runner request contains invalid JSON numbers",
            "verifyRuntime must be a boolean",
            "memoryInventory must be a boolean",
            "Conflicting runner diagnostic flags",
            "Unknown runner command",
            "Invalid research memory inventory request",
            "Research memory inventory exceeds its size limit",
            "Research source files could not be read for code verification",
            "Research source files are unavailable for code and prompt verification",
        }:
            error = str(exc)
        else:
            error = "Runner diagnostic failed"
        emit_error(exc, error)
        return 1, None
