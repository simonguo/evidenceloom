# Immutable desktop application dependencies — local validation

The shipping desktop application chooses its platform database, legacy migration paths,
credential store and runner through several helpers. A runner override alone cannot
isolate a desktop acceptance test from an analyst's research data or credentials.
This source slice centralizes those dependencies before the Tauri Builder is constructed.

Implementation: `ba910a77592fca406695b125faf14ebb04f643ea`. Parent: `3a4a971ac1c436fb5883b479c86868c859fa06ed`. Six production paths and one test path.
The [machine record](2026-10-05-desktop-application-environment.json) binds the exact
source, original logs and independent review. Published-head three-platform CI is a
separate pending gate at this document's creation.

## Behavior

The shipping constructor selects System only. Its original path resolvers, credential
backend, environment reads, supported overrides and command behavior stay lazy and
retain their arguments. An immutable managed environment routes every storage open,
settings migration, credential metadata/read/write/delete, broad clear, analysis
preheader, auxiliary command, diagnostic and memory-inventory helper.

Only tests can construct the owned environment. It uses an owned SQLite path and an
in-memory credential backend, disables sibling legacy discovery and Python/external
runner fallbacks, pins its runner, clears inherited command environment and fixes
HOME, TMP, TEMP, TMPDIR and working directory. It refuses native dialogs before their
OS effects. The marker runner in the new routing tests is never executed.

IPC DTOs, protocols, database schema 13, CAS/journal semantics, domain hashes, frontend,
Python, dependency locks, capabilities and release/build scripts retain their bytes.
Settings, URLs, environment variables and RPC cannot activate owned mode in a normal
binary. This phase supplies dependency routing, not a packaged acceptance feature.

## Actual local checks

| Check | Result |
| --- | --- |
| Cargo format | Exit 0 |
| All-target locked offline test compilation | Exit 0; no compiler diagnostics |
| All-target strict Clippy (`-D warnings`) | Exit 0 |
| New application-environment routing tests | 12 passed, zero failures/ignores |
| Complete Rust suite | 272 passed, zero failures, 3 explicit ignores |

The x86_64-apple-darwin lane uses owned caches, home/temp and build output.
Each final check records 53 source/config entries before and after with identical
bytes. Those snapshots cover 13 of the 15 frozen boundaries; the two unchanged
sidecar build scripts were independently checked against the final freeze and parent
Git blobs, without claiming check-time snapshots for them. No unchanged frontend or
Python suite was repeated.

The new controls exercise real owned SQLite initialization, task CAS, settings
migration, missing-key retention, credential acquisition and broad-clear duplicate
effects. System controls inspect lazy callbacks and commands without calling the OS
credential backend or running commands. Unix declares 12 cases; Windows declares 11,
because the symlink-path control is Unix only. This is not a Windows execution result.

Seven retained panic prints come from fixed existing owned failure injections; their
corresponding cleanup/worker regression cases pass. The three ignored entries are the
stdin-controlled native bridge and two tests requiring an explicitly packaged sidecar.
Their local acceptance remains unexecuted. The compile-only exit-127 placeholder was
neither executed nor packaged.

## Retained failures and corrections

The first source audit found a missing owned TMPDIR override. The final production
source fixes it and pins the command environment. The first routing execution passed
11 cases and failed one test oracle: after `env_clear`, `env_remove` can omit a
credential entry instead of exposing a `None` deletion marker. Both forms transmit no
credential value. The correction changes only that observation assertion and still
forbids any credential value; the six production files are unchanged between these
two executions. The original failed log remains preserved.

An earlier static receipt counted 13 tests. An append-only correction and the final
freeze record the actual 12 Unix/11 Windows declarations. A proposed runtime-info
bypass was disproved by the frozen lazy project-root callback; no product change was
made for that hypothesis. Original evidence is retained rather than overwritten.

## Acceptance still open

No application Builder startup, window/WebView, real Tauri invoke/listen, user database,
System credential API, real provider/model, or packaged runner was used in this slice.
Existing full-suite fictional process controls remain distinct from the nonexecuted
marker in the new tests. No whole-OS sandbox, hostile filesystem race protection,
physical accessibility, clean install, signed release, analyst task completion or
research-accuracy claim follows from these results.

The next phases must build a separately gated fictional acceptance package and test
the actual renderer/native transport. All twelve professional quality areas remain
open or partial, completed external participants and expert-approved claims remain
zero, and participant availability remains unknown.
