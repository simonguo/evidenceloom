"""Serialize memory-log writers and publish complete UTF-8 files atomically."""

import errno
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def locked_memory_file(path: Path):
    with open(f"{path}.lock", "a+b") as handle:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            if not handle.read(1):
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError as exc:
                    if exc.errno != errno.EDEADLOCK:
                        raise
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def write_memory_file(path: Path, text: str) -> None:
    """A failed write keeps the prior log and propagates its error to the caller."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f"{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
