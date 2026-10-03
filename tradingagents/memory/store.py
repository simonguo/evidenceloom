"""Durable per-run memory authority, independent of model-written Markdown."""

from __future__ import annotations

from contextlib import contextmanager
from copy import deepcopy
import errno
import hashlib
import os
from pathlib import Path
import tempfile
from threading import RLock
from uuid import UUID

from .schema import (
    MAX_BYTES,
    MemoryValidationError,
    SELECTOR_VERSION,
    canonical_json,
    hash_value,
    instrument_key,
    make_artifact,
    make_component,
    merge_decision,
    now_utc,
    parse_json,
    render_context,
    utc_timestamp,
    validate_bundle,
    validate_context_snapshot,
    validate_decision,
)


class MemoryPersistenceError(OSError):
    def __init__(self):
        super().__init__("Research memory could not be persisted or loaded")


def _run_id(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise MemoryValidationError()
    except (ValueError, AttributeError):
        raise MemoryValidationError() from None
    return value


@contextmanager
def _writer_lock(directory):
    descriptor = os.open(directory / ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    locked = False
    try:
        os.chmod(directory / ".lock", 0o600)
        if os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"\0")
            os.fsync(descriptor)
        os.lseek(descriptor, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt

            while True:
                try:
                    msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
                    break
                except OSError as error:
                    if error.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLOCK):
                        raise
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX)
        locked = True
        yield
    finally:
        try:
            if locked:
                if os.name == "nt":
                    import msvcrt

                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(descriptor, fcntl.LOCK_UN)
        finally:
            os.close(descriptor)


def _fsync_directory(directory):
    if os.name == "nt":
        return  # Windows does not expose a stdlib directory fsync.
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.ENOTSUP):
                raise
    finally:
        os.close(descriptor)


def _private_directory(directory):
    missing = []
    current = directory
    while not current.exists():
        missing.append(current)
        current = current.parent
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    # Persist each newly created directory entry, not only the final file name.
    for created in reversed(missing):
        _fsync_directory(created.parent)


def _read(directory, run_id):
    try:
        with (directory / "decision.json").open("rb") as handle:
            payload = handle.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return None
    value = validate_decision(parse_json(payload))
    if value["run_id"] != run_id:
        raise MemoryValidationError()
    return value


