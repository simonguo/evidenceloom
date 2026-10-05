# Settlement concurrency test failure propagation

Reviewed on 2026-10-04, stacked on `0c28a7ff314d7df459616d28ddd964d010a105b7`. Source `c6e15b00d762dc519bf0e93d136cc61f4ec56586` changes the existing boundary-test file and pytest warning policy only. Application settlement code, package constraints, lock bytes and fixtures remain unchanged relative to that base. The adjacent JSON binds the two source files and actual observations; documentation is separate.

## Confirmed gap and behavior

At PR #92 head `05fea22`, the actual Intel source run reported 1022 passed but included `PytestUnhandledThreadExceptionWarning`. The old delayed-list callback asserted `finished.wait(10)` while the main thread ran the first settlement. The second worker raised before receiving its stale list. The main thread joined it and checked only final saved data/no second reflection, so a crashed worker could satisfy those checks. The run did not prove the intended second-worker reload branch. This was a test exception-propagation gap, not a demonstrated application or sidecar protocol failure. The job later hit its separately recorded 90-minute timeout; no performance/host cause is inferred from the warning.

The revised test keeps the real sequence: the second worker first obtains an unreflected stale row, the first worker completes and saves reflection, the main thread releases the second, and the second must actually load the retained reflected row without invoking reflection again. Both workers return results or BaseExceptions through Future objects consumed by the main thread. Successful completion requires bounded joins and dead workers. The first completion stage is bounded at 120 seconds, delayed release at 240 seconds, and collection/join waits are separately bounded; these are not a 120-second total test deadline. `finally` always releases the delayed worker.

A permanent witness requires the exact worker AssertionError to reach the main thread. The global pytest configuration additionally promotes `PytestUnhandledThreadExceptionWarning` to error. Existing deprecation handling and other warning categories remain unchanged. This policy does not cover every possible swallowed exception or every background mechanism.

## Actual checks

| Check | Actual outcome | Meaning |
| --- | --- | --- |
| Author's final real race and exact-error witness | 2 passed, exit 0, thread warning treated as error | Complete owned race, including actual reload, plus error propagation |
| Failure injected after the second settlement actually returned | 1 failed, exit 1, no thread warning | Future.result rethrows on the main thread even though saved-data/no-reflector checks would otherwise pass |
| Root unhandled-thread sample under original config | 1 passed with thread warning, exit 0 | Reproduces the old false-green policy on an owned negative fixture |
| Same sample under new config | 1 failed, exit 1 | Global policy catches an unrelated unhandled worker, not only the fixed test |
| Root actual target tests under new config | 2 passed, exit 0 | Actual patched race remains valid with default new policy |
| Root complete boundary-test file after the final dependency/performance stack | 31 passed in 7.55s, exit 0; no failures/errors/skips | Existing consumer, shared-observation and durable scheduler boundaries retained |
| Offline lock check | 113 records resolved, exit 0 | No package constraints or locked versions changed by pytest configuration |

The local runtime is a newly owned Python 3.12 SDK 0.4.4 overlay reading other installed dependencies, rather than a fresh complete final dependency installation. The pytest cases use fictional research inputs, fake credentials and inherited offline network guards. No external model/provider API, user profile or privileged operation was used. Complete Python and all three native source/package/bridge checks remain exact-head requirements.

## Limits and contrary evidence

The first author's revised test failed because its reload observer included a load inside initial list construction. Restricting observation to the post-release phase corrected the harness; that original 1-failed/1-passed run and source are retained alongside the final successful run. The after-completion injection is an intentional negative result, not a candidate regression failure.

A genuinely stuck action cannot be forcibly stopped by Python threads. Timeout paths fail and release/join as far as possible, but may leave an owned daemon worker alive; a cleanup assertion can supersede an earlier exception while still failing closed. This candidate does not claim complete cleanup on every failure path or modify application cancellation. On the passing path both workers are confirmed dead and the second completes its real reload. Signed release/clean-machine, process-control, external analyst/expert and broad professional acceptance remain open.

The whole `pyproject.toml` is recorded as a declared dependency-file identity by the evaluation manifest. Adding a pytest option therefore legitimately changes that file SHA and derived evaluation result SHA despite unchanged dependency constraints. These identities must not be normalized or described as unchanged. Original head-bound Intel logs/annotations/warning trace, author failures, root policy controls and JUnit results are retained under `evidenceloom-validation/report-version-comparison/` and `evidenceloom-validation/settlement-race-test/`; the adjacent machine record uses a single validation-root path base.
