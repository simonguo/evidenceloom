# Research input checks: local validation record

This record covers ResearchReadiness v1 and its saved-row proof with entirely fictional, offline inputs. It records engineering behavior for professional analysts and independent researchers. It does not establish factual claim support, numerical accuracy of model prose, predictive value, or completion of the product-quality objective.

The corresponding [machine-readable record](2026-10-04-research-readiness.json) contains source, component, fixture, screenshot and downloaded-file hashes. The [contract](../RESEARCH_READINESS.md) defines the exact policy and derivation rules.

## Frozen implementation

The implementation source revision is `29ac52f95e19d212193928bf0f401b5c844128c9`, based on `d81572617bf3c70e897e8f4504e508fa5395d1b2`. Research core SHA is `17593da79aaab79085d6a1c5fd28991a04e8ed9fa243d53ddfa53c7ce0811601`; prompt SHA is `361c2952214420de79ace08dcff8c7f5723f7c9a3bb77af25b48ed7ace8ffed0`, covering 88 readable Python source files. Frontend and Rust component hashes are recorded separately.

The policy freezes selected domains, actual research start, host calendar/offset, cutoff, tool limits and indicator minima before research. The pre-manager gate derives checks from saved Evidence artifacts. Unmet required checks produce a fixed `Rating: REVIEW` and skip the Portfolio Manager model call. The existing balanced `Hold` remains available when required inputs pass. No extra model call, provider fetch, repair request or tool round is added by the gate.

The saved-row proof independently checks full-precision OHLCV, original clocks, daily-label completion, duplicates, date windows, counts and optional adjustment/request metadata. It admits the explicit v1 observed timezone registry; unfamiliar zones require review. Publication vintage and independent exchange-calendar coverage remain unknown. Historical date-only research cannot establish historical availability.

## Automated local checks

| Check | Recorded result |
| --- | --- |
| Full Python suite | 1,042 passed, 75 subtests passed, 1 deselected; 8 known model-name warnings; 112.90 seconds |
| Focused source/data proof suites | 224 passed; includes 51 raw-observation proof cases |
| Independent graph, checkpoint, CLI and desktop review | 38 passed; 10 saved final JSON receipts revalidated; altered ratings/text, missing receipts and changed frozen calendars rejected before Memory writes |
| Frontend implementation suite | 288 passed across 24 files; TypeScript, full ESLint and production/static builds passed |
| Final two-string REVIEW copy change | 116 focused tests across 6 files, TypeScript and targeted ESLint passed; final production/static builds verified separately |
| Actual Python/JavaScript rating parity | 1,062 offline cases, zero mismatches |
| Rust host suite | 69 passed, 2 deliberate packaged tests ignored; formatting and full host Clippy with warnings denied passed |
| Windows exact-module check | Included Evidence, Memory and Readiness modules compile and pass Clippy with tests; this is cross-compilation, not native Windows execution |
| Python lint/format | Ruff passed; 168 files already formatted |

Cases cover missing/skipped/failed/empty/partial/withheld sources, false rehashed passing receipts, wrong source bindings, insufficient SMA200 history, provisional/nanosecond bars, negative-zero offsets, DST, conflicting/identical duplicates, extreme numeric bounds, policy drift, checkpoint recovery, SQLite v7→v8 migration and global run-UUID identity. Unicode line separators, numbering, dotted-I tokens and combining marks preserve the Python rating parser's authoritative behavior.

## Actual browser and downloads

An owned production server and Chrome origin used two fictional tasks: a permitted balanced Hold, and an insufficient-input REVIEW. The Hold task also contained a legacy version without a readiness attachment. Version selection preserved that legacy unknown state; reload preserved each version's own complete Evidence and Readiness.

Actual downloaded JSON, Markdown and HTML were parsed and compared against the complete original envelopes. Every opaque artifact payload string compared exactly. The downloaded HTML was also opened in Chrome, and its rendered complete Evidence and Readiness JSON matched the originals.

Wrong assessment hashes, a coherently rehashed false pass, and individually valid conflicting receipts for one UUID blocked export. The global conflict case covered different current/frozen copies inside one task and a second owner holding one matching copy. Every attached owner became invalid; legacy absence remained unknown. All underlying Evidence content remained unchanged. The original fictional tasks were restored after these cases.

Screenshots show [passed inputs](../screenshots/readiness-ready.jpg), [legacy unknown](../screenshots/readiness-legacy-unknown.jpg), [withheld inputs](../screenshots/readiness-withheld.jpg), [false pass rejected](../screenshots/readiness-false-pass-rejected.jpg), [global conflict rejected](../screenshots/readiness-global-conflict-rejected.jpg), and the [downloaded HTML appendix](../screenshots/readiness-export-appendix.jpg). These cases assess input contracts and exports; demo role-progress flags are fictional and do not measure actual analyst execution.

## Packaged program and platform gate

An isolated x86_64 macOS PyInstaller artifact ran through Rosetta on an arm64 host. Its SHA is `66a36a751d9ad4a8c3a40706fbd2a02a11f7a40b1369780fa6f432adf5fe1551`, with 53,868,224 bytes. Actual bootstrap and research-import probes passed. Its research and prompt manifest matched the final source; all 88 embedded readable source files were independently compared by byte hash. The protocol's runtime timestamp was excluded from the manifest-field comparison. The root worktree's real sidecar was unchanged.

Native macOS ARM, macOS Intel and Windows execution is enforced by the pull request's Sidecar Diagnostics workflow, including source proof suites, Rust readiness/storage cases and explicit probes against the newly built packaged artifact. The local record makes no claim that this platform matrix had completed when it was recorded. Current platform results must be checked on the pull request.

## Remaining acceptance

Live provider metadata compatibility, publication and revision vintage, complete market calendars, claim-level factual and numeric support, expert-labelled research evaluation, predictive evaluation, target-analyst task completion, accessibility, clean install/upgrade, backup/restore and release signing remain open. See [the full quality criteria](../PROFESSIONAL_QUALITY.md). Input checks are a bounded engineering improvement, not a financial-confidence score.
