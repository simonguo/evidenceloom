# Research evidence bundle validation

Candidate branch: `quality/research-evidence-bundles`, based on `quality/structured-output-observability` (`ff12d278`). This is the next implementation slice for professional analysts and independent researchers. The product-quality objective remains open.

## Implemented behavior

The Python ledger saves exact sanitized source input text, stable evidence IDs, actual provider attempts, observed date metadata, full-precision normalized data, frozen context hashes and citation-resolution audits. Captures are saved before returning to the model. A run has an explicit daily UTC cutoff; unknown source dates, adjustment rules and historical content revisions remain unknown.

Source fixtures cover Tencent-first A-share prices and Eastmoney fallback, Yahoo and Alpha news, direct Reddit/StockTwits/China sentiment sources, full-precision OHLCV and local calculations, configured-vs-effective news searches/topics, and statement frequency selection. Provider response bodies, credentials, headers, local paths and private endpoint details are excluded from evidence diagnostics. Explicitly withheld or future-dated source values do not reach the model as valid input.

Graph state, private analyst projections, desktop events, task storage and frozen report versions retain the evidence. A fresh-process checkpoint resume restores the same memory and identity context, then replays saved partial-node inputs without new source retrieval. Already checkpointed inputs are not reused for a genuinely new identical request. Two concurrent runs stay isolated. Four real subprocess writers retain every capture through the same run's process lock and strict durable union.

SQLite schema v6 stores bundles and artifacts by content hash, validates them on save/reload, retains frozen history and prunes superseded unreferenced content. Browser task persistence verifies evidence and reports save failures. HTML and Markdown include all artifacts and hashes in a self-contained appendix; Evidence JSON contains the complete bundle. Unknown legacy provenance, corrupted/contradictory state, missing IDs and malformed citations are explicit.

## Automated checks

- Python: 726 passed, 75 subtests passed, 1 external integration test deselected; eight expected unknown-model warnings. Ruff check and formatting passed for 150 files.
- Frontend: lint, typecheck and 64 tests passed. Production web and Tauri static builds passed.
- Rust: formatting, Clippy with warnings denied and 24 tests passed on macOS Intel.
- The independently generated [fictional bundle fixture](../../tests/fixtures/evidence_bundle_v1.json) verifies with Python SHA-256, browser WebCrypto and Rust `sha2`. The exact normalized JSON text retains `123.45678901234567`, `1.0` and `1e-07` across reload and export. Tests parse each self-contained export back to the identical bundle and resolve saved citation links.
- Atomic failure, malformed hashes/fields, unsafe keys/URLs, environment/configured credential redaction, source exceptions, stale process owners and corrupted durable files are covered by regression cases.
- Python lock, application/core version synchronization and deterministic third-party notices passed. `sha2` becomes a direct Rust dependency; its existing locked version and notice inventory do not change.
- Production npm dependency audit: zero reported vulnerabilities. Existing development-tool advisories remain a separate open work item.
- PyInstaller includes the application's own Python sources so packaged code/prompt hashes cannot silently become an empty-directory digest. Missing source files fail safely. The isolated macOS Intel build completed, and its basic ready smoke passed after approximately 47 seconds; the original 45-second diagnostic deadline was too short. Startup latency remains an operational work item.
- The final [packaged evidence inventory](2026-10-04-packaged-evidence.json) matched both code and prompt hashes against 80 development-source files, with no research/provider requests. That separate cold-start diagnostic took approximately 84 seconds. These are single local startup observations, not a latency benchmark or a release-performance claim.

No live provider request or paid API call was used for this slice. All new research fixtures are fictional or locally mocked. Model-format compatibility from the preceding slice does not establish research accuracy.

## Remaining acceptance

Browser automation twice failed with `Unable to load browser request-header policy`; the in-app browser was unavailable. Native Safari selection timed out. Native Chrome exposed the preceding validation page, but address-bar navigation did not update the document to this candidate. The local production server built and started successfully. These attempts do not constitute visual UI or exported-page validation. A screenshot and rendered export inspection remain pending; no old screenshot is presented as evidence for this implementation.

This candidate should remain a draft until visual acceptance is recorded. Windows process locking is implemented and reviewed, but this local run does not establish Windows installation, platform accessibility or clean-machine upgrade behavior. Market timezone/intraday boundaries, historical filing/adjustment/content vintage, claim-level factual and numerical support, immutable memory settlement, expert-labeled evaluation and competitive analyst assessment remain open. A resolved citation only confirms that its ID matches a saved source.
