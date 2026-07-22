# Upstream provenance

Evidence Loom contains a modified copy of [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents).

- Upstream tag: `v0.2.5`
- Upstream commit: `a5cb7cbd61d217fb0bc43f017392a861257afe6a`
- Upstream license: Apache-2.0
- Local compatibility namespace: `tradingagents`

Evidence Loom adds the desktop application, local task persistence, packaged runner, provider integrations, user-interface workflows, and supporting tests. It uses an independent name and original visual identity because Apache-2.0 does not grant trademark rights.

## Updating from upstream

1. Fetch the upstream tag and verify its annotated commit and license.
2. Compare upstream changes against the pinned commit without merging unrelated branding, assets, workflows, or issue references.
3. Apply the smallest compatible patch to the embedded Python core and preserve prominent modification notices where required.
4. Run Python, frontend, Rust, secret-migration, license, and packaging checks.
5. Update this file, `docs/UPSTREAM_CHANGELOG.md`, `NOTICE`, and generated third-party notices in the same pull request.

Do not publish the embedded package to PyPI under the upstream `tradingagents` project name.
