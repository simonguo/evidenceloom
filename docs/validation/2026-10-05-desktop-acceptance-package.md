# Fictional desktop acceptance package — local validation

This slice supplies a separately gated fictional desktop acceptance package. Its accepted scope is compilation, the current frontend build, manual unsigned x86_64 macOS App assembly and read-only static inspection. Actual startup and renderer/native acceptance remain open.

## Source and build identity

The base is merged PR #105, `7ac616164260b96627b2a6d93c496fcd371c8a43` (M105). Its main-push [CI](https://github.com/simonguo/evidenceloom/actions/runs/37302924389), [Security](https://github.com/simonguo/evidenceloom/actions/runs/37302924409) and [CodeQL](https://github.com/simonguo/evidenceloom/actions/runs/37302924475) runs recorded fourteen checks: eleven successes and three expected skips. Native and release workflows did not run for that push. These are baseline results, not checks of the later B publication head.

The original source08 B candidate contains ten native paths and eleven build, boundary, ACL and workflow paths. Its two publication documents are separate from those source inventories. The later PR #106 compatibility correction updates three Python build/boundary/test paths and the sidecar-architecture test fixture; it retains its own source and execution identity. Source08 binds 476 source entries and 56 explicit source/boundary/shared inputs; four original generated SDK schema files are separate preservation guards, not build inputs. The source08 joint record SHA256 is `8536cce877a65112cfb1980703ff4ddcad6482437a7524129a09e9c8fb023878`.

Actual03 ran once on 2026-10-05 UTC and produced build ID `c62abf0ad38095886f47f36ade8f0dd02112a7da1cee264dd5f95391ce8f1829`. The original source and owned compile copy retained source-inventory SHA256 `aa8b1c79c41b38d2d572197b81025819bcbb28aad1b9e65b63089ed57dbccc0c`.

## Behavior and observed checks

The `desktop-acceptance` feature selects owned application dependencies and a pinned fictional fixture. The default binary retains System mode; acceptance settings and controls cannot activate it through normal configuration or IPC. The build uses a fresh source-only native copy and target directory, existing Cargo cache and frontend dependencies and explicit home/temp paths. All four Cargo roles, frontend inputs, descriptors, ACL and legal files use the owned copy. Shipping checks reject acceptance artifacts before bundling or publication.

| Evidence | Actual result and identity |
| --- | --- |
| Historical source08 boundary checks | 37 pure cases passed; Ruff exit 0 |
| Earlier native checks | Default/feature compilation and strict Clippy passed; default unit 1, feature application 11 and fixture unit 5 passed; full default 273 passed with 3 explicit ignores. These retain original checkout `201a3c617b8cd20fee047cf49c1498dc4271e896`; later build-script checks have separate identities |
| Actual03 compilation and assembly | Four locked/offline release Cargo roles exited 0: fixture check/build, fixture check with App config, and main App build. One current frontend build completed. Pipeline and outer exits were both 0; Rust compiler diagnostics were zero |
| Actual03 static inspection | Seven packaged files and their source/config/frontend bindings were accepted. Main and fixture Mach-O load commands referenced only system libraries, with no rpaths; the App and both binaries were unsigned. Expected `codesign -d` exit 1 observations did not sign anything |

The frontend retained one nonfatal warning that the Next.js plugin was absent from the ESLint configuration. The 476 source files, 56 explicitly bound inputs, four schema guards, compile-only marker, original real runner, M105 HEAD/tree and the 21-path worktree status remained unchanged. The build owner and child process group exited, and its exclusive lock was released. This is build-process disposition, not App or fictional-worker cleanup acceptance.

## Preserved failures

Actual01 failed because the frontend copy omitted five shared JSON siblings. Actual02 completed compilation and assembly with pipeline exit 0, but its outer exit was 1 because SDK generation changed four tracked schema files in the original source. Its overall result remains a failure. Source08 routes every Cargo role through the complete owned source copy; actual03 preserved the original files.

The first read-only assembled-artifact inspection failed when `otool-L` and `otool-l` receipt filenames collided on the case-insensitive filesystem. Correcting only receipt labels allowed inspection03 to pass, without a product-source edit or recompilation. Original build and checker failures remain retained under their actual identities.

## Published-head CI correction

[PR #106](https://github.com/simonguo/evidenceloom/pull/106) remains a draft. The first published head `2b702f013eb2d94384930e9044a291133de618b2` used actual CI merge checkout `be26c88f4e18b26ecb37a377e9720def3601459f` with M105. Its [CI run](https://github.com/simonguo/evidenceloom/actions/runs/37360802477) passed Rust (273 tests, 3 explicit ignores), frontend (829 tests, 10 conditional skips) and its separate security checks. Each of the four Python jobs failed the same nine sidecar-wrapper cases because their disposable repository omitted the newly required boundary checker. The [Apple Silicon native job](https://github.com/simonguo/evidenceloom/actions/runs/37360802562/job/111934621109) independently reported those nine failures and 1,130 passes; its later packaging, Rust and acceptance stages were skipped. These failures retain their actual head and are not certified by historical native successes.

The correction copies the real checker and spec into the disposable fixture and supplies source/bytes-bound fictional proof prerequisites with a fixed fictional commit. Existing architecture, bootstrap, runtime and redaction assertions remain active. Three additional wrapper cases reject missing proof, changed binary bytes and stale source before either the probe or npm starts. Fixture proof prerequisites are synthetic test inputs, not actual production build certificates.

Normal sidecar and shipping proof grammar now preserve the architecture checker's six existing native targets, including Linux. Acceptance tooling remains restricted to its three targets, and the macOS release batch still requires its original two targets. The normal wrapper had no earlier App target restriction; applying the acceptance restriction to shipping would have broken its existing Linux path. No release workflow or published-platform claim was added.

The corrected local source passed 31 sidecar-architecture/probe cases, 41 mocked pure boundary cases and Ruff, all with exit 0. Rust/Cargo, provider and original-runner execution were not part of these checks; the native probe executables were disposable C fixtures. The six-target grammar cases do not establish actual Linux or Windows ARM packaging. The correction needs fresh checks of its own published head. Actual03 and its static inspection retain the original M105/source08 identity and were not rebuilt or relabeled.

The second published head `b1195aca6ad2b256feef0870fb439ff064d6432d` used CI merge checkout `e31d82b95c4538fd6e32779e7be4bf652944bac9`. Its [Python 3.12 job](https://github.com/simonguo/evidenceloom/actions/runs/37365944519/job/111951010599) passed lock and Ruff lint checks but failed Ruff's format check for three Python files; the subsequent test steps were skipped. The formatting correction changes only those files' layout, with all three normalized Python ASTs unchanged. Local repository-wide Ruff lint and format checks now pass for 217 files. Runtime tests were not repeated for this formatting-only change; fresh published-head CI remains required.

## Acceptance still open

No acceptance App or complete B fixture main, WebView, real Tauri IPC, provider/model, user database, System credential API, signing, installer or shipping release was executed in these build/inspection stages. Static bytes and loader references do not establish actual `PreparedAcceptance`, typed Context/embedded-assets lookup or resolved startup authority. A separately reviewed launcher, rendered frontend/IPC/SQL/journal/projection checks and owned-process cleanup on exit, Stop, reload and failure are still required. Every published B head needs its own native and CI gates.

All twelve [professional quality areas](../PROFESSIONAL_QUALITY.md) remain open or partial. External participant completions and expert-approved claims remain zero, with participant availability unknown. This package is engineering evidence, not research accuracy, analyst acceptance or product completion.
