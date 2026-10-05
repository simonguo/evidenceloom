# Desktop analysis journal and execution control

When a desktop run finishes, fails, or is cancelled, the next queued task waits
until its original output is durably projected and its owned process cleanup is
confirmed. Lost acknowledgements retain the original request for explicit query
and retry. A completed event alone cannot release the queue.

This implementation covers the desktop workflow within one frontend session.
The native journal also records output with no subscribed frontend. Refresh and
remount attachment, interrupted-result resolution, and packaged Tauri IPC/UI
acceptance remain separate work. Browser execution retains its existing behavior.

## Ownership and authority

| Boundary | Production owner | Responsibility |
| --- | --- | --- |
| Tauri commands | `src-tauri/src/main.rs` | Strict request parsing, blocking-executor dispatch, private credential preparation, supervised runner launch and wake notifications. |
| Native coordinator | `src-tauri/src/analysis_recovery/runtime.rs` | Exact reservation identity, cancellation, process supervision, coherent observations, and the cleanup/output gates. |
| Process registry | `src-tauri/src/analysis_execution.rs` | Atomic owned-run reservation, reader ownership, bounded cleanup and retained failed cleanup. |
| Wire/publication | `src-tauri/src/analysis_recovery/{wire,parser,publication}.rs` | Required fields, raw JSON limits, canonical request identity, safe publication and complete reply bounds. |
| Durable SQL | `src-tauri/src/storage/analysis_journal.rs` | Header, ordered events, immutable seals, request outcomes, page proofs, task CAS and applied cursor transactions. |
| Frontend consumer | `frontend/src/features/analysis-recovery/` | Original request capture, subscribe/read/project/start ordering, deterministic reduction and explicit pending/retry states. |
| Task provider/queue | `frontend/src/components/task-center/` | Canonical task publication, lifetime guards and scheduling only after native readiness. |

SQL task identity uses the [task mutation fence](validation/2026-10-04-desktop-task-mutation-fence.md):
collection ID/epoch, task generation and revision, including deletion tombstones.
Native `RunIdentity` adds the runtime epoch, task ID and server run ID;
`RunBinding` binds that run to the original collection and task generation.
These identities have distinct meanings from a report's fallback run ID or an
EvidenceBundle's run ID. A matching task ID alone grants no process authority.

Native initialization obtains 32 bytes of OS entropy for its runtime epoch.
Entropy or initialization failure leaves readiness unavailable. The supervised
blocking initializer consumes its join result, classifies prior epochs, and
loads SQL authority without holding the process/coordinator state mutex.

## Admission through completion

1. The Provider captures the canonical task/head, actual run form and original
   fallback RunContext before asynchronous admission. It freezes an immutable
   admission request ID and `requestJson`; transient execution input is separate.
2. Native admission reserves a Preparing owner before credential or SQL work.
   Its exact original-request witness can be queried and cancelled while header
   preparation is pending. Header publication requires successful safe inventory
   acquisition and matching current SQL collection/head/input provenance.
3. One SQL transaction commits the original safe header, admission receipt and
   `accepted` sequence 1. That sequence resets per-run state while retaining
   previous saved report versions. No independent V1 task save performs this reset.
4. The consumer acknowledges subscription, reads sequence 1 and commits its
   reset projection/cursor before issuing the exact start request. Native start
   checks the bound header and applied cursor; query/replay cannot spawn twice.
5. The worker attaches its owned process before writing input. Readers publish
   validated output to SQL before emitting metadata-only wake notifications.
   Wake delivery is advisory: the consumer reads the authoritative journal.
6. Each fixed-cut page is reduced from its captured canonical parent and committed
   with its server-issued range proof. The returned canonical task/head/cursor
   becomes the next parent. Unknown writes query their original immutable packet.
7. Worker/readers retire, final outcome is appended, and the writer seals a fixed
   `sealedThroughSeq`. Cleanup confirmation advances a separate control revision.
   The next run requires both confirmed cleanup and projection through the seal.

