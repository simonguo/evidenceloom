# Desktop JSON command reliability — local validation

Instrument lookup, model connection checks and Python OHLCV retrieval now share a retained-owner supervisor. Serialization, stdin, both output drains and actual original-child cleanup are bounded together. An unfinished cleanup owner stays registered for exact retry; a zero child exit cannot convert pending input or I/O failure into success.

## Source and execution identity

The local candidate combines merged PR #106 (`790386310f77efd67795d0797b5048de53a2d926`, tree `fec02ace78dabceaf0b0319c802acd9e06070631`) with four JSON-command source paths. Local validation uses a source-only owned copy of 94 actual inputs, the real build script, locked dependencies and two inert compilation markers. The original runner, repository inputs and generated SDK files remain preservation guards. Markers are never executed or treated as packaged applications.

The final main, supervisor, regression and fictional-child source hashes are recorded in the [companion JSON](2026-10-05-desktop-json-command-reliability.json). The actual Git integration at `aed3aab8670f4f015be86ac7828d4731bcbbc9a2` matches all 94 tested input bytes. These are byte-equivalence bindings for the owned validation candidate; earlier negative and failed executions keep their own identities.

## Behavior and limits

The production policy allows eight active or pending owners. A ninth request is rejected without cancelling the eight; independent healthy chart requests overlap. The original 120-second deadline includes input serialization and cleanup. Serialized input and stdout are capped at 1 MiB each, and stderr at 256 KiB. Drain workers and the original process owner remain available when cleanup is incomplete. The supervisor preserves the original executable, arguments, working directory and explicitly selected public environment.

Redaction also runs after JSON decoding. Nested string values are redacted without changing ordinary structure; a decoded object key still containing a configured secret after raw redaction rejects the response rather than renaming or collapsing fields. Literal keys already changed by the original raw redaction retain that behavior. Selected decoded error messages and final typed OHLCV parse errors are redacted. OHLCV timestamps are redacted while numeric fields, ordering and ordinary timestamps retain their typed behavior. JSON and typed OHLCV parse-error Output excerpts retain their original 500-character limit; other raw-error fallbacks retain the bounded stream output. These checks concern the configured child secrets; they are not a general information-flow or research-quality certificate.

## Actual checks

| Check | Observed result |
| --- | --- |
| Format; locked/offline default and acceptance checks | All exited 0; compiler diagnostics empty |
| Strict all-target Clippy, both configurations | Both exited 0; no suppressed rules |
| JSON-command focused suite | 30 passed, 0 failed; 17.37 seconds |
| Full default suite | 303 passed, 0 failed, 3 explicitly ignored; 114.08 seconds |
| Full acceptance configuration | 313 application tests passed, 0 failed, 3 explicitly ignored; 114.01 seconds. Separate fixture unit target: 5 passed |

The full suites preserve three local ignores: the stdin-controlled frontend/native command bridge, saved-memory packaged artifact and actual-runtime packaged artifact. Their required packaged prerequisites were not run in this local matrix. Injected caller/worker panic prints are intentional caught failure-path observations, and remain in the original raw stderr.

The final concurrent-capacity case observed input and ready files for eight actual fictional Rust children, their original successful results and actual caller joins. Its original ninth-request and retained-owner assertions passed. A separate missing-executable regression observed the original `Start` error through the readiness observer, cached result and actual join, with no retained owner. These files do not certify native App or complete process-group cleanup.

## Contrary evidence retained

Four generic decoded-JSON regressions failed against the original merged parser, and two OHLCV regressions failed against an extraction of the original inline typed parser. Both comparisons compiled and reached the intended assertions; Cargo exited 101, while their verification harnesses exited 0 after recognizing the expected failures. Their sources are distinct from the final diagnostic test-only additions.

An intermediate 29-case positive run passed 28 cases and failed the original full-pool readiness wait. The failed run did not preserve the original worker result, so its root cause remains unknown. The final test-only diagnostic additions retain that result and actual join information without changing the eight-child concurrency, five-second acknowledgement bound or ten-second fictional-child policy. All old case names remain; the capacity observer/helpers change, the other 28 bodies are unchanged, and one missing-executable case is added. The historical failure is not relabeled as a pass by the final 30-case result.

## Remaining acceptance

No real acceptance App, WebView, Tauri IPC, Python interpreter, provider/model, System credential service, user database, signing, installer or release was executed by this matrix. Fictional Rust child and library-test execution does not complete those integration checks. Exact published-head CI/native packaging is a separate gate.

All twelve [professional quality areas](../PROFESSIONAL_QUALITY.md) remain open or partial. External participant completions and expert-approved claims remain zero, with participant availability unknown. Actual application shutdown use of this supervisor is part of the separately reviewed desktop acceptance work and is not claimed by these JSON-command checks.
