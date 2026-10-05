# Fresh diagnostic key classification

Reviewed on 2026-10-04. The candidate is stacked on SDK security head `f629728f377487df04654d5373d56a2a59df869e`; source commits are `f449cc7` and `c2b486d4ea85d2ba4fc7cc46a791ef71c87bc5b8`. The adjacent JSON binds actual sources, timings and root checks. Earlier measurements at base `67afab6` remain separate.

The original collector may lowercase an environment key up to four times through a generator. Exact built-in strings now use one lowercase operation with the same ordered substring tests and the original uppercase token-suffix fallback. Custom objects and string subclasses retain the original expression and its observable method order. Explicit secrets are still consumed before a fresh environment scan on every call; values, duplicates and order are preserved. No secret, environment, context or evaluation-result cache is added. Credential changes and deletion remain visible immediately.

## Actual verification

The original local author run passed 42 new compatibility witnesses plus two existing credential regressions (44 tests). Root then compared the candidate against a collector extracted from the immutable old Git blob: 50,000 seeded Unicode keys, four invalid mapping-key cases, 60 stateful/custom exception traces, environment rotation/deletion and generator side effects all agreed. This is value and exception-behavior evidence, not debugger/allocation-event equivalence.

After stacking onto SDK 0.4.4, root's actual targeted run passed 60 tests with no failures, errors or skips: the 42 new tests, 15 SDK registration tests and three existing credential regressions. One existing test runs the offline ScriptedModel graph through fresh and resumed execution. The new native invocation also includes the compatibility file. Real external model/provider APIs and user profiles were not used. The SDK-only overlay is not a complete fresh release installation.

Two physically distinct original/candidate source trees evaluated the unchanged 11-case/16-claim pack and a three-report history pack. Input identities, all non-implementation fields and eight rejection boundaries agreed; only the actual ledger source row, its aggregate implementation digests and derived result digest differed. They were not rewritten to appear equal. After the SDK stack, root separately completed all six public validate/evaluate/replay operations and eight rejection boundaries on those two packs. Relative to the pre-stack candidate, only the actual `uv.lock` dependency-file hash and derived result hash changed; all other fields and rejection outcomes agreed. The first root harness incorrectly required entire result equality across a changed dependency identity and failed. Its original source and captured failure remain retained; the corrected harness permits only those two exact differences.

## Bounded local timing

At base `67afab6`, on local macOS/CPython 3.12.10 (interpreter-visible `x86_64`), the harness alternated original and candidate collectors inside the same frozen source. Each sample performed all six public operations on the two complete packs, including input immutability checks and source hashing. Each cohort discarded one warmup per variant and used six AB/BA pairs; all 24 timed samples preserved complete results and hashes. This controlled instrumentation does not represent two distinct installed implementation identities.

| Owned environment size | Original median seconds | Candidate median seconds | Median paired candidate/original ratio | Faster pairs |
| --- | ---: | ---: | ---: | ---: |
| 5 keys | 2.965149 | 2.529683 | 0.851536 | 6/6 |
| 41 keys | 12.516872 | 9.029274 | 0.720989 | 6/6 |

These local observations support less work for these two workloads. They do not establish statistical significance, a full-suite speedup, physical-host architecture attestation or the cause of Intel CI timeouts. The benchmark was not rerun after the SDK stack; the collector/test bytes are unchanged, but dependency identity differs. CPU load, scheduling and thermal state were uncontrolled. Concurrent environment mutation retains the inherited scheduling behavior and receives no stronger guarantee. Temporary allocations and trace frames differ.

Raw scripts, logs, complete source/result comparisons and original failures are retained in `evidenceloom-validation/claims-performance/uncached-key-predicate-67afab6/`; the adjacent record hashes the relevant artifacts. Exact-head Python/native CI and complete packaged bridge results remain required before Ready. External analyst acceptance, expert adjudication, clean-machine install/upgrade, signing and broad performance requirements remain open.
