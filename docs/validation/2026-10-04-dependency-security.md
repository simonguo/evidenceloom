# Dependency security validation — 2026-10-04

This candidate is based on `acba825011373c82828cc785d15a3559a0423cdf`. It updates three Python package records and 17 npm package instances, adds continuous dependency audits, and binds the local npm servers to IPv4 loopback. Research source, prompts, saved-report schemas and rating behavior remain unchanged. See the [dependency record and open exceptions](../DEPENDENCY_SECURITY.md) and [machine-readable measurements](2026-10-04-dependency-security.json).

| Check | Observed result |
| --- | --- |
| Independent frozen Python 3.10 install | Passed; cryptography 50.0.2 built from source on x86_64 macOS |
| Existing complete offline Python suite | 1,043 passed, 75 subtests passed, 1 integration case deselected; eight existing model-name warnings; 144.05 seconds |
| New frontend audit gate cases | 35 passed; new advisories, runtime nodes, broken references, altered counts, malformed JSON and registry errors rejected |
| Python lint, formatting and lock check | Passed |
| Offline dependency compatibility | RSA/EC google-auth PEM signing and verification, valid chunk reading, oversized chunk-line rejection, SQLite sibling/literal-percent namespace isolation passed |
| Runtime requirements audit | Three affected packages and five unique advisory IDs before updates; zero reported afterward |
| Fresh independent npm install | Passed; node_modules is a real directory, separate from existing worktrees |
| Frontend tests and checks | 288 tests across 24 files, typecheck and full ESLint passed |
| Frontend builds | Normal standalone and Tauri static modes passed |
| npm full audit | 14 affected entries / 27 unique advisory URLs before patches; seven entries / one unresolved advisory afterward |
| npm production-only audit | Zero findings before and after |
| Full-audit gate against actual reports | Original baseline rejected; final report accepted only with an explicit unresolved braces exception; zero report accepted |
| Third-party notices | Regenerated for the 20 changed package versions; second generation unchanged |
| Actual local packaged sidecar | Architecture, bootstrap and research-runtime gates passed; embedded versions and compiled/readable sources checked |
| Local server listeners | `dev` and `start` bound only to 127.0.0.1; both 127.0.0.1 and localhost HTTP requests passed |
| Relocated standalone JavaScript output | Home page and 13 referenced assets returned 200; two empty-input API requests returned the expected 400 before Python work |

The full-suite tool output was observed but was not saved as a complete standalone log. The machine record retains the command/results and final component hashes. Additional audit-gate tests were run after that complete suite; final required CI supplies the combined suite and platform results. Neither validation sequence used market providers or model APIs.

The isolated Mach-O x86_64 sidecar is 53,951,632 bytes with SHA-256 `5d66296384cb46883d077bc4e8ab4e0f552baac0e6b5cbd08adb6a8aa53ac79e`. All 88 embedded readable research sources and 98 compiled application/CLI modules match the candidate, excluding six namespace entries that have no code. Its research hash remains `17593da79aaab79085d6a1c5fd28991a04e8ed9fa243d53ddfa53c7ce0811601` and prompt hash remains `361c2952214420de79ace08dcff8c7f5723f7c9a3bb77af25b48ed7ace8ffed0`. Embedded distribution metadata identifies cryptography 50.0.2 and urllib3 2.8.0. SQLite distribution metadata is not copied; its three compiled checkpoint modules match the separately frozen 3.1.1 installation. The source-manifest command completed in 20.673 seconds through Rosetta under the existing 90-second probe limit. The original workspace sidecar hash remains unchanged.

The copied standalone contains 139 package manifests, no symlinks, and none of the seven audited braces-chain packages. It includes two Python entry scripts, but no Python environment, `cli` package or `tradingagents` core. This proves the copied JavaScript artifact smoke, not a complete standalone research installation. Existing Sharp optional-tree issues appear in both independent baseline and patched `npm ls --all` observations; installs and required builds succeed. The existing Next ESLint-plugin detection warning also remains.

The Next 15.5.27 and registry-integrity-verified 16.3.8 vendored Browserslist implementations retain the statistics and unbounded-cache behaviors. Direct offline probes distinguish them from the patched npm 4.28.7 package. Identified callers consume build/dev configuration; no production HTTP input path was demonstrated. The Next helper catches the statistics error, so the direct reproduction does not prove a whole-build crash. This known limitation and the unpatched braces chain remain open.

Native macOS ARM, Intel and Windows source/install/build/protocol checks are required on the candidate PR. They were pending when this local record was written. Local cryptography links OpenSSL 3.6.1; official wheels use 4.0.3, and upstream macOS Intel support was removed starting with cryptography 49. Passing our source builds does not restore that upstream support. Real proxy/provider interoperability, operating-system dependency auditing, signed installers, clean installation and analyst/research acceptance remain open. The broader professional-product objective is not complete.
