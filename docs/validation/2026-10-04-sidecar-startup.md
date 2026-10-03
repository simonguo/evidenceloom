# Sidecar diagnostic and build-contract validation

This candidate distinguishes bootstrap availability from actual research-runtime imports. A fast `ready` event cannot establish research readiness. The desktop health check uses the legacy-safe `smoke_test` command with `verifyRuntime: true`, requires `runtime_ready` and a successful exit, and reports failed or unsupported checks through the existing diagnostics view. Auto mode checks the runner it actually selects. Diagnostic work runs outside the asynchronous UI executor.

The build scripts validate the interpreter's active OS/CPU before cleaning or building, and validate output or reused executable headers before copying or packaging. Mach-O, universal Mach-O, ELF and PE fixtures cover the supported parser identities. These checks do not establish signing, libc ABI compatibility or the architecture of every embedded dependency. The official release target matrix is unchanged.

## Local packaged observations

The [machine-readable record](2026-10-04-sidecar-startup.json) identifies the executable, diagnostic source hashes, research manifest and measurements. The isolated PyInstaller build used the repository's x86_64 Python 3.10 environment on an arm64 Apple Silicon host through Rosetta 2. It did not replace the main worktree's real sidecar. No provider credentials were supplied or provider requests made.

| Scope | Fresh process observations | What passed |
| --- | --- | --- |
| Source bootstrap | 0.0522, 0.0528, 0.0537 seconds | `ready` without importing research dependencies |
| Source inventory | 0.0587, 0.0578, 0.0584 seconds | Source hashes and count without research imports |
| Packaged bootstrap | 22.1147, 12.2079, 11.7072 seconds | One `ready` event, exit 0, empty stderr |
| Packaged inventory | 12.1494, 11.5669, 11.5032 seconds | Exact development-source hashes and 80 readable research files |
| Packaged research imports | 62.8508, 43.0167 seconds | One `runtime_ready` event, exit 0, empty stderr |

Each packaged observation used a new process and temporary extraction directory. Filesystem and OS caches were not reset, and measurements were sequential on one host. They are local observations, not a statistically controlled comparison or a release-performance claim. Full analysis startup remains expensive. The prior [packaged evidence record](2026-10-04-packaged-evidence.json) remains a separate observation of the earlier artifact.

The packaged research hash matched the current 80 source files; the prompt hash matched the agent sources. An arm64 target check rejected the actual x86_64 executable. Source hashes retain their existing scope: `tradingagents/**/*.py` and `tradingagents/agents/**/*.py`; the CLI helpers, Python runner entry and PyInstaller spec have separately recorded diagnostic source hashes.

The final desktop build wrapper also passed both strict probes against this actual artifact with `--skip-sidecar --skip-tauri`. The combined gate took 82.3199 seconds, within its shared 90-second budget. This verifies reuse checks; it does not produce or validate a Tauri installer.

## Verification and remaining scope

The final offline Python suite passed 803 tests, with one external-service test deselected and eight expected unknown-model warnings. Ruff, Python formatting and Bash syntax checks passed.

Source subprocess tests deliberately block research imports for bootstrap/inventory, block networking for the full-import probe, and verify safe errors and single-read stdin behavior. Build fixtures verify that interpreter mismatch prevents cleanup/install/build and output mismatch preserves the previous destination. The final 84 focused Python cases passed, including strict protocol, process-tree, build-wrapper and UTF-8 cases. Rust formatting, Clippy with warnings denied and 31 default tests passed; the packaged probe is ignored by default and passed when explicitly selected against the actual artifact. That application-module integration took approximately 56 seconds including Cargo startup. A separate minimal Rust driver also accepted the same packaged artifact. The probe module passed Windows x86_64 and macOS arm64 cross-compilation checks with the repository's Rust toolchain and Serde versions; these checks do not execute those targets.

Release checks share a 90-second budget across both stages; desktop diagnostics give the full probe a 90-second budget. Both include cleanup, bound stdout, discard private error bodies and require strict JSONL plus exit success. Offline cases exercise invalid, duplicate, oversized, legacy and failed responses and process-tree cleanup. The new native CI matrix builds real sidecars and runs both Python release gates and the explicitly selected Rust packaged probe on macOS arm64, macOS Intel and Windows x86_64. Results must be terminal before claiming those checks passed. Neither these checks nor source inventory verify provider access, factual research, clean installation, signing or upgrades. Native installation and process cleanup on actual signed release artifacts still require their platform acceptance matrix.
