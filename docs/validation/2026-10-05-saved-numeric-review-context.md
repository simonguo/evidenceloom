# Saved numeric review context validation

An analyst can expand a selected historical numeric review to inspect its exact original report section, marked number/context byte ranges, and complete saved source row with raw cell types. Switching task or selected version hides the previous review state on the first render. Expanded content is withheld when the current report core, history or target no longer matches its verified parent.

The DCO-signed implementation is `e27a43902535cac995de75f688f1a5ffed64ce45`, based on integrated main `5112884947ca175ca5400c8f59a89a875bf0145f`. The [machine record](2026-10-05-saved-numeric-review-context.json) binds all five production and five test paths to committed bytes. These are local engineering results; publication and exact published-head CI are pending at documentation time.

## Resulting behavior

The panel receives the detached version already validated by the existing [Numeric Review](../NUMERIC_REVIEW.md) verifier. It does not fetch or start a review. A closed native disclosure contains only a generic label. On expansion and each subsequent render, the helper checks the exact task and selected object owner, complete immutable version core, saved history, target, snapshot, evidence and source selection before showing original content.

Original text is partitioned by verified UTF8 byte boundaries with fatal decoding and BOM preservation. CJK, emoji, combining marks, CRLF and repeated numbers retain their exact position and text. The displayed table uses the same complete-table validator as the existing numeric resolver: global column/date uniqueness and row shape precede selected row and field checks. Raw number tokens preserve precision, exponent spelling and negative zero. Strings, nulls, booleans and nonnumeric structures remain distinct. A saved but unsupported numeric token can be inspected without changing the recorded unknown comparison result.

Withheld, unavailable, malformed, missing and ambiguous source states remain explicit. Legacy/manual absence does not invent a location. Chinese and English native details/summary controls and table headers provide semantic markup; physical keyboard and screen-reader acceptance remain open. The original review policy, arithmetic, hashes, save packet, storage schema, exports, dependencies and native/Python code remain unchanged.

## Actual local checks

| Check | Observed result |
| --- | --- |
| Targeted DOM, hook, inspection and source tests | 30 passed in five files; zero failures/errors/skips |
| Complete frontend suite | 825 passed, ten explicit native-fixture skips; 63 passing and two skipped files |
| Typecheck, lint, web build, static export, generated-type check | All exit 0; source inventory stays at the same 255 frozen entries |
| Exact old-source hook comparison | Three preservation controls passed; three first-frame stale-state assertions failed on original main; candidate passes all six |
| Legitimate large saved history | 1,000 actual hash-chained reviews pass the real verifier and remain folded without exposing original text or data rows |

The 1,000-review case verifies a valid large workload, hiding and immutability. It does not measure latency. Original-text and data-row positive controls precede in-place core/history mutation negatives. Tests distinguish first-render stale state, late callback isolation, exact source invalidity, legacy/manual absence and local persistence failure. The old failing cases stop at their first-frame assertion; they do not demonstrate a later old compare/save failure or three independent product defects.

## Preserved limitations and failures

The targeted run retains 25 React act warnings in the two existing NumericReviewPanel cases. The full run retains 44 in eight existing test contexts across four files, compared with 41 in the prior #103 full run. The aggregate increase of three is recorded without assigning individual stack causality or claiming every warning count is unchanged. New SavedNumericContext and hook cases produce zero act warnings. No warning is filtered or suppressed.

Web build retains a no-cache notice and Next ESLint plugin warning; static build retains the plugin warning. Web output announces Next telemetry but does not prove that anything was sent. The subsequent static build explicitly disables telemetry. No production provider/model request, user database, Keychain, desktop GUI or real IPC operation was performed, and no blanket zero-network claim is made.

Original draft fixture, test typing and lint failures are retained alongside the final results. The initial source-only independent narrative counted 7 hook/31 focused cases; the final combined review corrects these to actual JUnit counts of 6/30. Its separate packed-Git-object helper failure is also retained and is not a product test failure.

This UI-only slice does not rerun unchanged local Cargo/native suites. Existing native CI workflows still have to complete for the published head. Real WebView/IPC, physical accessibility, analyst task completion, expert claim support, historical validity, release and competitive acceptance remain open. All twelve [professional quality areas](../PROFESSIONAL_QUALITY.md) remain open or partial, with zero recorded external participant completions and expert-approved claims; participant availability is unknown.
