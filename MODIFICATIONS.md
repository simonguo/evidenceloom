# Modification notice

Evidence Loom is derived in part from TradingAgents `v0.2.5` at commit
`a5cb7cbd61d217fb0bc43f017392a861257afe6a`. The copy in this repository has
been modified by Evidence Loom contributors.

Selected reliability and execution changes are also adapted from upstream
`v0.5.2`, commit `8b22d43d01d9ddda5d686d093d5385884622f3de`. They include
historical data boundaries, authoritative ratings, safe memory settlement,
checkpoint resume, private parallel analysts, and run provenance. This is a
selective synchronization, not a complete upgrade of the upstream package.

The modifications include, but are not limited to:

- provider integrations, model capability handling, structured output, and
  provider-specific reasoning controls;
- observable output-format validation, bounded provider retries, frozen report
  review, and actual-source attribution through A-share fallback;
- content-addressed research evidence, actual source-attempt traces, frozen
  inputs through interruption, citation resolution, and self-contained exports;
- market-data validation, symbol normalization, fallback behavior, and
  additional data sources;
- checkpointing, memory logging, concurrency, error handling, and test
  coverage in the embedded Python research core;
- an independently branded Next.js and Tauri desktop application, local task
  persistence, operating-system credential storage, and a packaged sidecar;
- separate bootstrap/research-import diagnostics, bounded readiness probes,
  and interpreter/output architecture guards for sidecar packaging;
- privacy controls, secret redaction and migration, build/release automation,
  documentation, and project governance.

The `tradingagents` Python namespace and `tradingagents` CLI entry point are
retained only for source and upstream compatibility. They are not claims of
affiliation or trademark rights, and Evidence Loom does not publish a PyPI
package under that name.

See [UPSTREAM.md](UPSTREAM.md) for the exact provenance and synchronization
process. Apache-2.0 license and attribution materials are in [LICENSE](LICENSE)
and [NOTICE](NOTICE).
