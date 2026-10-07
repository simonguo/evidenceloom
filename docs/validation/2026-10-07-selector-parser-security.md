# Selector-parser security migration

This candidate replaces the three locked development instances of `postcss-selector-parser` with an exact `7.1.6` override. The [upstream advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) identifies flat-selector CPU exhaustion and declares 7.1.6 patched. No production request exposure was demonstrated. The baseline is workspace `e092999`, whose tree is identical to merged main `47ec4bf`.

Typography's exact 6.0.10, postcss-nested's ^6.1.1 and Tailwind's ^6.1.2 declarations remain unchanged. The replacement is outside all three contracts; installing it alone cannot establish compatibility. Other locked package records are semantically identical, and unrelated key ordering is preserved. The Node notice section now contains 658 unique package/version rows, generated with the existing generator's Node functions. Its Python and Rust sections are preserved byte-for-byte.

## Local results

| Check | Actual result |
| --- | --- |
| Independent npm 11.6.2 installation, Node 22.22.3 | Exit 0; 575 installed package records match canonical lock versions, registry URLs and integrity values |
| Parent parser resolution | All three parents resolve to the sole root 7.1.6 instance |
| Frontend lint / typecheck | Both exit 0 |
| Full frontend suite | 893 passed, 11 conditional native-fixture skips; exit 0 |
| Normal desktop frontend collector/build | Compiler exit 0; closed registry; 501 source inputs and 44 exports |
| Generated CSS comparison | One 60,370-byte file; byte-identical to the retained baseline |
| Focused audit suite | 52 passed; exit 0 |
| Ruff on changed Python files | Exit 0 |
| Explicit complete npm audit | Exit 1 for seven high development package names, one braces advisory; no moderate findings |
| Checker applied to that actual complete report | Exit 0 with the unresolved braces exception explicitly named |
| Production npm audit | Exit 0; zero reported findings |

The exact compared CSS is `_next/static/css/587c5acaa5bfe3c1.css`, SHA-256 `b9ae11c4007b82c608ecc680b173a4f0cf2b3f375907ecc4db743c6359147a08`. Baseline bytes were retained before changing dependencies and verified against their original collector inventory. Candidate bytes match its fresh inventory and the baseline directly. All 501 candidate source inputs matched the worktree after compilation. This comparison establishes CSS compatibility for the current project sources and configuration.

The old ten-name selector/braces exception is removed from production rules. Its historical fixture is retained as a function/CLI rejection case; the original seven/eight-name, zero-report and rejection tests remain. These rules do not independently detect an advisory omitted by the registry. The trusted complete invocation still includes development, optional and peer dependencies, and the separate production threshold is unchanged.

The first install failed with a registry idle timeout. A subsequent owned download was stopped after a long wait; its SIGTERM/SIGKILL intervention and original failed logs are retained outside the repository. Only unchanged Next.js/SWC archives were copied from an earlier owned cache and independently SHA-512-checked against the lock. Final `npm ci --ignore-scripts --offline --no-audit --no-fund` installed into a newly created dependency directory in four seconds. The declared npm tooling was copied into a separate owned directory; an initial user/global config-path collision was corrected. This is an independent installation using verified archives, not a fresh network download of every package or an install-script execution check.

The focused Python suite used the locked pytest 9.1.1 and Ruff 0.15.22 tools installed with artifact hashes in an owned environment. It ran with `--noconftest`, omitting shared provider/network fixtures that are unrelated to this stdlib audit checker. Full configured Python/native checks and the standalone frontend build remain published-head CI requirements. Existing frontend React act warnings remain visible. The unresolved braces chain, vendored Next.js finding, production-provider interoperability, signed releases and external analyst acceptance remain open; these local checks do not certify the complete application as vulnerability-free.
