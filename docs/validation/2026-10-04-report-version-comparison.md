# Saved report comparison validation

The implementation adds two independently selected saved versions to the Report Versions panel. Each side retains its own original sections, identity, dates, rating, configuration and format-quality record. The current running task and the single-version review/export selection cannot substitute their content for a comparison side.

The tested source is `a420e171a82e9b1ba8dda5b94b454f67ea1ed90c`, based on `79fd4e326159815accde8e8b28ef6bfdc564581b`. The original source commit `0affa8ca422239dbae41088f3f9e69428a3f5e6f` was rebased to include the public-corpus Windows test-name repair. All 13 comparison candidate file hashes match the final focused review. Full checks bind all 215 tracked frontend files before and after execution; their common manifest SHA is `bbf6fab6dbaf3e95ad81e2af1843dadbbee34e0a9603cc3f37c90be22b96e0c7`.

## Checks and preserved contrary evidence

| Actual local check | Result | Scope |
| --- | --- | --- |
| Full frontend tests | 43 files, 618 tests passed | Existing workflows plus saved-pair selection, original text, unsupported inputs and metadata regressions |
| Full frontend lint | Exit 0 | Complete frontend tree |
| Initial typecheck | Exit 2 | Three TS2307 errors reference the removed temporary page in generated `.next/types`; the original log is retained |
| Production build | Exit 0 | Ordinary Next standalone configuration, with the temporary page removed |
| Typecheck after production build | Exit 0 | Build regenerated the types; no candidate source or dependency change |
| Desktop static build | Exit 0 | `build:tauri`, including actual root and task-detail HTML output |
| Typecheck after static build | Exit 0 | Desktop-mode generated types |
| Final focused comparison tests | 56 passed | Four candidate test files |
| Separate repaired-boundary probes | 3 passed | Persisted malformed metadata, public run projection and ownership recovery |

Node was 22.22.3. Clean dependencies were installed with the declared npm 11.6.2; the local package-script launcher was npm 10.9.8. CI uses npm 11.6.2 and must be checked separately. The lockfile stayed unchanged. Both builds retain the existing warning that the Next.js ESLint plugin was not detected; independent full lint and builds passed. No warning-free build claim is made.

The independent pre-repair probes confirmed that an old `task: null` version survives normal local-storage loading and crashes comparison when the healthy newest version is selected. They also confirmed that raw run JSON renders arbitrary persisted extensions omitted by the existing public export projection. These observations, original probes, logs and source identities remain retained. The repair displays unavailable metadata without reconstructing context and uses an explicit public run projection. The reviewer then executed the repaired probes; this is engineering review, not an external analyst or expert assessment.

## Owned browser exercise

A temporary local route rendered the actual Report Versions panel using two explicitly fictional saved versions and distinct unsaved running-task text. Native Chrome was controlled through the documented computer-use APIs. A fresh reload after the final metadata repair showed baseline v1, target v2, their own Hold/Sell and quality states, and five changed sections out of seven.

Actual interactions verified Chinese/English labels, native keyboard version selection, the same-version zero-change state, retained expanded news and escaped text, CRLF/LF counts of 43/42, and a newly arriving v3 that leaves the v1/v2 pair unchanged. A malformed old metadata control showed unknown context while keeping original text and the healthy target available. Keyboard navigation opened the saved manifest and confirmed the injected arbitrary extension was excluded. Switching the owned task restored healthy fixture versions without a crash; component tests cover the complete selection-ownership transitions.

Chrome device simulation reported width 390, height 844 and 100% zoom. This records interaction and accessibility-tree observations at that viewport, not physical-device or comprehensive visual-layout acceptance. Desktop keyboard navigation was also exercised. No screen reader or target analyst participated.

Chrome's development-tool summary showed two errors and twelve warnings, but its console displayed zero messages and 43 hidden under existing preferences. Their origin was not established, and existing console settings and live expressions were not changed. This record does not claim a clean console. Some offscreen native clicks produced no change; subsequent keyboard interactions visibly opened the manifest. Closing the owned tab was not confirmed because the computer-use tool reported a user app change, so further UI actions stopped.

The fictional route was archived outside the source tree, removed before all full checks, and excluded from the source commit. The owned development process was stopped. Neither production route tables nor desktop static output contain the temporary route. No provider/model request, API credential, persisted task change or export upload was used.

## Reproducibility and remaining acceptance

The accompanying [JSON](2026-10-04-report-version-comparison.json) is a portable projection of retained execution records. It includes the exact source and frontend identities, command timings and exits, log hashes, the original cache failure, bounded browser notes and pre/post repair findings. The generator checked every retained command log against its hash and every frontend file against the common before/after manifest. Source identities are represented as separate `path`/`sha256` records; reconstructing the same path-to-hash mapping preserves the common manifest identity. Original logs and the temporary fixture remain in the owned validation directory; the JSON does not claim to contain every raw artifact.

At initial PR head `3d9cff479f2092af99c15a641e472d0ea7196234`, [gitleaks 8.24.3](https://github.com/simonguo/evidenceloom/actions/runs/37202474411/job/111436795073) flagged three values in the complete frontend manifest. They are the actual source SHA-256 values for `KeyValue.tsx`, `SecretField.tsx` and `CredentialField.tsx`, independently recomputed from the files. The generic API-key rule interpreted their filename keys followed by hashes as assignments. The record now keeps every identity in separate path/hash entries. No scanner rule, source or hash is removed. The unmerged documentation commit is replaced to remove the false-positive representation from the scanned PR history; the implementation commit remains unchanged. The original commit, full failed log and original record are retained and bound in the JSON. The repaired scanner and exact-head remote CI must still be verified.

Required CI must pass against the final pull-request head, including existing native-platform and packaged-sidecar gates. Local static export is not an installed native application or signed-release check. External analyst tasks, screen-reader acceptance, full historical/provider coverage and expert research assessment remain open. Saved text changes do not establish improved research or factual support.
