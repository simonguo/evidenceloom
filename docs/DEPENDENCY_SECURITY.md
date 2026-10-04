# Dependency security record

Reviewed on 2026-10-04. This record distinguishes registry audits, bundled code, and actual build observations. A clear registry audit does not establish that every bundled library or operating-system component is free of vulnerabilities.

## Patched locked dependencies

| Dependency | Previous version | Candidate version | Basis |
| --- | --- | --- | --- |
| urllib3 | 2.7.0 | 2.8.0 | [Chunk-size allocation](https://github.com/urllib3/urllib3/security/advisories/GHSA-vxq7-64xx-v4gw), [proxy TLS handling](https://github.com/urllib3/urllib3/security/advisories/GHSA-8988-9cw3-xx77), and [chunked deflate loop](https://github.com/urllib3/urllib3/security/advisories/GHSA-gh4c-6fx4-qh6g) |
| cryptography | 49.0.0 | 50.0.2 | [PKCS#7 decryption advisory](https://github.com/pyca/cryptography/security/advisories/GHSA-g6cj-pr64-35w5) and subsequent [50.0.x packaging updates](https://cryptography.io/en/latest/changelog/) |
| langgraph-checkpoint-sqlite | 3.1.0 | 3.1.1 | [Namespace segment isolation](https://github.com/langchain-ai/langgraph/security/advisories/GHSA-47pj-3jcm-6whg) |
| langgraph-sdk | 0.4.2 | 0.4.4 | [Resource decorator action selection](https://github.com/langchain-ai/langgraph/security/advisories/GHSA-fvww-7h3r-vfhp) |
| PyInstaller (development packager) | 6.21.0 | 6.22.1 | [Privileged onefile environment inheritance](https://github.com/pyinstaller/pyinstaller/security/advisories/GHSA-9fxf-4qw3-ghmr) |
| Vitest and its seven pinned companion packages | 4.1.10 | 4.1.11 | [Redirect mock path traversal](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) |
| brace-expansion | 1.1.16 / 5.0.8 | 1.1.21 / 5.0.12 | [Unbounded expansion advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr) |
| Browserslist | 4.28.2 | 4.28.7 | [Unbounded caches](https://github.com/browserslist/browserslist/security/advisories/GHSA-c83g-rgw3-j3cx) and [statistics object handling](https://github.com/browserslist/browserslist/security/advisories/GHSA-73wf-gq98-2v4g) |
| baseline-browser-mapping | 2.10.38 | 2.11.0 | [Advisory](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv) |
| js-yaml | 4.3.0 | 4.3.2 | [Advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh) |
| undici | 7.28.0 | 7.29.1 | [Upstream security advisories](https://github.com/nodejs/undici/security/advisories) |

Browserslist also requires the supporting data updates `caniuse-lite` 1.0.30001806, `electron-to-chromium` 1.5.393 and `node-releases` 2.0.51. The first is shared with production dependencies. Other Python package records and unrelated npm package versions remain unchanged. Next.js and Tailwind remain at their existing versions.

The fresh Python runtime requirements audit found five unique advisory IDs across three packages before the updates and none afterward. Its raw baseline output contains six findings because one cryptography advisory appears twice. The initial full npm measurements changed from 14 affected package entries to seven, and from 27 unique advisory URLs to one. A later explicit complete audit reported eight entries for the same patched lockfile because npm again attributed the Tailwind chain to `@tailwindcss/typography`; an ordinary full audit produced a byte-identical report. Earlier observations likewise reported 15 entries for the original lockfile. These attribution changes were not package updates or additional advisories. Both fresh npm production-only audits reported zero findings.

## Open exceptions

### braces development dependency chain

`braces` 3.0.3 still has the [deep-recursion denial-of-service advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). No patched release was available at review time; the [upstream issue](https://github.com/micromatch/braces/issues/70) remains the reference for a fix.

The seven core npm entries are `braces`, `chokidar`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next`, `eslint-config-next`, and `tailwindcss`. The reviewed eighth-entry variant adds only `@tailwindcss/typography` 0.5.20 through its locked Tailwind peer dependency. All affected locked instances are development dependencies. Ordinary tests use `vitest run`; no test API/UI listener is enabled. Project lint/build patterns come from repository configuration. This exception does not establish that untrusted patterns are safe.

The full-audit checker permits only this exact reviewed advisory and the two observed development-chain shapes. The eighth-entry variant requires the exact typography version, its locked peer edge and the matching Tailwind effect; these cannot be mixed with the seven-entry shape. New advisories, runtime nodes, altered versions or graph edges, malformed reports, and incomplete dependency references fail the check. Any other attribution or dependency change requires renewed review. The independent production audit keeps its existing threshold. The exception remains an unresolved finding.

The JSON report does not attest which dependency types npm audited. In particular, full and production-only reports can contain identical dependency counts. A coherent zero-findings report is accepted to support a future complete audit after fixes; its shape and lockfile consistency alone do not establish complete audit coverage. The trusted workflow invocation explicitly includes development, optional and peer dependencies, overriding omission settings such as `NODE_ENV=production` or `npm_config_omit=dev`.

### Next.js vendored Browserslist

The normal Next.js standalone output also copies `next/dist/compiled/browserslist`. Its package metadata has no version, so npm's package audit does not assess that compiled copy. The Next.js 15.5.27 bundle retains both behaviors fixed in the Browserslist advisories above: inherited-key statistics handling and unbounded result/parse caches. Updating the separate npm Browserslist package does not replace this copy.

An offline reproduction distinguishes the old vendored implementation from the patched npm implementation. Static source inspection identifies callers in build configuration and the development bundler; no externally controlled production request path was identified. The Next helper catches the statistics error, so the direct Browserslist reproduction does not demonstrate a whole-build or server crash. This is a bounded source finding, not proof of non-exploitability. The latest stable Next.js 15 release at review time remains 15.5.27. The registry-integrity-verified Next.js 16.3.8 archive retains the same two behaviors. A compatible upstream fix or separately reviewed replacement remains open.

## Automated checks and local scope

### PyInstaller onefile bootloader

The upstream High 7.8 [advisory](https://github.com/pyinstaller/pyinstaller/security/advisories/GHSA-9fxf-4qw3-ghmr) affects PyInstaller `<6.22.1` and is patched in 6.22.1. Spoofed bootloader environment state can affect privileged onefile executables. Evidence Loom's packaging spec uses onefile, but bounded source inspection found no request for setuid/UAC elevation; current application privileged exploitability is not demonstrated. This locked build-tool update requires rebuilding binaries; it does not modify previously built sidecars automatically.

The [validation record](validation/2026-10-04-pyinstaller-security.md) verifies all 12 published artifact tuples, unchanged package constraints and 112 other lock records. Two isolated, nonprivileged macOS x86_64 minimal programs built successfully with Python 3.10 and 3.12; six normal/reset controls exited 0 and two spoofed-state runs exited 255 with a parent-executable validation error, preserving the owned sentinel. These are minimal-program checks on original SDK 0.4.2 overlays, not a fresh combined release installation or a privileged exploit test. All three production sidecar builds and real bridges remain exact-head CI requirements.

PyInstaller is in the development group and is excluded by the current runtime-only Python audit export. Captured PyPI/OSV package-version responses also omitted this repository advisory, so adding development packages to that audit alone would not demonstrate complete coverage. No ignore or audit threshold changes were added. The generated third-party Python notice enumerates the runtime dependency closure and has no PyInstaller row; its scope remains unchanged. Complete build-tool inventory/security, signed release artifacts and clean-machine acceptance remain open.

### LangGraph SDK authorization registration

The upstream High 7.6 advisory affects SDK versions `>=0.1.45, <=0.4.3` and declares `0.4.4` patched. Resource decorators for threads, assistants and crons can register a handler for every action despite an explicit `actions=` selection. Actual impact depends on deployment and the handler's permission checks. Bounded application source inspection found no use of these SDK authorization decorators; an exploitable Evidence Loom request path has not been demonstrated.

The lock selects the [published 0.4.4 package](https://pypi.org/project/langgraph-sdk/0.4.4/), which supports Python >=3.10 and satisfies LangGraph 1.2.9's `>=0.4.2,<0.5.0` constraint. Only this locked package changes; all other 112 package records remain identical. The SDK release changes nine Python files, including behavior outside authorization. Its websockets upper bound expands from `<16` to `<17`; the locked websockets version stays 15.0.1. The third-party runtime notice is updated. This change applies to frozen/locked installation; existing environments and unlocked installs are not automatically upgraded.

The [SDK validation record](validation/2026-10-04-langgraph-sdk-security.md) preserves official artifact hashes, old/new registration observations and bounded local graph compatibility. A permanent 15-case test reproduces nine selected-action failures on SDK 0.4.2, with six unchanged controls, and passes on 0.4.4 with Python 3.10 and 3.12. The shared native diagnostic command includes it for all three platforms. Inspection of the SDK's private handler registry is a deliberate regression-test dependency, not a server authorization test.

There is a specific advisory-feed coverage gap: the captured PyPI 0.4.2 `vulnerabilities` array and OSV package/version response were empty despite the published repository advisory. OSV's CVE alias record mapped Git revisions without a PyPI package entry. The pinned pip-audit defaults to the PyPI service, so its clear result alone does not cover this finding. Existing audits, failure rules and exceptions remain unchanged. This observation does not establish that the entire audit service is ineffective or that every advisory is covered by manual review. Native frozen-install and packaging results remain tied to the pull request head; full clean-install, provider interoperability and broader release acceptance remain open.

The Security workflow runs on pull requests, main pushes and the weekly schedule. It installs the frozen npm tree, checks the full audit against the explicit braces exception, and separately audits production dependencies. Python auditing exports the locked runtime requirements with hashes, then uses pinned `pip-audit` without dependency resolution or vulnerability ignores. Vulnerability findings and audit errors remain failures.

Run the same Python audit locally:

```bash
uv export --locked --no-dev --no-emit-project --no-header \
  --output-file /tmp/evidenceloom-runtime-requirements.txt
uvx --from pip-audit==2.10.1 pip-audit \
  --require-hashes --disable-pip --strict --progress-spinner off \
  --requirement /tmp/evidenceloom-runtime-requirements.txt
```

For the full frontend report, explicitly include all dependency types. Preserve npm's exit status as shown in the Security workflow; exit 1 means findings and still requires the checker, while other nonzero statuses are errors:

```bash
npm --prefix frontend audit --include=dev --include=optional --include=peer --json \
  > /tmp/evidenceloom-frontend-audit.json
python3 scripts/check_frontend_audit.py \
  --report /tmp/evidenceloom-frontend-audit.json \
  --lock frontend/package-lock.json
npm --prefix frontend audit --omit=dev --audit-level=moderate
```

The `dev` and `start` npm scripts bind to IPv4 loopback by default; another hostname must be chosen explicitly. The standalone `server.js` has its own hostname configuration. This change does not add authentication or make a network deployment an accepted product workflow.

Local acceptance includes a fresh isolated install, the full offline Python and frontend suites, offline signing/chunk-boundary/namespace checks, both frontend build modes, and a relocated JavaScript standalone smoke. That copied output has no symlinks and omits all seven audited braces-chain packages. It contains two Python entry scripts but no Python environment or research core, so the smoke covers the page, assets and rejected-input routes. Complete web-backend clean-install acceptance remains open.

cryptography removed upstream macOS Intel support starting with version 49. Our local x86_64 source build succeeds and links OpenSSL 3.6.1. Official 50.0.2 wheels use OpenSSL 4.0.3; those are different observations. Native candidate packaging results are tracked by required PR checks, and do not restore upstream support. Actual proxy/provider interoperability, signed installers, operating-system library auditing and broader security acceptance remain open.
