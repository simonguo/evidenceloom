# Modification notice

Evidence Loom is derived in part from TradingAgents `v0.2.5` at commit
`a5cb7cbd61d217fb0bc43f017392a861257afe6a`. The copy in this repository has
been modified by Evidence Loom contributors.

The modifications include, but are not limited to:

- provider integrations, model capability handling, structured output, and
  provider-specific reasoning controls;
- market-data validation, symbol normalization, fallback behavior, and
  additional data sources;
- checkpointing, memory logging, concurrency, error handling, and test
  coverage in the embedded Python research core;
- an independently branded Next.js and Tauri desktop application, local task
  persistence, operating-system credential storage, and a packaged sidecar;
- privacy controls, secret redaction and migration, build/release automation,
  documentation, and project governance.

The `tradingagents` Python namespace and `tradingagents` CLI entry point are
retained only for source and upstream compatibility. They are not claims of
affiliation or trademark rights, and Evidence Loom does not publish a PyPI
package under that name.

See [UPSTREAM.md](UPSTREAM.md) for the exact provenance and synchronization
process. Apache-2.0 license and attribution materials are in [LICENSE](LICENSE)
and [NOTICE](NOTICE).
