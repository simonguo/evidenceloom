"""Bounded, offline sidecar release probes with strict stdout JSONL validation."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

MAX_OUTPUT_BYTES = 64 * 1024
PROBE_TIMEOUT_SECONDS = 90


class ProbeError(ValueError):
    """A fixed diagnostic safe to show without subprocess output or paths."""


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProbeError("stdout contains duplicate JSON fields")
        result[key] = value
    return result


def _invalid_constant(value):
    raise ProbeError("stdout contains invalid JSON values")


def validate_stdout(output: bytes, stage: str) -> None:
    expected = {"bootstrap": "ready", "runtime": "runtime_ready"}[stage]
    try:
        lines = output.decode("utf-8", errors="strict").splitlines()
        if not output.endswith(b"\n") or len(lines) != 1:
            raise ProbeError("stdout must contain exactly one JSONL readiness event")
        event = json.loads(
            lines[0], object_pairs_hook=_unique_object, parse_constant=_invalid_constant
        )
        if not isinstance(event, dict) or set(event) - {"type", "timestamp"}:
            raise ProbeError("stdout contains an unexpected protocol event")
        if event.get("type") != expected:
            raise ProbeError("readiness stage mismatch or unsupported sidecar")
        if "timestamp" in event:
            if not isinstance(event["timestamp"], str) or not re.fullmatch(
                r"[0-9]{2}:[0-9]{2}:[0-9]{2}", event["timestamp"]
            ):
                raise ProbeError("stdout contains an invalid protocol timestamp")
            datetime.strptime(event["timestamp"], "%H:%M:%S")
    except (UnicodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        if isinstance(exc, ProbeError):
            raise
        raise ProbeError("stdout contains malformed readiness JSONL") from None


class _WindowsJob:
    """Keep one-file descendants in a kill-on-close job, including orphaned pipes."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_longlong),
                ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD),
                ("min_working_set", ctypes.c_size_t),
                ("max_working_set", ctypes.c_size_t),
                ("active_processes", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD),
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("basic", BasicLimits),
                ("io_counters", ctypes.c_ulonglong * 6),
                ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t),
            ]

        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.api.CreateJobObjectW.restype = wintypes.HANDLE
        self.api.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        self.api.SetInformationJobObject.restype = wintypes.BOOL
        self.api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self.api.AssignProcessToJobObject.restype = wintypes.BOOL
        self.api.CloseHandle.argtypes = [wintypes.HANDLE]
        self.api.CloseHandle.restype = wintypes.BOOL
        self.ctypes = ctypes
        self.wintypes = wintypes
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise ProbeError("process containment is unavailable")
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.api.SetInformationJobObject(
            self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            self.close()
            raise ProbeError("process containment is unavailable")

    def attach(self, process):
        if not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ProbeError("process containment is unavailable")

    def resume(self, process, deadline):
        """Resume the initial thread only after the suspended process joins its job."""
        ctypes, wintypes = self.ctypes, self.wintypes

        class ThreadEntry(ctypes.Structure):
            _fields_ = [
                ("size", wintypes.DWORD),
                ("usage", wintypes.DWORD),
                ("thread_id", wintypes.DWORD),
                ("owner_pid", wintypes.DWORD),
                ("base_priority", wintypes.LONG),
                ("delta_priority", wintypes.LONG),
                ("flags", wintypes.DWORD),
            ]

        self.api.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        self.api.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        for name in ("Thread32First", "Thread32Next"):
            function = getattr(self.api, name)
            function.argtypes = [wintypes.HANDLE, ctypes.POINTER(ThreadEntry)]
            function.restype = wintypes.BOOL
        self.api.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.api.OpenThread.restype = wintypes.HANDLE
        self.api.ResumeThread.argtypes = [wintypes.HANDLE]
        self.api.ResumeThread.restype = wintypes.DWORD
        snapshot = self.api.CreateToolhelp32Snapshot(0x00000004, 0)  # TH32CS_SNAPTHREAD
        if not snapshot or snapshot == ctypes.c_void_p(-1).value:
            raise ProbeError("suspended sidecar could not be resumed")
        try:
            entry = ThreadEntry()
            entry.size = ctypes.sizeof(entry)
            thread_ids = []
            found = self.api.Thread32First(snapshot, ctypes.byref(entry))
            while found:
                if time.monotonic() >= deadline:
                    raise ProbeError("readiness deadline exceeded")
                if entry.size >= 16 and entry.owner_pid == process.pid:
                    thread_ids.append(entry.thread_id)
                entry.size = ctypes.sizeof(entry)
                found = self.api.Thread32Next(snapshot, ctypes.byref(entry))
            if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
                raise ProbeError("suspended sidecar could not be resumed")
            if len(thread_ids) != 1:
                raise ProbeError("suspended sidecar could not be resumed")
            thread = self.api.OpenThread(0x0002, False, thread_ids[0])  # SUSPEND_RESUME
            if not thread:
                raise ProbeError("suspended sidecar could not be resumed")
            try:
                if time.monotonic() >= deadline:
                    raise ProbeError("readiness deadline exceeded")
                if self.api.ResumeThread(thread) != 1:
                    raise ProbeError("suspended sidecar could not be resumed")
            finally:
                if not self.api.CloseHandle(thread):
                    raise ProbeError("process containment cleanup failed")
        finally:
            if not self.api.CloseHandle(snapshot):
                raise ProbeError("process containment cleanup failed")

    def close(self):
        if self.handle:
            if not self.api.CloseHandle(self.handle):
                raise ProbeError("process containment cleanup failed")
            self.handle = None


def run_probe(command, stage: str, *, timeout=PROBE_TIMEOUT_SECONDS, output_limit=MAX_OUTPUT_BYTES):
    payload = {"__command": "smoke_test"}
    if stage == "runtime":
        payload["verifyRuntime"] = True
    elif stage != "bootstrap":
        raise ProbeError("unsupported readiness stage")
    if timeout <= 0:
        raise ProbeError("readiness deadline exceeded")
    deadline = time.monotonic() + timeout
    # Reserve a small portion of the same total budget for group termination
    # and reaping rather than adding an unbounded cleanup wait after expiry.
    work_deadline = deadline - min(0.1, timeout * 0.1)
    process = None
    anchor = None
    job = _WindowsJob() if os.name == "nt" else None
    readers = []
    completed = []
    overflow, read_failed = threading.Event(), threading.Event()
    output = bytearray()
    cleanup_failed = False

    def collect(stream, store, finished):
        total = 0
        try:
            while chunk := stream.read(4096):
                total += len(chunk)
                if total > output_limit:
                    overflow.set()
                    return
                if store:
                    output.extend(chunk)
        except (OSError, ValueError):
            read_failed.set()
        finally:
            finished.set()

    def stop_tree():
        nonlocal cleanup_failed
        try:
            if job is not None:
                job.close()
            elif anchor is not None:
                # The unreaped anchor pins this PGID even when a one-file
                # launcher exits while descendants retain its output pipes.
                os.killpg(anchor.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except (OSError, ValueError):
            cleanup_failed = True
        try:
            if process is not None and process.poll() is None:
                process.kill()
        except (OSError, ValueError):
            cleanup_failed = True

    try:
        try:
            environment = dict(os.environ)
            environment.update(
                {
                    "PYTHON_DOTENV_DISABLED": "1",
                    "LANGCHAIN_TRACING_V2": "false",
                    "LANGSMITH_TRACING": "false",
                }
            )
            if os.name != "nt":
                # Python 3.10 lacks process_group=. These two preexec hooks
                # perform only setpgid, before any output-reader threads exist.
                anchor = subprocess.Popen(
                    ["/bin/sleep", "120"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    preexec_fn=os.setpgrp,
                    env=environment,
                )
            process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                preexec_fn=(lambda: os.setpgid(0, anchor.pid)) if anchor is not None else None,
                creationflags=0x00000004 if os.name == "nt" else 0,  # CREATE_SUSPENDED
                env=environment,
            )
            if job is not None:
                job.attach(process)
                job.resume(process, work_deadline)
            for stream, store in ((process.stdout, True), (process.stderr, False)):
                finished = threading.Event()
                completed.append(finished)
                reader = threading.Thread(
                    target=collect, args=(stream, store, finished), daemon=True
                )
                readers.append(reader)
                reader.start()
            try:
                process.stdin.write(json.dumps(payload).encode("utf-8") + b"\n")
                process.stdin.close()
            except BrokenPipeError:
                pass
        except OSError:
            raise ProbeError("sidecar could not be started") from None
        while process.poll() is None or not all(event.is_set() for event in completed):
            if overflow.is_set():
                raise ProbeError("stdout or stderr exceeds the output limit")
            if read_failed.is_set():
                raise ProbeError("sidecar output could not be read")
            remaining = work_deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeError("readiness deadline exceeded")
            time.sleep(min(0.01, remaining))
        if overflow.is_set():
            raise ProbeError("stdout or stderr exceeds the output limit")
        if read_failed.is_set():
            raise ProbeError("sidecar output could not be read")
        if process.returncode != 0:
            raise ProbeError("sidecar exited with a failure status")
        validate_stdout(bytes(output), stage)
    finally:
        failed_before_cleanup = sys.exc_info()[0] is not None
        stop_tree()
        if process is not None:
            try:
                process.wait(timeout=max(0, min(1, deadline - time.monotonic())))
            except (subprocess.TimeoutExpired, OSError):
                cleanup_failed = True
            for reader in readers:
                reader.join(timeout=max(0, min(0.5, deadline - time.monotonic())))
            if any(reader.is_alive() for reader in readers):
                cleanup_failed = True
            # Readers are bounded daemon threads; never wait indefinitely for
            # an inherited handle during cleanup.
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None and not any(reader.is_alive() for reader in readers):
                    try:
                        stream.close()
                    except (OSError, ValueError):
                        cleanup_failed = True
        if anchor is not None:
            try:
                anchor.kill()
                anchor.wait(timeout=max(0, min(1, deadline - time.monotonic())))
            except (OSError, subprocess.TimeoutExpired):
                cleanup_failed = True
        if cleanup_failed and not failed_before_cleanup:
            raise ProbeError("sidecar process cleanup failed")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=("bootstrap", "runtime", "all"))
    parser.add_argument("sidecar")
    args = parser.parse_args(argv)
    stage = args.stage
    try:
        deadline = time.monotonic() + PROBE_TIMEOUT_SECONDS
        for stage in ("bootstrap", "runtime") if args.stage == "all" else (args.stage,):
            run_probe([args.sidecar], stage, timeout=deadline - time.monotonic())
            print(f"Sidecar {stage} check passed.")
    except ProbeError as exc:
        print(
            f"ERROR: Sidecar {stage} verification failed: {exc}. Rebuild the sidecar before distribution.",
            file=sys.stderr,
        )
        return 1
    except Exception:
        print(
            f"ERROR: Sidecar {stage} verification failed: probe operation failed. Rebuild the sidecar before distribution.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