def _atomic_write(directory, value, filename="decision.json"):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", dir=directory, encoding="utf-8", delete=False
        ) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            handle.write(canonical_json(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, directory / filename)
        temporary = None
        _fsync_directory(directory)
    finally:
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass


class MemoryStore:
    """Exact immutable records; no path explicitly means memory-only persistence."""

    def __init__(self, memory_log_path=None, *, storage_dir=None):
        try:
            self.storage_dir = (
                Path(storage_dir).expanduser()
                if storage_dir is not None
                else Path(memory_log_path).expanduser().parent / "decisions-v1"
                if memory_log_path
                else None
            )
        except (ValueError, TypeError, OSError):
            raise MemoryPersistenceError() from None
        self.persistence_status = "durable" if self.storage_dir is not None else "memory_only"
        self._records = {}
        self._bundles = {}
        self._mutex = RLock()

    def record_decision(self, snapshot) -> dict:
        candidate = validate_decision(snapshot)
        with self._mutex:
            if self.storage_dir is None:
                previous = self._records.get(candidate["run_id"])
                saved = merge_decision(previous, candidate) if previous is not None else candidate
                self._records[candidate["run_id"]] = deepcopy(saved)
                return deepcopy(saved)
            try:
                _private_directory(self.storage_dir)
                directory = self.storage_dir / candidate["run_id"]
                _private_directory(directory)
                with _writer_lock(directory):
                    previous = _read(directory, candidate["run_id"])
                    saved = (
                        merge_decision(previous, candidate) if previous is not None else candidate
                    )
                    if previous != saved:
                        _atomic_write(directory, saved)
                return deepcopy(saved)
            except OSError:
                raise MemoryPersistenceError() from None
            except (TypeError, ValueError, UnicodeError, RecursionError):
                raise MemoryValidationError() from None

    def load_decision(self, run_id) -> dict | None:
        run_id = _run_id(run_id)
        with self._mutex:
            if self.storage_dir is None:
                value = self._records.get(run_id)
                return validate_decision(value) if value is not None else None
            try:
                directory = self.storage_dir / run_id
                if not directory.exists():
                    return None
                # Atomic replace publishes a complete old/new image. Read-only
                # inventory must not create or chmod even a lock file.
                return _read(directory, run_id)
            except OSError:
                raise MemoryPersistenceError() from None
            except (TypeError, ValueError, UnicodeError, RecursionError):
                raise MemoryValidationError() from None

    def list_decisions(self) -> list[dict]:
        with self._mutex:
            if self.storage_dir is None:
                return [validate_decision(value) for _, value in sorted(self._records.items())]
            try:
                if not self.storage_dir.exists():
                    return []
                ids = []
                for directory in self.storage_dir.iterdir():
                    if not directory.is_dir():
                        continue
                    try:
                        ids.append(_run_id(directory.name))
                    except MemoryValidationError:
                        continue  # Non-UUID folders cannot supply authoritative records.
                values = [self.load_decision(run_id) for run_id in sorted(ids)]
                return [value for value in values if value is not None]
            except OSError:
                raise MemoryPersistenceError() from None

    def _attach(self, run_id, field, component, artifacts):
        with self._mutex:
            current = self.load_decision(run_id)
            if current is None or not isinstance(artifacts, dict):
                raise MemoryValidationError()
            candidate = deepcopy(current)
            candidate[field] = deepcopy(component)
            for key, artifact in artifacts.items():
                if key in candidate["artifacts"] and candidate["artifacts"][key] != artifact:
                    raise MemoryValidationError()
                candidate["artifacts"][key] = deepcopy(artifact)
            candidate = make_component(candidate, "snapshot_sha256")
            return self.record_decision(candidate)

    def attach_outcome(self, run_id, outcome, artifacts) -> dict:
        if outcome is None:
            raise MemoryValidationError()  # Pending is not a completed immutable outcome.
        return self._attach(run_id, "outcome", outcome, artifacts)

    def attach_reflection(self, run_id, reflection, artifacts) -> dict:
        if reflection is None:
            raise MemoryValidationError()
        return self._attach(run_id, "reflection", reflection, artifacts)

    def context_snapshot(
        self,
        instrument,
        research_cutoff,
        *,
        selected_at=None,
        same_ticker_limit=5,
        cross_ticker_limit=3,
    ) -> dict:
        selected_at = selected_at if selected_at is not None else now_utc()
        cutoff = min(utc_timestamp(selected_at), utc_timestamp(research_cutoff))
        cutoff_text = (
            selected_at
            if utc_timestamp(selected_at) <= utc_timestamp(research_cutoff)
            else research_cutoff
        )
        eligible = []
        for item in self.list_decisions():
            outcome, reflection = item["outcome"], item["reflection"]
            if outcome is None or reflection is None or outcome["status"] != "available":
                continue
            if all(
                utc_timestamp(timestamp) <= cutoff
                for timestamp in (
                    item["decision"]["recorded_at"],
                    outcome["observed_at"],
                    reflection["reflected_at"],
                )
            ):
                eligible.append(item)
        eligible.sort(
            key=lambda item: (
                utc_timestamp(item["reflection"]["reflected_at"]),
                utc_timestamp(item["decision"]["recorded_at"]),
                item["run_id"],
            ),
            reverse=True,
        )
        # Validate limits before slicing so negative/bool values cannot alter selection.
        if (
            not isinstance(instrument, str)
            or not instrument
            or type(same_ticker_limit) is not int
            or type(cross_ticker_limit) is not int
            or not 0 <= same_ticker_limit <= 128
            or not 0 <= cross_ticker_limit <= 128
        ):
            raise MemoryValidationError()
        same = [
            item
            for item in eligible
            if instrument_key(item["decision"]["instrument"]) == instrument_key(instrument)
        ][:same_ticker_limit]
        cross = [
            item
            for item in eligible
            if instrument_key(item["decision"]["instrument"]) != instrument_key(instrument)
        ][:cross_ticker_limit]
        decisions = same + cross
        text = render_context(instrument, decisions)
        value = make_component(
            {
                "schema_version": 1,
                "instrument": instrument,
                "selected_at": selected_at,
                "research_cutoff": research_cutoff,
                "availability_cutoff": cutoff_text,
                "selector_version": SELECTOR_VERSION,
                "same_ticker_limit": same_ticker_limit,
                "cross_ticker_limit": cross_ticker_limit,
                "decisions": decisions,
                "context_artifact": make_artifact("text", text),
                "raw_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "context_sha256": hash_value(text),
            },
            "input_sha256",
        )
        return validate_context_snapshot(value)

    def bundle(self, run_id, input_snapshot, *, evidence_bundle_sha256) -> dict:
        run_id = _run_id(run_id)
        input_snapshot = validate_context_snapshot(input_snapshot)
        with self._mutex:
            if self.storage_dir is None:
                candidate = self._make_bundle(
                    self.load_decision(run_id), input_snapshot, evidence_bundle_sha256
                )
                previous = self._bundles.get(run_id)
                if previous is not None:
                    self._check_completion_retry(previous, candidate)
                    return deepcopy(previous)
                self._bundles[run_id] = deepcopy(candidate)
                return candidate
            try:
                directory = self.storage_dir / run_id
                if not directory.exists():
                    raise MemoryValidationError()
                with _writer_lock(directory):
                    candidate = self._make_bundle(
                        _read(directory, run_id), input_snapshot, evidence_bundle_sha256
                    )
                    previous = self._read_bundle(directory, run_id)
                    if previous is not None:
                        self._check_completion_retry(previous, candidate)
                        return previous
                    _atomic_write(directory, candidate, "completion.json")
                    return candidate
            except OSError:
                raise MemoryPersistenceError() from None
            except (TypeError, ValueError, UnicodeError, RecursionError):
                raise MemoryValidationError() from None

    def _make_bundle(self, snapshot, input_snapshot, evidence_sha):
        if snapshot is None:
            raise MemoryValidationError()
        decision = snapshot["decision"]
        return validate_bundle(
            make_component(
                {
                    "schema_version": 1,
                    "run_id": snapshot["run_id"],
                    "instrument": decision["instrument"],
                    "analysis_date": decision["analysis_date"],
                    "evidence_bundle_sha256": evidence_sha,
                    "persistence_status": self.persistence_status,
                    "input_snapshot": deepcopy(input_snapshot),
                    "decision_snapshot": snapshot,
                },
                "bundle_sha256",
            )
        )

    @staticmethod
    def _check_completion_retry(previous, candidate):
        for key in (
            "schema_version",
            "run_id",
            "instrument",
            "analysis_date",
            "evidence_bundle_sha256",
            "persistence_status",
            "input_snapshot",
        ):
            if previous[key] != candidate[key]:
                raise MemoryValidationError()
        if (
            merge_decision(previous["decision_snapshot"], candidate["decision_snapshot"])
            != candidate["decision_snapshot"]
        ):
            raise MemoryValidationError()

    @staticmethod
    def _read_bundle(directory, run_id):
        try:
            with (directory / "completion.json").open("rb") as handle:
                payload = handle.read(MAX_BYTES + 1)
        except FileNotFoundError:
            return None
        value = validate_bundle(parse_json(payload))
        if value["run_id"] != run_id:
            raise MemoryValidationError()
        return value

    def load_bundle(self, run_id) -> dict | None:
        run_id = _run_id(run_id)
        with self._mutex:
            if self.storage_dir is None:
                value = self._bundles.get(run_id)
                return validate_bundle(value) if value is not None else None
            try:
                return self._read_bundle(self.storage_dir / run_id, run_id)
            except OSError:
                raise MemoryPersistenceError() from None
            except (TypeError, ValueError, UnicodeError, RecursionError):
                raise MemoryValidationError() from None
