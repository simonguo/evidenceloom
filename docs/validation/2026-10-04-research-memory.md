# Immutable research memory validation

This record covers the candidate implementation of [MemoryBundle v1](../MEMORY_BUNDLE.md). The [machine-readable record](2026-10-04-research-memory.json) contains final research-source and fictional fixture hashes, completed checks, packaged observations and actual browser/export evidence. Implementation source is frozen at commit `9502aa4`, based on `1220036aae02fc9dc52e19e6edcf114a482ed65c`; these validation documents follow in a separate commit. The JSON records the full source revision. The packaged research manifest matches the frozen source: 85 readable Python files, code SHA `ebad8790de86569f2a7c26b32a308677bae8fdcdb15aac7c7e52fbbce1c0b62c`, and prompt SHA `34a914c246430d0532bb0af699fbe765e8cd0bc8944bc7ab3177679e0cad7226`. These manifests cover `tradingagents/**/*.py` and `tradingagents/agents/**/*.py`; CLI, frontend and Rust files have separately recorded component hashes.

Local packaged, browser and static-build acceptance passed for this fictional implementation slice. Final native memory CI has not started. The [professional research quality objective](../PROFESSIONAL_QUALITY.md) remains open.

## Implemented source mechanisms

Research start freezes the evaluation plan and the exact selected historical memory input in graph state and checkpoints. The plan retains the resolved benchmark, holding period, evaluator version and exact evaluator-file SHA, policies, explicit history parameters, and host-local research calendar/UTC offset. Successful research completion binds the exact sanitized decision-text artifact and records actual UTC completion time. Resume preserves the original plan and context. The host calendar is not a market timezone.

Prospective reference evaluation applies only when the requested analysis date equals the frozen host-local start date. Older date-only research is explicitly `not_evaluable` with `historical_decision_availability_unknown`, without requesting prices. Entry uses the first common complete daily date strictly after decision recording in both original source timezones and UTC. Exit follows the frozen number of common-row transitions. Both endpoints use the same instrument/benchmark dates and require adjusted close; no same-day execution assumption, stale-price fill, timezone stripping, raw-close fallback, or duplicate-last selection is permitted. A row is complete only after its original-local day and conservative UTC day have elapsed. Insufficient common rows remain pending, without freezing a terminal outcome.

Price facts retain original timestamps, timezones/offsets, requested and resolved symbols, exact request parameters, raw close, adjusted close, dividends, splits, unsupported/non-finite cell descriptions, and actual observation times. Numeric facts remain inside exact canonical JSON payload strings. Calculations record selected endpoints and the explicit difference of simple native-currency reference returns. They do not establish executable fills, realized profit, FX-converted performance, risk-adjusted alpha, causal thesis support, or predictive accuracy. Publication dates, price vintage, revision history, and complete exchange-calendar coverage remain unknown where unobserved.

Available facts and calculation artifacts are persisted before reflection. A failed or empty reflection leaves the verified outcome durable; a restarted process replays saved facts without retrieving revised provider prices. Replay checks the frozen evaluator identity, source binding, endpoints and formula. Unsupported evaluator versions or source hashes are explicit and never silently recomputed with current code or settings.

Per-decision JSON is settlement authority. Atomic images, stable writer locks, fsync/replace, strict monotonic unions, and fixed safe errors preserve immutable non-null outcomes/reflections. The as-generated completion bundle freezes once per run ID; later review attachments append separately and cannot rewrite its historical input. Legacy Markdown remains read-only and cannot establish authoritative decisions or lesson availability. Context selection requires decision recording, outcome observation, and reflection completion to be available by the frozen cutoff.

Python, TypeScript/WebCrypto and Rust validate exact fields, hashes, references, UTC times, host offsets, private-content exclusions and binding to the selected report's instrument, decision text and rating. SQLite schema v7 and browser storage are validated mirrors. Report JSON, HTML and Markdown preserve full memory/review artifacts, including exact numeric payload strings; invalid attachments block export. UI payloads render lazily, with an explicit 100,000-character preview limit while exports retain full content.

The read-only inventory uses the known `smoke_test` command with `memoryInventory:true`, requires 1–20 unique canonical UUIDs, and returns one strictly validated JSONL partition of reviews and missing IDs. It initializes no graph, model, provider, or dotenv configuration. Web/native bridges enforce a 90-second total deadline, 64 MiB output bound and fixed diagnostics. The web route accepts no client interpreter, project path, provider configuration, or API key. The native CI workflow includes source diagnostics, native sidecar builds, Rust memory tests and explicit packaged probes on macOS arm64, macOS Intel and Windows x86_64; configured jobs are not evidence of completed execution.

## Completed checks

| Check | Current result | Evidence scope |
| --- | --- | --- |
| Full Python suite | 933 passed; 75 subtests passed; 1 external integration case deselected; 8 known model warnings | Root-reported offline suite before the final narrow numeric guard |
| Final Python memory core | 49 passed | After the final huge-integer finite-number parity guard |
| Full frontend suite | 192 tests in 19 files passed | Frontend owner results relayed by root |
| Frontend typecheck, ESLint, production and Tauri static builds | Passed | Source/build checks |
| Final Rust host suite | 45 passed in 5.29 seconds; 2 deliberately ignored packaged tests | Includes final optional `asset_type` correction |
| Rust format and full Clippy | Passed | Warnings denied |
| Windows exact-module compilation and Clippy | Passed | Compilation/lint only; does not execute Windows |
| Independent Python memory review | 108 passed | Evaluator, contract, inventory and failed-reflection pipeline cases |
| Independent TypeScript memory review | 42 passed in 3 files | Validation, persistence and export cases |
| Independent diff check | Passed | Earlier read-only review check |
| Final Ruff check and format check | Passed for 169 files | Root-reported final source checks |
| Final diff check | Passed | Root-reported final working-tree check |

