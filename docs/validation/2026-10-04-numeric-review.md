# Saved numeric field review validation — 2026-10-04

This candidate is based on `b1c8cb1670b8ae328ffa281932c977ae08bb10b3` and targets professional analysts and independent researchers. It adds immutable completed-report text, explicit selection of one saved numeric field, optional literal context bindings, and append-only review receipts. See the [v1 contract](../NUMERIC_REVIEW.md) and [machine record](2026-10-04-numeric-review.json). No model or market-provider request was made for this validation.

| Check | Observed result |
| --- | --- |
| Independent frozen Python 3.10 installation | Passed; fresh environment and existing locked dependencies |
| Complete offline Python suite | 1,201 passed, one integration case deselected, eight existing model-name warnings; 131.49 seconds |
| Python lint and formatting | Passed; 182 files checked for formatting |
| Independent npm install and frontend checks | 385 tests across 30 files, TypeScript and full ESLint passed |
| Frontend output | Both Tauri static and production standalone builds passed |
| Rust source checks | 83 passed, two existing packaged tests ignored in the ordinary suite; formatting and Clippy across all targets passed |
| Windows validator cross-check | Pinned temporary validator crate's tests passed; this does not attest Windows SQLite execution |
| Native storage | Actual SQLite v8→v9 migration, reload, immutable run/version ownership, append-prefix authority, stale save rejection, coherent false matches and corrupt attachment references covered by source tests |
| Isolated actual packaged sidecar | Architecture, bootstrap and research-runtime checks passed with the existing 90-second limit |
| Actual Rust packaged bridges | Runtime: one passed in 72.99 seconds; saved Memory inventory: one passed in 15.12 seconds |
| Actual browser workflow | Original-text selection, append/save/reload, selected-version isolation and all four result classes observed |
| Actual JSON, HTML and Markdown downloads | Independently parsed; unchanged UTF-8/CRLF/emoji sections, complete Evidence and opaque artifact strings, identical snapshot and all four chained receipts verified with Python |
| Actual corruption rejection | A fabricated match with a recalculated receipt hash produced `reference_mismatch`; exporting failed visibly |
| Legacy compatibility | A version without frozen text cannot create numeric reviews, retains unknown provenance, and can still export its ordinary report |

The shared fixture independently specifies exact decimal ties, negative ties, carries, scientific notation, signed zero and expansion beyond the input coefficient limit. Its 28 span vectors guard explicit localized signs, separators and scale suffixes. Python, TypeScript and Rust rederive receipt values rather than treating a self-hash as business validation. Whole-token guards are bounded syntax checks, not universal locale recognition or automatic claim interpretation.

Completion captures all seven exact report sections after final Evidence/citation processing, successful Memory completion and owner chronology checks. Configured-secret redaction precedes capture and hashing. Actual stream tests cover all published event types; CLI tests compare written bytes with mixed CRLF/LF text. Repeated completion cannot replace its first run snapshot. Tests reject altered sections, cross-source artifacts, forged results, rebinding IDs and stale writes. Browser saving publishes receipts only after durable storage succeeds; quota failure leaves the prior persisted and displayed history intact. Native loading rejects a missing linked receipt rather than silently dropping it.

The actual browser used a copied final standalone artifact on its own IPv4-loopback port and fictional FICT data. The original text contains CRLF and an emoji; display selection indices 27–33 bind to original UTF-8 bytes 34–40. Receipts record `match/value_match`, `mismatch/value_mismatch`, `missing/field_missing`, and `manual_inference/selection_unsupported`. A real version-switch check exposed duplicate React sibling keys; distinct numeric and preview keys plus a combined component regression fixed it. The final browser displayed one numeric panel, hid v2 receipts in legacy v1, and restored them in v2. Its synthetic local task state was removed after verification. User downloads and existing workspace services were left intact.

The [actual browser screenshot](../screenshots/saved-numeric-field-review.jpg) shows fictional saved match and mismatch receipts, exact source-field references, and their unreviewed dimensions. The three downloaded file hashes and independently rederived receipt hashes are recorded in the machine record; no private research or credentials are included.

The final isolated x86_64 artifact is 53,976,912 bytes with SHA-256 `604455e66359092e81508d3e7669100e1a04c6fbabec5e36f1ae5221e94b4966`. Its 92 readable own sources and 102 compiled own modules match the final candidate, excluding six namespace entries without code. All four numeric modules are present. Compiled comparison checks code objects recursively except filenames; it does not claim marshal serialization bytes are canonical. The existing real workspace sidecar remains unchanged with SHA-256 `c4688a5d98c7480e828c221f5caf02a22c03c6a7aa7db1b08b549883854a4e39`.

An earlier combined packaged probe exceeded its unchanged 90-second budget while other local builds/tests were running. The same-budget retry passed, and the final rebuilt artifact's combined probes and both actual native bridges passed. Concurrent workload was observed; it is not a proven sole cause of the earlier failure. The final runtime bridge still took 72.99 seconds, so startup performance remains open. This does not establish clean-install, signing or production latency acceptance.

The first PR head `33cfcfb01591f9cfee1cbd5efd68945ffb4138f0` passed the Linux Python 3.10–3.13, frontend and Rust checks. Windows source diagnostics exposed two new tests that read UTF-8 files using the system default encoding: the shared Unicode fixture and the persisted snapshot comparison. These reads now explicitly use UTF-8, as the runtime byte-writing and binary snapshot-reading paths already did. This fixes the test portability defect without changing the frozen policy, application sources or packaged artifact. All required checks must pass again on the updated final head.

The requested-instrument binding compares only an explicitly selected literal with the frozen requested run identity. An independently reproduced fictional FICT record with contrary `parameters.symbol: OTHER` can still yield a selected-field match and a requested-run literal match after consistent hashes. Effective tool-request and resolved-provider entity verification remains an open source-identity requirement. The interface and exports state that limitation; inspect full Evidence parameters separately.

This slice does not identify claims automatically, evaluate arithmetic formulas, certify surrounding prose, establish factual support, resolve provider identity, prove historical price vintage or evaluate predictive value. Expert-labeled research evaluation, independent calendar coverage, analyst/accessibility acceptance, competitive comparison and clean signed installations remain required for the broader product objective. macOS ARM, Intel and Windows native acceptance is tracked on the final pull-request head; those checks were pending when this local record was written.