Subscription failure, cancellation or expiry before start can seal a finite
`not_started` outcome with no worker. Its truthful projection still has to commit.
A pending header remains unknown until the original admission query resolves it;
expiry never silently erases a committed accepted/reset event.

## Protocol and durable state

New recovery commands use `{ requestJson: string }`; `start_analysis` additionally
accepts `{ executionInputJson: string }`. Replies are typed objects. The existing
V1 task-mutation object API remains separate. Runtime/load requests carry
`recoveryProtocolVersion: 1`; missing run identity has no task-only fallback.

| Commands | Purpose |
| --- | --- |
| `query_analysis_runtime`, `load_analysis_recovery` | Native readiness/owner observation and a coherent SQL/runtime snapshot. |
| `reserve_analysis`, `query_analysis_reservation` | Exact original admission outcome and pending reservation witness. |
| `start_analysis`, `query_analysis_start` | Single launch acceptance and its durable historical outcome. |
| `read_analysis_journal` | Contiguous bounded page at a fixed sequence cut. |
| `commit_analysis_projection`, `query_analysis_projection` | Original page packet's task/cursor CAS outcome. |
| `stop_analysis`, `query_analysis_control` | Exact-owner cleanup and a known outcome or explicit uncertainty. |

Schema 12 adds four tables: `analysis_journals` stores the safe header and lifecycle
metadata; `analysis_events` stores ordered envelopes; `analysis_controls` stores
cleanup revisions; `analysis_requests` binds request IDs/digests to outcomes.
Request history retains safe receipt/rejection metadata, not original task packets,
credentials or report bodies. Known request-ID rebinding conflicts fail before
cancellation or other effects. Known outcomes survive a later current-read failure.

Each envelope binds origin, task generation, sequence, original safe payload,
observation timestamp, projection seeds and payload digest. Stable seeds supply
log IDs, updated times and completion version IDs/times. An explicit runner
timestamp, including an empty string, retains its literal value; only absence
uses committed fixed UTC time. Unsafe timestamps use a fixed unavailable marker.

A page's proof covers exactly `(afterSeq, lastSeq]`. The consumer commits or
queries that page before reading the next page of the same cut. It never combines
client-computed page digests. SQL checks original rows/proof, expected task head,
generation, applied cursor, run truth and immutable domain/history constraints,
then commits task/attachments, cursor and receipt together. A conflict requires a
new captured canonical parent/range; it cannot restamp the old reduced body.

`RecoveryCurrent` is either a coherent SQL/runtime cut or explicitly unavailable.
Observation revisions detect removal ABA and trigger bounded coherence retries.
Unavailable current data supplies no fabricated head, cursor or absence proof.
Complete serialized reply size is checked; oversized current data can become a
fixed unavailable current while preserving a known receipt/rejection.

## Research fidelity and privacy

The admitted context preserves the original seven-field task snapshot,
six actual run input fields, twenty allowlisted settings, and the original
fallback RunContext/manifest. It excludes whole forms/settings, endpoints, local
paths, environment maps and API credentials. A mandatory value that cannot be saved
exactly and safely rejects admission before spawn; its manifest/hash is not rebuilt.

Credential preparation checks selected stored credentials and recognized inherited
credential environment values before header publication. Values remain transient
and the same prepared snapshot is used at start. Acquisition failure is explicit.
Private execution input and raw stderr/exception text never become journal bodies.
Persisted diagnostics use fixed safe categories; arbitrary worker JSON is excluded.

Optional prepared domain publications retain safe original values and existing
hash semantics. Unsafe, malformed or over-limit channels receive explicit
unavailable markers, preserving safe siblings. They cannot become rewritten
hashes that appear to identify the original publication. Existing contracts remain:
[Evidence](EVIDENCE_BUNDLE.md), [Memory](MEMORY_BUNDLE.md),
[Readiness](RESEARCH_READINESS.md), [Numeric Review](NUMERIC_REVIEW.md), and
[Effective Request Identity](EFFECTIVE_REQUEST_IDENTITY.md).

