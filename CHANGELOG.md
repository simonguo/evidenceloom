# Changelog

All notable Evidence Loom changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Selectively synchronized TradingAgents v0.5.2 reliability fixes while retaining the v0.2.5 package version, Python 3.10 compatibility, and A-share integrations.
- Run selected analysts in private parallel subgraphs with a shared concurrency limit, per-agent progress, and a report join before research.
- Record safe runtime settings with report versions and exports; expose token, retry, tool-round, concurrency, and holding-period controls.
- Restrict fallback to configured data vendors, distinguish provider outages from missing data, and remove unused direct Python dependencies.
- Default Python tests to offline execution; external-service tests are explicitly opt-in.
- Rebranded the desktop application as Evidence Loom.
- Moved desktop API keys to the operating-system credential store.
- Added open-source governance, security, privacy, CI, and signed-release infrastructure.

### Fixed

- Carry the Portfolio Manager's typed rating into desktop results and memory. Unparseable decisions now display REVIEW instead of silently becoming Hold.
- Bind tool symbols and dates to the current run, clip historical market/news/social inputs, and withhold historical fundamentals whose publication date cannot be established.
- Register market verification tools, bound analyst tool rounds, and stream under each run's own vendor configuration.
- Resume compatible CLI and desktop checkpoints without duplicate work, close SQLite savers after failures, and start fresh when graph settings change.
- Serialize memory writes, prevent duplicate decisions, exclude lessons learned after the analysis date, and settle only complete holding windows with matching benchmark endpoints.
- Ground Trader decisions in the market report, preserve valid decisions when optional prices are unreadable, and avoid invented debate opponents or forced verdicts under ambiguity.
- Apply explicit retry budgets once and avoid native OpenAI endpoint assumptions for custom compatible providers.

## [0.1.0-beta.5] - 2026-07-23

- Made DMG notarization resilient to transient Apple service timeouts by submitting once and polling the submission status with bounded retries.

## [0.1.0-beta.4] - 2026-07-23

- Staged signed and notarized macOS DMGs directly through a draft GitHub Release, removing the Actions Artifact storage dependency.
- Added a Windows-only manual packaging path that publishes the unsigned test installer to a separate draft release.

## [0.1.0-beta.3] - 2026-07-23

- Limited the unsigned Windows test artifact to the NSIS installer so prerelease versions can be packaged.
- Added explicit notarization and stapling for the generated macOS disk images.

## [0.1.0-beta.2] - 2026-07-23

- Added an unsigned Windows x64 test installer artifact to the desktop release workflow.
- Kept unsigned Windows installers out of the published GitHub Release.
- Fixed Tauri development startup by preparing the architecture-specific sidecar placeholder.

## [0.1.0-beta.1] - 2026-07-22

First public beta planned for macOS Apple Silicon, macOS Intel, and Windows x64.

The embedded TradingAgents core is based on upstream `v0.2.5`; see [UPSTREAM.md](UPSTREAM.md) and [the upstream changelog](docs/UPSTREAM_CHANGELOG.md).
