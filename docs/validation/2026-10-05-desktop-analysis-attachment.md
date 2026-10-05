# Desktop same-runtime attachment validation

A new frontend lifetime can observe the analysis still owned by the same native runtime, explicitly watch its original output, and stop that exact owner. Reattachment does not reserve or start another worker. Native authority is loaded before frontend history repair or queue admission.

The DCO-signed implementation is `5f7a87020836ce37334aa1bd5054cb830d7b75d8`, stacked on [PR #102](https://github.com/simonguo/evidenceloom/pull/102) at `a19d9f6e76ba5427de3b061408da2b34a74e51d7`. The [machine record](2026-10-05-desktop-analysis-attachment.json) binds all 26 changed implementation paths to committed bytes. This record captures local engineering acceptance; exact published-head CI remains pending at documentation time.

## Resulting behavior

The [attachment contract](../DESKTOP_ANALYSIS_ATTACHMENT.md) separates historical acknowledgement from fresh current authority. Durable live attachment reads and projects original rows using the canonical matching SQL task/head and verified applied prefix. Volatile attachment permits watch and exact Stop without projection. Retired or replacement-owner replies cannot grant a new control effect or launch.

SQLite schema 13 derives `projection_terminal_observed` by validating original rows through the applied cursor, including rows after an early terminal event. Invalid migration evidence rolls back. Unavailable positive-cursor history remains unknown and grants no durable anchor. Projection preserves the existing transactional task/cursor/original-receipt boundary.

Actual owned-handle join and historical SQL control failure remain separate facts. A late failed SQL receipt cannot undo confirmed physical cleanup. An explicit retry uses the latest known control revision and can record an already observed join without another physical cleanup. The next task still requires both confirmed cleanup and a sealed, fully projected previous journal.

## Actual local checks

| Check | Observed result |
| --- | --- |
| Full frontend suite | 811 passed in 62 suites, zero failures/errors/skips |
| Native integration/parser suite | 16 passed in 3 suites, zero skips |
| Full Rust suite | 260 passed, zero failed, 3 explicit ignores; 14 added parser/runtime cases |
| Rust format, compile and strict all-target Clippy | All exit 0; compiler diagnostics empty, lint warnings denied |
| SQL corpus producer | One exact test passed; eight actual SQL serialized replies retained |
| Frontend typecheck, lint, web build, static export and generated typecheck | All exit 0; frozen 250 frontend and 49 native inventory entries stay stable |
| Workflow syntax | YAML and embedded Python parse; remote execution is a separate gate |

Nine actual Provider scenarios run eighteen owned fictional workers through compiled production native modules and owned SQLite. Six existing scenarios retain consecutive-run coverage; three new scenarios cover same-module remount/watch/Stop, fresh-module direct Stop, and real completion during delayed listener acknowledgement. The other seven integration leaves are six ordinary boundary fixtures and one production TypeScript parser case consuming eight actual Rust SQL replies. These counts overlap the full suite.

The captured run A receives no V1 save or new reservation/start during attachment. One dedicated same-realm fixture observes an ordinary B update after A is ready and before B reservation; the assertion does not prohibit this unrelated pre-reservation repair. Both native cleanup and journal projection gates remain required before B starts.

Dedicated final integration contains zero React act warnings. The full suite retains 41 existing act warnings in eleven older contexts; the three new native attachment contexts emit none. Both Next builds retain one ESLint-plugin notice each. Rust output retains seven intentional caught panic injections and three explicit ignores: two real packaged bridges and the command entry exercised explicitly by frontend integration. No warnings are filtered or suppressed. The local compile-only runner placeholder is never executed.

## Retained failures and scope

Original compile errors, two strict migration fixture failures, the stale attachment-acknowledgement regression, and the initial integration's hardcoded B-identity failure remain recorded. Corrections retain original request, cursor, version, worker and queue-gate assertions. Intermediate passing runs and act warnings stay preserved. The final receipt builder also rejected an overstrong all-task V1 counter assumption; the record distinguishes this helper error from product/test failures.

Tests use real compiled production modules through a test-only JSONL bridge, not the packaged GUI or Tauri IPC transport. No production provider/model call, supplied key, user database or Keychain was used. Actual WebView reload, prior-runtime restart, copied/unsealed or offline settlement, pending discard, browser CAS, settings/Keychain atomicity, general IPC deadlines, shutdown, clean installation, upgrades, signing and external analyst/expert acceptance remain open.

The final publication must pass terminal check classification and complete raw-log review of all nine CI jobs, including three native platforms and both real packaged-sidecar bridges, before Ready. Local success does not predeclare platform CI results. All twelve [professional quality areas](../PROFESSIONAL_QUALITY.md) remain open or partial, with zero recorded participant completions/expert-approved claims and unknown participant availability. No merge was performed.
