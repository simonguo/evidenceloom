# Upstream provenance

Evidence Loom contains a modified copy of [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents).

- Original upstream base: `v0.2.5`
- Original base commit: `a5cb7cbd61d217fb0bc43f017392a861257afe6a`
- Selective synchronization reference: `v0.5.2`
- Synchronization reference commit: `8b22d43d01d9ddda5d686d093d5385884622f3de`
- Upstream license: Apache-2.0
- Local compatibility namespace: `tradingagents`

Evidence Loom adds the desktop application, local task persistence, packaged runner, provider integrations, user-interface workflows, and supporting tests. It uses an independent name and original visual identity because Apache-2.0 does not grant trademark rights.

The v0.5.2 synchronization applies selected fixes for historical data boundaries, vendor routing, typed ratings, memory settlement, checkpoint lifecycle, parallel analyst execution, provider limits, and run provenance. It adapts them to Evidence Loom's CLI and desktop runner. This is not a full upgrade to upstream v0.5.2: the embedded package version remains `0.2.5`, Python 3.10 support and the existing provider interfaces remain, and A-share data sources are retained. SEC EDGAR, FRED, Polymarket, portfolio input, and backtesting are outside this synchronization.

See [docs/UPSTREAM_CHANGELOG.md](docs/UPSTREAM_CHANGELOG.md) for source commits, local adaptations, and limitations. The reference tag is annotated and its commit and Apache-2.0 license were checked before applying these changes.

## Updating from upstream

1. Fetch the upstream tag and verify its annotated commit and license.
2. Compare upstream changes against the pinned commit without merging unrelated branding, assets, workflows, or issue references.
3. Apply the smallest compatible patch to the embedded Python core and preserve prominent modification notices where required.
4. Run Python, frontend, Rust, secret-migration, license, and packaging checks.
5. Update this file, `docs/UPSTREAM_CHANGELOG.md`, `NOTICE`, and generated third-party notices in the same pull request.

Do not publish the embedded package to PyPI under the upstream `tradingagents` project name.
