# Changelog

All notable Evidence Loom changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- Rebranded the desktop application as Evidence Loom.
- Moved desktop API keys to the operating-system credential store.
- Added open-source governance, security, privacy, CI, and signed-release infrastructure.
- Added a Windows-only manual packaging path that publishes the unsigned test installer to a draft release.

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