The full Python run took 110.64 seconds and preceded the final narrow guard that rejects integer facts outside finite double representability while retaining original numeric payload strings. The final 49-case core suite passed after that correction; a complete final-head native CI run is still required. The portable full-suite command is `PYTHONPATH=. python -m pytest -q` in the repository's frozen Python environment. Root confirmed the complete console output; no full-suite log file was retained. Frontend commands were `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run build:tauri` from `frontend`.

The fictional [memory fixture](../../tests/fixtures/memory_bundle_v1.json) and [paired evidence fixture](../../tests/fixtures/memory_evidence_bundle_v1.json) retain a pending as-generated decision and a prior available/reflected decision with actual offline evaluator facts and calculations. They were generated from injected fictional timezone-aware daily DataFrames and local mock reflection. The prior outcome replays offline using its saved full-precision endpoints. No live market-provider request or paid model call was used for this slice; test counts do not measure factual research quality.

Meaningful cases cover frozen five-row/benchmark-A settings versus later twenty-row/benchmark-B settings, alias drift, crypto/equity weekend alignment, completion-day UTC boundaries and DST, absent timezones/adjusted prices, duplicate/ambiguous labels, splits/dividends, unknown evaluator identity, provider revisions, reflection failure and restart, atomic persistence faults and competing subprocess writers. Cross-language cases cover hash/privacy/temporal parity, append-only reviews, immutable completions, selected-version binding, malformed/legacy/error/timeout/oversized inventory responses and self-contained export roundtrips. These are fictional and offline fixtures.

## Local packaged observations

The isolated x86_64 macOS PyInstaller artifact ran through Rosetta on an arm64 Apple Silicon host. Its SHA is `4f8ef6663d2db1bf47c19369320d87b13d4e81f726ca9cff9e5ee1672c0ac0a6`, and its size is 53,827,456 bytes. It did not replace the root worktree's real sidecar. The observed source and packaged manifests matched the final research source hashes.

| Probe | Elapsed seconds | Result |
| --- | ---: | --- |
| Source manifest | 0.0716 | `evidence_ready`, 276 stdout bytes |
| Packaged manifest | 22.0360 | Matching `evidence_ready`, 276 stdout bytes |
| Source memory inventory | 0.3610 | `memory_inventory`, 14,225 stdout bytes |
| Packaged memory inventory | 13.5811 | Exact full snapshots and precision, 14,225 stdout bytes |

The inventory retained both requested saved snapshots and exact numeric payload strings. Reads changed neither authoritative storage nor frozen completion; the configured legacy Markdown file remained absent. The Rust application's explicit ignored packaged-memory test passed in a reported 13.97 seconds, and its separate full research-import test returned `runtime_ready` and passed in 58.48 seconds. Both normally ignored cases were deliberately executed against this actual artifact. These are single local process observations on one Rosetta host, with no controlled cache reset; they do not establish native platform latency, provider readiness or clean-install behavior.

## Actual browser and downloaded exports

The browser exercised an isolated task-owned localhost origin with fictional reports. The [original input and later review screenshot](../screenshots/memory-original-and-review.jpg) shows the as-generated pending decision beside a later available review. The original bundle/input hashes remained unchanged, and the later evaluation was retained as a separate append-only attachment. Reload preserved the full saved tasks; selecting v1 restored its exact saved review. The [legacy-version screenshot](../screenshots/memory-legacy-version.jpg) shows v2's unknown memory and disabled review action without borrowing v1's attachments.

A mismatched decision attachment produced `reference_mismatch` and blocked export; see [binding rejection](../screenshots/memory-corruption-rejected.jpg). An artifact/hash alteration produced `hash_mismatch` and blocked export; see [hash rejection](../screenshots/memory-hash-rejected.jpg). Original task storage was restored after these deliberate corruption cases, and the browser page and temporary server were closed.

Downloaded Report JSON, Markdown and HTML were independently parsed and compared to the same complete original memory bundle, all later review payloads and the paired evidence. Full-precision artifact strings were retained. The [downloaded HTML appendix](../screenshots/memory-export-appendix.jpg) was rendered and its captured attachments compared structurally in Python to the saved version; all original, review and evidence comparisons passed. An initial JavaScript string comparison differed only in object key order; structural comparison passed, and original artifact payload strings compared exactly.

| Download | Bytes | SHA-256 |
| --- | ---: | --- |
| Report JSON | 42,299 | `141d7ff6ee48a4247715176881d676c52b502b7057733e54d2c19e6d8639657c` |
| Markdown | 44,618 | `429d07db962f89925c60e489dab3cef219a8c1243706f57c0b38176c52d26421` |
| HTML | 73,174 | `01241a230d249ec64ff3ffef6c40f489822dc4bfff7b14cc34c2bf6f5cddb7f3` |

These observations validate this fictional memory UI/export slice. They do not constitute an accessibility audit or independent analyst assessment.

## Remaining acceptance and professional-quality limits

The native CI matrix for this final candidate has not started; no actual macOS arm64, native Intel or Windows memory execution result is claimed here. Cross-compilation and a local Rosetta packaged probe do not substitute for that execution matrix. Static build success does not validate a signed Tauri installer.

Broader work remains: independently verified provider compatibility and price metadata; market-specific intraday boundaries, filing availability and revision vintages; claim-level factual/numerical support; expert-labeled and out-of-sample research evaluation; cost/FX-aware performance assessment; target-analyst task completion and competitive comparison; accessibility; and clean-install, upgrade, migration, backup/restore and signing acceptance. Immutable records and valid calculations improve auditability but do not establish an industry-leading product or financial confidence.
