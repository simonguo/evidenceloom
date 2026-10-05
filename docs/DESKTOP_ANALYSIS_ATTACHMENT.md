# Desktop analysis attachment

This candidate lets a new frontend lifetime watch an analysis that still belongs
to the same running native application. The task center first loads native
runtime and SQLite authority, then offers global controls for the observed
owner, including when the saved task is missing or its status was normalized on
reload. Watching an existing analysis does not reserve or start another worker.

This contract extends [desktop analysis recovery](DESKTOP_ANALYSIS_RECOVERY.md).
The new commands use the existing recovery protocol version `1`; existing strict
request and reply shapes remain separate.

## Attachment identity and authority

`attach_analysis_recovery` receives a new, immutable attachment intent containing
the observed runtime epoch, observation revision lower bound, run identity,
journal ID, collection/task-generation binding, original admission ID and
digest, and optional known header digest. Its acknowledgement grants
`same_runtime_watch_project_stop` and explicitly says `mayStart: false`.
`query_analysis_attachment` looks up that exact original intent. It cannot admit
an unknown intent.

An acknowledgement records a historical match. Each reply separately describes
the current attachment:

| Current attachment | Permitted behavior |
| --- | --- |
| Durable, live | Read original journal pages, project verified ranges against the current SQL head, and stop the exact native owner. |
| Volatile | Watch and stop the exact native owner. Missing storage, a pending header, an unavailable journal body, or a changed SQL binding grants no projection authority. |
| Durable, retired | Reconcile the acknowledged run with the canonical saved result. It grants no new projection or control effect. |
| No current match | Keep the queue blocked and request fresh observation. An old acknowledgement does not authorize a replacement owner. |

Native attachment and control outcomes retain bounded metadata, never saved task
bodies or private execution input. An attachment acknowledgement cache admits at
most 1,024 intents in one runtime. Exact known lookups remain available after
the cap; new intents fail before an effect. Controls retain at most 1,024
non-evicted user-attempt outcomes for one owner, plus one separate automatic
cleanup flight. Replies compose fresh current state.

## Reconstructing the saved projection boundary

SQLite schema `13` adds `projection_terminal_observed`. On upgrade, initialization
validates the available original journal from its header through `appliedSeq`
in bounded pages, including rows after an early completion event. A gap or
digest mismatch rolls back the migration. Events beyond `appliedSeq` do not
contribute to the derived flag. Existing schema-13 fields are validated without
silently repairing missing or invalid metadata.

An available, matching current SQL incarnation yields an `AppliedPrefixAnchor`
in the same SQL cut as its canonical task, collection, task head and journal.
The anchor carries the original header digest, applied cursor,
`safeTerminalThroughApplied`, applied critical failure, projection failure code,
and completion flag. The terminal flag is independent of publication-wide
terminal observation and of a successful result: an empty completed event has
observed a terminal event but has produced no report version.

The frontend reduces new verified rows from that canonical task and anchor.
It does not replay acknowledged rows, reconstruct old report-version identities,
or start from a locally normalized task. Projection updates the task, cursor,
prefix metadata and original-request receipt in one transaction. A lost
acknowledgement is queried with the original packet before another range is
constructed.

An unavailable body with a positive applied cursor has an unknown prefix rather
than a false terminal flag. A copied database has a new collection binding.
Neither state grants durable projection authority from an old header.

## Controls and queue admission

Frontend disposal unregisters listeners and revokes its own publication lifetime;
it does not cancel the native worker. Global controls capture the observed owner
before awaits. The native coordinator checks exact owner identity again before
control effects. SQL task status alone cannot prove that a worker has stopped.

Stop attempts for one owner share a cleanup flight. Automatic finalization can
contribute an actual cleanup result without waiting for its own worker thread.
A known failed cleanup remains a failed outcome. An explicit retry against the
known current control revision can reconcile that outcome. If the actual owned
handles have since joined, it records that confirmation without another physical
cleanup; otherwise it can start another cleanup attempt. A late failed SQL
receipt cannot revoke an observed owned-handle join. A pending or unknown control
cannot be replaced by treating a prior receipt as the new request's success.

The next queued task requires both gates: native owned-handle cleanup is
confirmed and the previous sealed journal is fully projected. Listener wakes
are hints; registration is followed by another authoritative read so completion
during registration is not lost.

## Validation boundary

The permanent integration cases use the actual compiled production native
modules through a test-only JSONL command bridge, real owned SQLite stores and
fictional child workers. They exercise same-module Provider remount, fresh-module
Provider remount, and real completion while listener acknowledgement is delayed.
The existing consecutive-run and Rust-produced SQL serialization cases remain
required. The native diagnostics workflow runs the attachment cases alongside
them on Apple Silicon, Intel macOS and Windows.

Passing these fixtures establishes the recorded engineering behavior at their
exact source and binary identities. It does not establish a real WebView reload,
Tauri IPC delivery, clean installation, signed release, participant task
completion or expert-approved research. Offline prior-runtime recovery,
settlement of copied or unsealed historical journals, pending discard, settings
and Keychain atomicity, browser CAS and broader analyst acceptance remain open.
