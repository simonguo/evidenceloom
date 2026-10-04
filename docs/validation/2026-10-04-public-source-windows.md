# Windows corpus test-name failure and repair

At PR #91 head `e49c3749cc7f1f372983e85202fda7730cf1c419`, the
[Windows native job](https://github.com/simonguo/evidenceloom/actions/runs/37199181087/job/111427142889)
failed during source diagnostics. Its actual log reports 1,006 passed, 15
skipped and two errors in 1,132.49 seconds. Packaging and the real Rust bridge
were skipped, so this head supplies no Windows packaging acceptance.

The error occurred in pytest's setup and teardown bookkeeping, where it writes
the active node ID to `PYTEST_CURRENT_TEST`. The 8 MiB + 1 byte size-boundary
parameter had been expanded into its default test ID. Windows rejected the
environment-variable value as longer than 32,767 characters. The raw error
heading alone is over eight million characters. This is an observed runner
bookkeeping error, not a failed numerical assertion.

The repair gives the same six raw-input cases explicit short parameter IDs.
The oversized input remains exactly 8,388,609 bytes, and all original input
expressions and assertions remain unchanged. An AST comparison against the
failed head confirms that only the parameter IDs changed. There is no product
implementation, fixture, policy, dependency, workflow or coverage change.

A fresh actual local run passed all 137 corpus tests. A collection hook checked
every node ID with the teardown phase suffix; the maximum is now 208 characters.
It separately recorded all six boundary payload types, lengths and hashes.
Ruff, formatting and `git diff --check` passed. Protected code, input, policy
and dependency bytes remained unchanged during the checks. This is macOS
execution and a measured test-name bound, not Windows execution. Complete
remote checks are required again at the repaired PR head.

The accompanying JSON retains the failed job and clipped line excerpts, binds
the unchanged 33,597,136-byte raw log by its SHA, and includes the local repair
proof. Clipped excerpts are explicitly distinguished from the original log.
Earlier [corpus validation](2026-10-04-public-source-corpus.md) remains
historical evidence; it cannot replace this failed gate or the next required CI.
