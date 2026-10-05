# LangGraph SDK locked security update

Reviewed on 2026-10-04 against base `67afab6d9b15c62017216c0c4f7f6f7a37695f86`. Source commits are `6935164` (lock) and `a2826544b8047232aaf7b5baeea7f6212f5a7467` (regression test, native invocation and notice). The adjacent JSON binds the four source files and captured local evidence. Documentation commits are separate.

## Advisory and change

[GHSA-fvww-7h3r-vfhp](https://github.com/langchain-ai/langgraph/security/advisories/GHSA-fvww-7h3r-vfhp), CVE-2026-104873, is High 7.6. It affects `langgraph-sdk >=0.1.45, <=0.4.3`; the announced patch is 0.4.4. In affected versions, `actions=` on resource-scoped authorization decorators can register a resource-wide handler, bypassing broader fallback handlers. Exploitability depends on the deployment and handler's own checks. Bounded repository searches found no application SDK Auth decorators or LangGraph API deployment configuration; an application attack path has not been established.

The [official release](https://pypi.org/project/langgraph-sdk/0.4.4/) supports Python >=3.10. LangGraph 1.2.9 requires `>=0.4.2,<0.5.0`. The pure Python wheel and source archive URLs, sizes and SHA-256 values match captured PyPI metadata; installed SDK package files were checked against the wheel. All 112 other locked package records and top-level lock metadata remain identical. The lock file hash changes from `1a6b236ba8ef62b230c1e3d7dc055122334905609a2d11cdaf55c34f3e50075b` to `7574a279f791497aa1ea0006a3d17ddcc329214ce7498dc0d6ddf81e396e0f11`.

Only one locked package changes. Nine SDK Python files differ, including cron, streaming, types and encryption behavior outside Auth. Its websockets requirement expands from `<16` to `<17`; locked websockets 15.0.1 is unchanged. Existing environments and unlocked installation are not automatically upgraded. This candidate updates the runtime notice and adds a targeted registration regression to existing Python suites and all three native source-diagnostic commands; budgets and other commands remain unchanged.

## Actual local verification

| Check | Actual result | Scope |
| --- | --- | --- |
| Permanent selected-action regression on old SDK 0.4.2, Python 3.12.10 | 9 failed, 6 passed, no errors/skips, exit 1 | Intended contrary baseline; three resources and three action-selection forms fail, six normal wildcard/direct controls pass |
| Same permanent regression on SDK 0.4.4 | Python 3.12.10: 15 passed; Python 3.10.4: 15 passed, both exit 0 | Owned decorator registration; private registry inspected; no authorization request or server |
| Broader owned SDK registration characterization | Each patched overlay: 73 cases passed | Separate local script cases, not additional pytest test cases |
| Application imports and local graph checkpoint | Each patched overlay: four application modules imported; local StateGraph increment and SQLite in-memory checkpoint save/readback passed | One graph invocation followed by saved-state retrieval; no interrupted-run resume or external model/provider/server request; does not establish production interoperability |
| Lock checks | Python 3.10 and 3.12 selections pass `uv lock --check --offline --no-build` | Resolution consistency; not a fresh full dependency install |
| New test style and whitespace | Ruff check, Ruff format check and Git diff check pass | Targeted source checks |

Each overlay was created in a new owned environment. Only the hash-verified SDK wheel was installed there with no dependency resolution or index access; other dependencies were read through a plain path from an existing environment. Existing environments were not modified. Python 3.10's inherited cryptography, SQLite checkpoint, NumPy, pandas and urllib3 versions differ from the candidate lock. All SDK direct requirements are satisfied. These overlays establish SDK compatibility with those observed environments, not acceptance of the complete frozen release tree. The native CI frozen installs, Python matrix and packaged Rust bridge remain authoritative for their actual tested heads.

## Coverage and contrary evidence

The repository advisory is present even though captured PyPI 0.4.2 metadata has an empty vulnerability array, the GitHub global-advisory endpoint returns 404, and the OSV PyPI package/version query returns an empty object. The OSV CVE alias has a Git-mapped record without a PyPI package range. This is a specific package-mapping/feed gap. The existing pinned pip-audit defaults to PyPI; its audit cannot be treated as complete coverage for this advisory. No scanner exception, vulnerability ignore or failure threshold was added.

The first `uv lock --upgrade-package ... --no-build` attempt failed on an unrelated Windows/Python JSONPath source-distribution selection and left the old lock unchanged. The candidate SDK record was then constructed from verified official artifact metadata and checked offline. This does not claim the failed solver performed a complete fresh install. The first broader SDK probe used an incorrect application module path and failed after registration checks; changing only that harness import to `tradingagents.evaluation.public_source_reports` produced both captured successful runs. Original commands, failures, harnesses and logs remain in the owned local validation directory. The initial source-only proof covers the pin-only snapshot; the adjacent JSON separately binds the final expanded four-file source scope. A first patch attempt expected the wrong notice URL and failed atomically before any edit; the actual existing project URL was preserved in the successful patch.

Raw local evidence is retained in `evidenceloom-validation/dependency-security-next-pass/` beside the worktrees. Machine-record artifact entries identify their files and SHA-256 values. These are engineering observations and agent reviews; external analyst and expert approval counts remain zero. Signed installers, clean-machine installation/upgrade, real provider compatibility, application custom-auth deployment testing and complete dependency/OS-library security assessment remain open. No production credentials, user profiles or real model calls were used for this candidate.
