# Source-map dependency security validation

Reviewed on 2026-10-06 against main `c0e2afa5bc0220dd3017e6df3a6f070ad894eabc` (M107). This record covers an isolated frontend dependency installation and project checks. It does not establish a shipped desktop application's exploitability, signing, installation or analyst acceptance.

## Change and provenance

The locked production dependency path is Next.js 15.5.27 → overridden PostCSS 8.5.23 → source-map-js. The [source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) affects versions `>=1.0.0,<1.2.2`: unchecked indexed-map offsets can block the event loop. The [upstream 1.2.2 release](https://github.com/7rulnik/source-map-js/releases/tag/v1.2.2) contains the fix. A vulnerable production dependency path does not by itself demonstrate an application request that reaches the vulnerable behavior.

The candidate adds an exact `source-map-js: 1.2.2` override and changes only that lock node's version, registry URL and integrity. All other 668 lock objects and lock top-level fields remain unchanged. The third-party notice advances the same package version and retains its BSD-3-Clause license. The accepted manifest SHA-256 is `4cf1cfe29854701884937b1482854826b1fa68c23c466c9d51b28f4ec002e268`; the accepted lock SHA-256 is `2f88477cf3a8e43498f80c68b8f531abdd9f41332c62e9ee29727534750ba4f4`.

An initial npm 10 lock-only resolution changed 22 unrelated objects as well as the target node; that output was rejected and preserved separately. The accepted projection was manually restricted to the intended fields, using the actual registry metadata and resolution result. Its tarball integrity is `sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==`. Registry provenance and npm's integrity check do not establish an independently verified publisher signature.

## Actual isolated checks

Node 22.22.3 and npm 11.6.2 installed 577 packages with `npm ci --ignore-scripts --no-audit --no-fund`. The command exited 0 in 187.45 seconds. The installed lock contains only canonical lock nodes; their versions, URLs and integrity values match. Scripts were disabled for this installation, so it is not a packaging-script execution check. The existing notice generator produced a complete 659-row Node section matching the updated checked-in section; Python and Rust notice sections were not regenerated in that local check.

| Check | Observed result |
| --- | --- |
| Audit-gate regressions / Ruff | 103 passed; lint and format checks exited 0 |
| Lint / TypeScript | Both exited 0; stderr empty |
| Full frontend tests | 829 passed, 10 skipped; 63 files passed, 2 skipped |
| Normal Next build | Exit 0; 20.69 seconds |
| Tauri frontend export | Exit 0; 12.03 seconds |
| Explicit complete npm audit | Exit 1 with `--include=dev --include=optional --include=peer`; 7 high and 3 moderate affected package names, all development nodes |
| Production npm audit | Exit 0; zero findings |

Each build emitted the existing warning that the Next.js ESLint plugin was not detected. The frontend tests emitted 44 React `act(...)` warnings; no unhandled-error section was observed. These results belong to this isolated candidate, not the separate unpublished desktop acceptance candidate.

## Contrary library evidence retained

Four source-map API cases produced three passes and one failure on 1.2.2. Basic mapping, malicious offset rejection and bounded nested-source access passed. An ordinary indexed-map section beginning at generated zero-based column 3 incorrectly returned no mapping at that boundary. The identical original case also failed on 1.2.1, and the relevant `originalPositionFor` function body is byte-identical between versions. This is an observed pre-existing vendor defect; all four API cases did not pass. The test expectation was retained, and application exposure to this defect remains unknown.

The old version's security-offset negative control failed because its constructor did not reject the oversized offset; it did not flatten or execute the potentially huge mapping. The new bounds case passed. These bounded cases do not establish a whole-process memory limit or a performance benchmark.

## Remaining security scope

An earlier ordinary full audit produced the same report bytes as the later explicit complete invocation. The fresh complete report has the existing [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) plus the [selector-parser CPU-exhaustion advisory](https://github.com/postcss/postcss-selector-parser/security/advisories/GHSA-rj75-hqrm-r3gf). Selector-parser is patched in 7.1.6, while the current locked parents require 6.x. A compatible replacement needs separate review. The checker now retains its historical seven/eight-name braces graphs and separately validates the exact ten-name, thirteen-instance combined graph, including both direct advisories and the original parent contracts. It reports both advisories and counts as UNRESOLVED, and rejects unknown, mixed or runtime findings. The current full findings are not described as clear or fixed; the production audit remains a separate required check.

Six appended malformed optional-edge/alias cases fail against the former ten-graph checker with “did not raise,” and pass in the complete 103-case suite after tightening. The original M107 checker rejects the new complete report; the new checker accepts that exact report only as an unresolved development exception. These controls are separate from the four library API observations.

Earlier main CI's seven-high summary and its production-only zero result have different scope and timing from these measurements. Their count difference has not been attributed to a specific cause. The documented vendored Next.js Browserslist finding also remains open. Exact-head CI, native packaging, signed releases, clean installations and external research evaluation are separate acceptance requirements.
