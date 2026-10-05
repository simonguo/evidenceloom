# PyInstaller locked bootloader security update

Reviewed on 2026-10-04, stacked on `f9e7be469a8be2d27db40109b88f1b4ab14850b0` (SDK and uncached diagnostic classifier candidates). Source commit `10f4abb6bac3457b76bca03e33cedd9982a4a998` changes only the PyInstaller lock record. The adjacent JSON binds the source, official metadata and actual limited local observations. Earlier base `67afab6` and SDK-only base `f629728` freezes remain separate retained records.

[GHSA-9fxf-4qw3-ghmr](https://github.com/pyinstaller/pyinstaller/security/advisories/GHSA-9fxf-4qw3-ghmr) is High 7.8, affects PyInstaller `<6.22.1`, and is patched in 6.22.1. Privileged executables can inherit attacker-controlled bootloader process/directory state, with code execution or directory removal in that privileged context. The current packaging spec creates onefile executables; bounded application source inspection found no setuid, `uac_admin` or `requireAdministrator` request. Upstream's default Windows manifest is asInvoker. That inspection and nonprivileged local runs do not prove absence of privileged deployment or current application exploitability.

The [official 6.22.1 release](https://pypi.org/project/pyinstaller/6.22.1/) satisfies the unchanged dev requirement `>=6.19,<7` and supports Python `>=3.8,<3.16`. The macOS wheel's 12 raw Requires-Dist strings are unchanged between the two releases. All 12 declared new wheel/sdist URL, size and SHA tuples match captured official metadata; both versions' macOS wheel and sdist (four actual components) were downloaded and hash checked. Actual package files and METADATA were verified separately. Those downloads do not constitute inspection of every platform binary.

Of 113 complete ordered lock records, only PyInstaller changes from 6.21.0 to 6.22.1. All other 112 records, top-level metadata, dependency edges and raw bytes outside that block remain identical. The lock SHA changes from `7574a279f791497aa1ea0006a3d17ddcc329214ce7498dc0d6ddf81e396e0f11` to `6bd7a835544b346f8b3fe4ab553116240bd05a63497382bfc25a1b39143b88be`. All 601 other base files remain unchanged in the source snapshot. Existing runtime/build constraints, fixtures and application protocols are not changed. A locked/frozen install selects the patched packager; existing installations and already-built executables require upgrade/rebuild.

## Actual local checks

| Check | Actual outcome | Scope |
| --- | --- | --- |
| Offline lock consistency, Python 3.10 and 3.12 selections | Both exit 0 | Metadata resolution, not fresh complete candidate installation |
| Minimal onefile build, Python 3.10.4 and 3.12.10 | Two actual builds exit 0, two macOS x86_64 binaries mode 0755 | Owned standard-library integer/JSON program; non-root equal real/effective UID |
| Normal, reset, explicit-reset-plus-spoof controls | Three per binary, six total, exit 0 and expected value 5 | Explicit reset clears inherited state as designed; not a bypass assertion |
| Spoofed inherited parent/directory state | Two total, actual exit 255; parent-executable security validation error; owned sentinels retained | Harmless owned fixtures, no elevated/setuid execution |
| File-format inspection | Two separate commands exit 0 | These are not two additional executable runs |
| Original and patched environment package bytes | Original 561 package files and patched 566 package files per runtime match their official wheels | Existing environments and original runner not modified |

The packager-only overlays were created at the original `67afab6` source with SDK 0.4.2 and read inherited dependencies from existing environments. In addition to the old SDK, Python 3.10 inherits cryptography, checkpoint SQLite, NumPy, pandas and urllib3 versions differing from the final lock. These local runs were not repeated after either SDK/performance stack. The PyInstaller block itself stays byte-identical across all stacks; final lock/source proofs were repeated without calling these old runs a combined fresh installation. Complete native macOS ARM64, Intel and Windows production sidecar/package/Rust/seed/real bridge checks remain required for the eventual PR head. No real provider/model call, user profile or privileged execution was used.

## Coverage and retained failures

The runtime-only Python audit export excludes the development packager. Captured PyPI vulnerability metadata and OSV package/version response for 6.21.0 were empty despite this published repository advisory. This is bounded evidence of audit-scope/feed gaps, not complete ecosystem coverage. No vulnerability ignore, scanner exception or failure threshold was changed. The third-party notice generator starts from project runtime dependencies, does not enumerate this dev-only tool, and has no PyInstaller row; its scope is retained.

Original local failures remain in `evidenceloom-validation/dependency-pyinstaller-security/`: an owned guard initially denied PyInstaller's legitimate `/dev/null` access; a corrected supervisor captured successful builds but then expected their output in the wrong directory and raised FileNotFoundError. A continuation read the actual recorded distpath and tested those same built binaries without rebuilding or deleting the original failures. Individual build timings were not saved before the supervisor error; its combined elapsed time must not be presented as each build's timing. A prior author summary incorrectly labeled spoofed-state exit codes 1; both original raw run records are 255, and this record uses that value while retaining the old summary.

The adjacent JSON identifies source and evidence files by path/SHA rows. Agent reviews and engineering checks do not constitute external analyst/expert approval. Complete build-tool/OS-library security, signed/notarized installers, clean-machine install/upgrade, production sidecar interoperability, privileged deployment assessment and the broader professional product objective remain open.
