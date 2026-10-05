# Cancellation before analysis start

Validated on 2026-10-04 UTC against base `d6a357ef13659086a02c8aa3b2f51e252fbae0de`; implementation commit `bd4f56f5fce757aaddcb8a1fc13e0569559ad54a`. The adjacent JSON binds both changed source files and 44 retained evidence artifacts.

## Observed problem and change

The desktop adapter installs an abort handler, then awaits event-listener registration. When cancellation occurs during that wait, the original adapter dispatches stop but still invokes start after registration resolves. Its eventual AbortError does not prevent that start request.

A permanent test calls the actual adapter with deferred, mocked Tauri APIs. On the exact original runtime it records stop followed by start and fails the no-start assertion: six controls pass and one case fails. The candidate adds one cancellation check immediately after listener registration and before start. The same seven test bytes then pass. Existing finally cleanup removes the abort handler and registered listener.

The cases cover ordinary completion, pre-aborted input, cancellation while registration is pending, existing in-flight cancellation, registration errors, cancellation followed by registration rejection, and start errors. They inspect the actual adapter's calls and cleanup, rather than testing a copy of the changed expression.

## Actual validation

| Check | Actual result |
| --- | --- |
| New tests on original runtime | 6 passed, 1 failed; exit 1 |
| Same tests on candidate runtime | 7 passed; exit 0 |
| Complete frontend suite | 625 passed across 44 files; no JUnit failures/errors |
| Full lint and initial typecheck | Exit 0 each |
| Ordinary production build | Exit 0, 19.03 seconds |
| Desktop static build | Exit 0, 11.80 seconds |
| Generated-type typecheck after builds | Exit 0, 2.64 seconds |
| Frozen frontend lock audit | Exit 1 with seven high-severity package entries for the existing braces chain |

The build/audit/generated-type checks measured all 215 previously tracked frontend files before and after: the runtime is the sole existing-file change, and all 214 others match the base. The new test has its separately bound SHA. Earlier target/full-suite/lint/initial-typecheck records capture runtime, test and lock identities; they do not include historical full-file snapshots. At the implementation commit, verification finds 605 other repository files identical to base; these validation documents are added separately. No dependency or Rust implementation bytes change.

The complete suite retains 39 React act warnings in 10 test contexts across five existing test files. Both builds retain the Next ESLint-plugin warning. The audit finding is retained under the existing [dependency security scope](../DEPENDENCY_SECURITY.md), including unresolved bundled-code coverage; this is not warning-free or complete security acceptance. The first owned npm setup failed because user/global configuration referenced one identical empty file. Only the harness paths were corrected, and the original error is retained.

## Scope and remaining work

The seven new cases use mocked IPC and no real Tauri process, model or provider. The full suite includes inherited owned real Node-reader process tests; it is not a no-process run. Local npm tooling, installation, configuration and cache are independently owned. Existing shared environments and the user's workspace remain separate.

This fix does not bound a listen promise that never settles, make in-flight cancellation finish immediately, observe stop acknowledgement, or prove a process tree was terminated. Backend preparation/registration, same-task run ownership, cleanup failure, and delayed event isolation remain separate coordinated work. It does not establish rendered UI, screen-reader, clean-install, signed release, external analyst or expert acceptance. Exact published-head Python and all three complete native CI gates remain required. The broader professional product objective remains open.