Critical withheld research is sticky through the final projection. Earlier legal
versions/reviews remain; later safe original events can remain in the journal,
but cannot mask that failure or create another qualifying version. Ordinary
reader/worker failure remains visible in the final outcome. Hard framing/quota
failure can stop publication and initiate owned cleanup.

Report sections preserve full replacement semantics, string/null values, empty
strings and original whitespace/CRLF. A top-level null map is unavailable.
Safe completed output with no non-whitespace content in the chosen full snapshot
becomes desktop `analysis_empty_result`, with no new completed version. This uses
the ECMAScript `trim` predicate: FEFF is whitespace; NEL is not. Explicit `{}`
replaces earlier sections; omitted sections may use the previous safe snapshot.
That completed event still counts as a terminal observation. Success without any
safely observed completed/error terminal becomes `analysis_missing_terminal`.

The first winning completion keeps the existing `ReportVersion.task` semantics:
its captured canonical working task snapshot. Admitted requested input remains
separate provenance. This adds no V1 input-field freeze and changes no browser
builder or frozen domain hashes. Unsafe completion cannot fall back to an old
partial report and create a falsely successful version.

## Bounds, cleanup and removal

Control/context JSON is capped at 64 KiB; transient input at 512 KiB. Raw lines,
projection packets and complete replies are capped at 256 MiB; envelopes at
240 MiB. Optional domain publications have a 64 MiB bound. Pages contain 1–64 rows
with a 4 MiB soft bound; a single larger row is
allowed only when the complete reply fits. Research per journal is bounded to
1 GiB/100,000 rows with 8 terminal rows/256 KiB reserved. Only the first bounded
critical marker with no safe analysis body can use that reserve; repeated critical input cannot consume
all reader/worker outcome capacity. Values are rejected or marked unavailable,
never silently truncated or rehashed. Counters are checked decimal strings.

Cancellation marks the exact owner and performs bounded cleanup on the blocking
executor. Failed cleanup retains ownership and a known `cleanup_incomplete`
receipt; explicit retry has a new request ID and expected control revision.
Cleanup success alone cannot release pending output. The contract confirms
containment termination issued, known handles reaped and readers joined;
escaped descendants, shutdown and universal descendant exit are unverified.

Task deletion/collection clear serialize with reservation and SQL mutation.
Retained cleanup/output blockers reject removal. Eligible deletion/clear purges
journal headers/events atomically with the fenced task SQL transaction; safe
metadata history remains. SQL clear receipts never certify external settings or
Keychain completion. Pending/partial broad clear also blocks new admission.

Migration preserves schema 11 task authority and fails closed on missing/corrupt
schema 12 journal structures. Supported copies rotate collection identity, retain
original header hashes, and mark unresolved journals interrupted. Initialization
enumerates all unresolved journals physically in the database, including old
collection/runtime bindings. Historical data grants no process control or fresh
projection authority; unresolved output remains visible and blocking.

## Evidence and remaining scope

Local native engineering checks pass 239 Rust cases, with 3 explicit ignored
entries. A separate actual command-bridge run passes 13 frontend cases: six
two-run native modes, six parsed-boundary fixtures and one actual SQL corpus parser.
Its real Provider/consumer, compiled production helpers, owned fictional workers
and SQLite cover sequential success/failure gates and Float-to-JS roundtrips.
The JSONL fixture replaces Tauri transport; it does not establish packaged IPC/UI.
Original failed attempts, compiler warnings and controlled panic output are retained.

Actual three-platform native CI is required before Ready. Complete reload/remount
attachment and interrupted/copied-output resolution remain the next recovery
slice. Global IPC/credential deadlines and cross-store clear atomicity remain open.
No real provider, credential store, target analyst or external research was used
for these recovery checks. All twelve [professional acceptance areas](PROFESSIONAL_QUALITY.md)
remain open; recorded external participant completions and expert-approved claims are zero, and broader
availability/analyst/release acceptance remains UNKNOWN.
