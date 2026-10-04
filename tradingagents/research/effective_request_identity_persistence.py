"""One immutable outer-request assessment per completed run, across processes."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile

from tradingagents.evidence.persistence import _writer_lock
from tradingagents.memory.schema import canonical_json, parse_json
from .effective_request_identity import (
    EffectiveRequestIdentityError,
    assess_effective_request_identity,
    validate_effective_request_identity,
)

MAX_ASSESSMENT_BYTES = 64 * 1024 * 1024


class EffectiveRequestIdentityPersistenceError(OSError):
    def __init__(self):
        super().__init__("Effective outer-request assessment could not be saved or loaded")


def freeze_effective_request_identity(storage_dir, evidence, snapshot, *, existing=None):
    """Reuse the first reviewed clock and reject changed saved inputs or core.

    The existing Evidence run lock serializes this immutable publication with
    Evidence and ReportTextSnapshot owners. The caller decides whether this is
    a new marked completion; this function never mutates legacy attachments.
    """
    temporary = None
    try:
        candidate = (
            validate_effective_request_identity(existing, evidence, snapshot)
            if existing is not None
            else assess_effective_request_identity(evidence, snapshot)
        )
        directory = Path(storage_dir) / candidate["run_id"]
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        destination = directory / "effective_request_identity.json"
        with _writer_lock(directory):
            try:
                with destination.open("rb") as handle:
                    payload = handle.read(MAX_ASSESSMENT_BYTES + 1)
            except FileNotFoundError:
                payload = None
            if payload is not None:
                if len(payload) > MAX_ASSESSMENT_BYTES:
                    raise EffectiveRequestIdentityError()
                saved = validate_effective_request_identity(parse_json(payload), evidence, snapshot)
                if existing is not None and saved != candidate:
                    raise EffectiveRequestIdentityError()
                return saved
            serialized = canonical_json(candidate).encode("utf-8")
            if len(serialized) > MAX_ASSESSMENT_BYTES:
                raise EffectiveRequestIdentityError()
            with tempfile.NamedTemporaryFile("wb", dir=directory, delete=False) as output:
                temporary = output.name
                os.chmod(temporary, 0o600)
                output.write(serialized)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
            temporary = None
            if os.name != "nt":
                descriptor = os.open(directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            return candidate
    except OSError:
        raise EffectiveRequestIdentityPersistenceError() from None
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        raise EffectiveRequestIdentityError() from None
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass
