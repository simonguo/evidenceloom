"""Serialize durable evidence updates across independent processes."""

from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import tempfile

MAX_BUNDLE_BYTES = 64 * 1024 * 1024


@contextmanager
def _writer_lock(directory: Path):
    """Use a stable lock file; replacing the bundle must not replace its lock."""
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

            msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
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


def atomic_save_bundle(storage_dir, value, validate, merge, canonical):
    """Save a validated union while holding the run's cross-process writer lock.

    The returned bundle includes evidence saved by any previous run owner.
    Failures carry fixed messages, never filesystem paths or source content.
    """
    temporary = None
    try:
        candidate = validate(value)
        directory = Path(storage_dir) / candidate["run_id"]
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        destination = directory / "bundle.json"
        with _writer_lock(directory):
            try:
                with destination.open("rb") as existing:
                    payload = existing.read(MAX_BUNDLE_BYTES + 1)
            except FileNotFoundError:
                payload = None
            if payload is not None:
                if len(payload) > MAX_BUNDLE_BYTES:
                    raise ValueError("Evidence persistence exceeds its size bound")
                candidate = validate(merge(validate(json.loads(payload)), candidate))
            serialized = canonical(candidate)
            if (
                not isinstance(serialized, str)
                or len(serialized.encode("utf-8")) > MAX_BUNDLE_BYTES
            ):
                raise ValueError("Evidence persistence exceeds its size bound")
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
            return candidate
    except OSError:
        raise OSError("Research evidence could not be saved") from None
    except Exception:
        raise ValueError("Invalid or conflicting research evidence persistence state") from None
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass
