# Desktop analysis journal validation

When a desktop analysis acknowledgement or frontend save is lost, a run can leave a report projection uncertain and allow the next task too early. This candidate persists admitted events before waking the frontend, commits report projections against native task authority, and admits the next run only after the original journal is fully projected and owned-process cleanup is confirmed.

The DCO-signed implementation is `81d367fe95527853cc1b3786799a3b6ba7d18a11`, stacked on [PR #101](https://github.com/simonguo/evidenceloom/pull/101) at `b0ba14b991072a7b49934d4f44554fe649ecb29c`. The [machine record](2026-10-05-desktop-analysis-recovery.json) binds all 47 changed source paths to exact committed bytes and records actual checks, retained failures and limits. Timestamps use UTC. This is local engineering acceptance; published-head CI is still pending at the time these documents are recorded.

## Resulting behavior

The [implementation contract](../DESKTOP_ANALYSIS_RECOVERY.md) explains the schema 12 journal, captured original requests, safe publication, page proofs and atomic projection. Admission writes the safe header, accepted event and receipt together. Listener registration and accepted-row projection precede one start. An unknown outcome queries the identical original request; it does not stamp the request with newer authority or start a second worker.

The frontend consumes contiguous durable pages and commits task content, immutable report versions, attachments, task authority and applied cursor in one SQL transaction. A stale parent/cursor/page proof conflicts. The next run requires both a sealed fully applied journal and confirmed cleanup; either missing condition leaves a visible recovery gate. Known cleanup failure needs a new explicit control request. Completed historical body removal joins the caller's task mutation transaction; active, incomplete and unprojected journals cannot be purged.

Full report replacements and JavaScript trim semantics determine empty completion. Empty output produces `analysis_empty_result` and no report version; it does not fabricate a missing terminal event. Critical publication invalidity remains sticky across later pages while retaining safe original publication facts. Existing qualified versions remain immutable. Optional invalid channels retain safe siblings and fixed visible warning markers.

Selected provider credentials and recognized inherited credential environment values are inventoried before header admission. Full execution input and captured private credentials remain in native memory. The durable header retains the limited original task/form/settings/run context; it omits endpoints and keys. Tests use injected inventory and owned fictional workers, with no provider/model call or supplied key use.

## Actual local checks

| Check | Observed result |
| --- | --- |
| Frozen frontend checks | Typecheck, lint, full suite, web build, static Tauri export, generated types and targeted suite all exit 0; 243 source rows remain stable |
| Full frontend suite | 792 passed across 59 files, zero failures/errors/skips; 41 existing React act warnings retained |
| Targeted frontend subset | 99 passed across 8 files; not additional independent cases |
| Full Rust suite | 239 passed, zero failed, 3 ignored; includes 29 journal and 27 native recovery cases |
| Actual native command integration | Six modes each execute two consecutive analyses through the actual frontend Provider/consumer, compiled production Registry/publisher/worker and SQLite; 12 owned fictional workers |
| Production TypeScript protocol cases | Six permanent parsed-object boundary fixtures plus one case reading eight actual Rust SQLite serialized replies |
| SQL corpus producer | One exact production SQL serialization test passed and produced the retained original publication/number-form corpus |
| Strict Rust lint | `cargo clippy --all-targets --locked --offline -- -D warnings` exits 0 with stable source; no rule suppression |
| Rust format | `cargo fmt --all --check` exits 0 with stable source |
| Workflow syntax | YAML and embedded Python parse successfully; this is syntax evidence, not remote execution |

The six actual integration modes are safe report, safe report with JavaScript/Rust floating number roundtrips, empty completion, critical invalidity followed by a safe original completion, missing terminal output and malformed publication. Every mode observes run A's winning applied cursor, seal and cleanup before run B. Once admission begins, the desktop path performs no legacy V1 reset/event/finally save. A queue-order bootstrap repair before reservation remains permitted.

This bridge uses explicit test JSONL commands and real compiled production modules. It does not exercise the packaged GUI or Tauri IPC transport. The ignored Rust tests are the two real packaged-sidecar bridges, whose compile-only local placeholder is never executed, and the stdin command entry explicitly invoked by frontend integration. CI must execute both packaged bridges with the real packaged runner.

The latest strict all-target lint and full Rust run have no compiler warnings. Five initial dead-code compile warnings and seven printed panic injections are retained as historical evidence. Each injected worker/reader/launcher/Tauri panic is paired with its passing supervision case. Build warnings and all raw failure attempts remain recorded. Passing tests do not mean warning-free output.

## Old-product comparison and retained failures

An owned TypeScript AST extractor executes the exact `b0ba14b` event transform with its original imported helpers; the candidate executes production `reduceJournalPage`. Both receive eight identical detached fictional task/event/context inputs. The baseline fails four desired empty-result assertions and passes four preservation controls; the candidate passes all eight. Explicit empty replacement, nullable/empty sections and ECMAScript whitespace must fail honestly, while nonblank text, U+0085/U+180E outside trim and absent sections using prior partial content remain valid controls. This instruments event reduction only; it is not a baseline Provider, queue, desktop IPC or GUI comparison.

The required strict Clippy gate initially reported 21 production-target and 14 test-target diagnostics with overlapping items. Unused legacy declarations were removed or scoped to genuine test instrumentation; production uses the existing shared whitespace and credential-inventory helpers. A serde-transparent box reduces the coherent enum variant size without changing its JSON fields. Test cleanup remains eager, and no lint rule is suppressed. A second attempt exposed a missing root import; the third attempt passes. The original signed `f6ec018` source and exact original native executable are preserved. After these fixes, Rust full tests and corpus production pass, and all 13 actual protocol/native bridge cases rerun on the newly compiled executable. The unchanged frontend full-suite record of 792 tests used the preserved native03 executable; this later integration check binds native04 separately.

Initial compilation had nine errors, and the first Rust full run recorded 226 passes, seven failures and three ignores. The fixes preserve strict production migration validation; legacy fixtures now construct actual older schemas, copy fixtures expect collection rotation, the future-schema fixture uses `SCHEMA_VERSION+1`, a test-only atomic counter prevents a demonstrated temporary-directory collision, and the consecutive-run fixture uses the complete accepted reset. Original logs are retained. A compiler PATH launch failure, a cleanup-control regression and a baseline-loader capture failure are also preserved. Draft18 ran only 24 consumer/Provider cases after naming a nonexistent service test; final targeted coverage names the actual mutation test file.

## Published-head and product limits

Before Ready, the final publication head must pass all required checks and complete raw-log review for four Python test jobs and three native platform jobs. Native gates include source diagnostics, packaging, nine Rust filters, actual SQL serialization and six consecutive-run bridge cases, both real packaged-sidecar bridges and owned fixture cleanup. Local success does not predeclare macOS Intel, Apple Silicon or Windows CI success.

The next slice covers full frontend remount/reload recovery and interrupted-run resolution. Browser CAS, settings/Keychain atomicity, general IPC deadlines, shutdown recovery, real desktop GUI/IPC, clean installs, upgrades and release signing remain open. Existing research artifact contracts and hashes are preserved; this change does not establish factual research quality or prediction accuracy.

All twelve [professional quality areas](../PROFESSIONAL_QUALITY.md) remain open or partial. Recorded external participant completions and expert-approved claims are zero. Participant availability remains unknown; an unanswered question is not evidence of unavailability. No merge was performed.
