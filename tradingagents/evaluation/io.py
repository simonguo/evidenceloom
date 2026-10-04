"""Bounded inputs and atomic, durable, no-overwrite evaluation outputs."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile

from tradingagents.memory.schema import canonical_json, parse_json

from .guards import MAX_BYTES, FrozenEvaluationError, FrozenEvaluationIOError
from .runner import evaluate_pack, validate_evaluation_result


def read_pack(path):
    try:
        with Path(path).open("rb") as source:
            payload = source.read(MAX_BYTES + 1)
        if len(payload) > MAX_BYTES:
            raise FrozenEvaluationError()
        return parse_json(payload)
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        raise FrozenEvaluationIOError() from None


def write_result(path, result, pack):
    """Validate before touching output; hard-link publication never overwrites.

    A failed link leaves an existing output byte-for-byte intact. The owned
    temporary file is fsynced, always unlinked, and the containing directory is
    fsynced where directory descriptors are supported by the host filesystem.
    """
    captured = validate_evaluation_result(result, pack)
    payload = (canonical_json(captured) + "\n").encode("utf-8")
    if len(payload) > MAX_BYTES:
        raise FrozenEvaluationIOError()
    output, temporary = Path(path), None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".frozen-evaluation-", suffix=".tmp", dir=output.parent, delete=False
        ) as target:
            temporary = Path(target.name)
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        os.link(temporary, output)
        if os.name != "nt":
            descriptor = os.open(output.parent, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return output
    except (OSError, ValueError, TypeError):
        raise FrozenEvaluationIOError() from None
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                raise FrozenEvaluationIOError() from None


def evaluate_file(input_path, output_path):
    """Read one pack, derive and verify it, then publish exactly one new file."""
    pack = read_pack(input_path)
    result = evaluate_pack(pack)
    write_result(output_path, result, pack)
    return result
