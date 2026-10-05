# Output-format quality validation — 2026-10-04

This record covers the first professional-research quality implementation on `quality/structured-output-observability`, based on merged revision `bcdf4f4`. It is engineering validation with offline provider fixtures and fictional live-model inputs. It does not establish research accuracy, predictive performance, or completion of the [product quality criteria](../PROFESSIONAL_QUALITY.md).

## Results

| Check | Result |
| --- | --- |
| Python offline suite | 658 passed, 1 external-service case deselected, 75 subtests passed; 8 expected unknown-model warnings |
| Ruff check and format | Passed; 140 Python files formatted |
| Python lock and application/core version consistency | Passed; application `0.1.0-beta.10`, core `0.2.5` |
| Frontend | 55 tests passed; ESLint, TypeScript, web production and Tauri static builds passed |
| Rust | 19 tests passed; format and all-target Clippy with warnings denied passed |
| Packaged sidecar | Built separately in `/tmp`; the `smoke_test` stdin command returned a `ready` event |
| Real compatible gateway | [Fictional format case](2026-10-04-output-format.json): three schema-validated decision agents, three physical Chat Completions requests, readable final rating |
| Browser report review/export | Fictional v1 expanded with its frozen body and unknown format quality; downloaded Markdown retained the version ID and unknown status |
| Attribution and repository checks | Third-party notices regenerated without changes; diff whitespace check passed |
| npm production audit | 0 findings |
| npm full audit | 15 affected package entries: 12 high and 3 moderate; all are development dependencies |

The offline cases exercise real OpenAI SDK request counts for default and explicit budgets, plain and schema calls, async invocation, protocol incompatibilities, parse failures, refusals, truncation, and UTF-8. Graph/desktop cases cover concurrent analyst isolation, checkpoint persistence/resume, accumulated progress, final snapshots, and an unselected sentiment analyst. Storage cases cover old schema upgrades, immutable report versions, and filtering malformed or extra quality fields before persistence and when reading older records.

The screenshot shows the initial preview validation before the final explanatory sentence about missing node records was added. The final frontend build and tests include that sentence. Browser-control connectivity failed during the final screenshot refresh; the earlier screenshot and completed export inspection remain the recorded visual evidence.

## Limits and follow-up

The live case is one compatibility observation for `gpt-5.4-mini`. Other provider families have offline format/error cases, with additional live cross-provider validation still required. The sidecar check establishes packaging and startup, while clean-install, signed-release, macOS ARM, and Windows validation remain open.

Compatible development-dependency patches and the unpatched `braces` dependency chain remain separate work. The audit increase from 14 to 15 entries reflects the existing Tailwind chain being attributed to `@tailwindcss/typography`; the set of direct advisories did not change. Production auditing remains clear. Full source snapshots, resolvable citations, precise research-time boundaries, immutable outcome contracts, and expert research evaluations remain open in the product quality document.
