# Intel Mac CI timeout and retained coverage

At PR #90 head `d98eeba0baf601df2acf3791ab85b2d6d5a5b6b6`, 16 checks
succeeded, the private-repository availability check was skipped as expected,
and the Intel Mac native job was cancelled. This is a failed candidate gate.

[The actual job](https://github.com/simonguo/evidenceloom/actions/runs/37195862145/job/111417461784)
started at 10:35:42 UTC and completed at 11:20:59 UTC on 2026-10-04. Its
annotation states: "The job has exceeded the maximum execution time of 45m0s".
The source-test step ran from 10:37:59 to 11:20:55 UTC and was cancelled;
packaging, Rust fixtures and the real packaged-sidecar bridge were skipped.
Those skipped steps provide no acceptance evidence for Intel Mac at that head.

The quiet test log shows a completed progress line at 48%, with 432 dots. It
does not identify the active test or establish a failed assertion. A local
collection-only run at the same head collected 885 native source tests, with
the selected-claim tests occupying ordinals 283 through 492. Mapping the slow
progress interval to those ordinals is an inference, not an Intel profiling
trace. The original failed job, annotations, full log and final check states
are retained in the accompanying JSON's source-artifact identity list.

The workflow now gives the Intel Mac job a 90-minute budget. ARM Mac and
Windows retain their 45-minute budgets. Every source test, frozen dependency
check, packaged build and probe, Rust fixture and real bridge command remains
unchanged. This adjusts the CI budget; it does not fix or certify application
performance. The next exact-head remote checks must establish whether every
required step actually completes. The earlier successful checks cannot be
reused as acceptance for the new head.

A separate, single local `validate_pack` profile on an owned legal three-report
fixture observed repeated diagnostic secret collection and decision validation.
It used a cleared environment and cannot establish the Intel timeout's cause.
No source optimization or coverage reduction is included in this repair.

The [earlier source validation](2026-10-04-frozen-claim-evaluation.md) and
historical results remain unchanged. This workflow-only repair does not change
the Python implementation, policy, fixture, lock files or their hashes.
