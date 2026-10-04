"""One immutable report text snapshot per completed run across processes."""

from __future__ import annotations

import os
from pathlib import Path
import tempfile

from tradingagents.evidence.persistence import _writer_lock
from tradingagents.memory.schema import canonical_json, parse_json
from .numeric_review import (
    NumericReviewError,
    REPORT_SECTION_KEYS,
    make_report_text_snapshot,
    validate_report_text_snapshot,
)

MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024


class ReportSnapshotPersistenceError(OSError):
    def __init__(self):
        super().__init__("Report text snapshot could not be saved or loaded")


def freeze_report_text_snapshot(storage_dir, evidence, report_sections, *, existing=None):
    """Return the first saved snapshot; reject any subsequent changed core.

    A retry reuses the first capture timestamp. The Evidence run's existing
    process lock serializes publication with other owners of the same run.
    """
    temporary = None
    try:
        candidate = (
            validate_report_text_snapshot(existing, evidence)
            if existing is not None
            else make_report_text_snapshot(evidence, report_sections)
        )
        sections = {key: report_sections.get(key) for key in REPORT_SECTION_KEYS}
        if sections != candidate["report_sections"]:
            raise NumericReviewError()
        directory = Path(storage_dir) / candidate["run_id"]
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        destination = directory / "report_text_snapshot.json"
        with _writer_lock(directory):
            try:
                with destination.open("rb") as handle:
                    payload = handle.read(MAX_SNAPSHOT_BYTES + 1)
            except FileNotFoundError:
                payload = None
            if payload is not None:
                if len(payload) > MAX_SNAPSHOT_BYTES:
                    raise NumericReviewError()
                saved = validate_report_text_snapshot(parse_json(payload), evidence)
                if (
                    saved["report_sections"] != sections
                    or existing is not None
                    and saved != candidate
                ):
                    raise NumericReviewError()
                return saved
            serialized = canonical_json(candidate)
            if len(serialized.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
                raise NumericReviewError()
            with tempfile.NamedTemporaryFile(
                "w", dir=directory, encoding="utf-8", delete=False
            ) as output:
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
        raise ReportSnapshotPersistenceError() from None
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        raise NumericReviewError() from None
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass
