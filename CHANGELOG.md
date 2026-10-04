# Changelog

All notable Evidence Loom changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

- Freeze deterministic research input policies and save replayable readiness checks with every report version. Missing, invalid or unverified required inputs produce REVIEW and skip the final rating model call.
- Preserve provider timestamps/timezones, reject impossible OHLCV and conflicting daily rows, exclude provisional rows from calculations, enforce indicator warm-up and load history relative to the requested research date.

### Changed

- Freeze per-run research memory inputs, decision identity, actual recording time, effective benchmark, holding-period policy, and evaluator source hash in a separate MemoryBundle v1.
- Persist full-precision outcome facts before model reflection; retain immutable report inputs and attach later dated evaluations separately in browser storage, SQLite schema v7, and complete JSON/HTML/Markdown reports.
- Read saved evaluations through a bounded, read-only inventory command without initializing providers or models.
- Run bootstrap and source-inventory diagnostics without importing research dependencies; retain a separate research-import probe for desktop health and release checks.
- Validate the active Python interpreter and generated/reused sidecar OS and CPU against the requested target before packaging.
- Capture and atomically persist exact sanitized model inputs, full-precision normalized source data, actual provider attempts, observed dates, frozen run-context hashes, and citation IDs in a versioned evidence bundle.
- Preserve evidence through checkpoint recovery, task/history reload, SQLite schema v6, and self-contained HTML/Markdown/JSON exports; expose unknown historical provenance and unresolved references in the research workspace.
- Serialize evidence writes across processes, reject corrupted or contradictory snapshots, and surface task persistence failures.
- Run CI and security checks for stacked pull requests targeting quality branches.

- Record output-format validation or text fallback with each decision agent, task, frozen report version, and HTML/Markdown export; show unknown quality for legacy reports.
- Allow selected historical report versions to be reviewed with their own frozen content, configuration, and quality.
- Make the real-provider format smoke use fictional inputs, explicit resource limits, sanitized JSON results, and schema-based pass criteria.

- Selectively synchronized TradingAgents v0.5.2 reliability fixes while retaining the v0.2.5 package version, Python 3.10 compatibility, and A-share integrations.
- Run selected analysts in private parallel subgraphs with a shared concurrency limit, per-agent progress, and a report join before research.
- Record safe runtime settings with report versions and exports; expose token, retry, tool-round, concurrency, and holding-period controls.
- Restrict fallback to configured data vendors, distinguish provider outages from missing data, and remove unused direct Python dependencies.
- Default Python tests to offline execution; external-service tests are explicitly opt-in.
- Rebranded the desktop application as Evidence Loom.
- Moved desktop API keys to the operating-system credential store.
- Added open-source governance, security, privacy, CI, and signed-release infrastructure.

### Fixed

- Patch three locked Python runtime packages and compatible frontend dependencies; audit frozen Python requirements and the complete npm tree on pull requests, main pushes and the weekly schedule. Record the unpatched braces chain and Next's separate vendored Browserslist limitation.
- Bind browser development and local production npm scripts to IPv4 loopback by default.
- Exclude date-only legacy Markdown from authoritative settlement and historical context selection; model-written delimiters cannot create decisions or evaluation facts.
- Prevent current settings, changed benchmark aliases, reflection failures, or completion retries from reinterpreting a saved decision; historical date-only decisions remain explicitly not evaluable.
- Require successful exit and strict stdout JSONL from sidecar checks; reject legacy bootstrap-only responses and clean up timed-out diagnostic processes.
- Replay uncheckpointed captured inputs after interruption without refetching, while retaining new IDs for genuinely repeated calls.
- Preserve code and prompt hashes in packaged runners by retaining only the application's own Python source files; reject missing-source inventories rather than hashing an empty directory.
- Withhold future-dated and explicitly withheld source values, remove source response/endpoint details from diagnostics, and capture effective Yahoo searches and Alpha topics accurately.

- Reuse successful prose responses instead of generating a second answer; propagate exhausted provider failures and reject refused, truncated, or empty answers.
- Consolidate OpenAI-compatible retries into the SDK budget, removing the implicit outer retry loop. Use `TRADINGAGENTS_LLM_MAX_RETRIES` instead of the legacy `TRADINGAGENTS_LLM_RETRY_ATTEMPTS` and `TRADINGAGENTS_LLM_RETRY_BASE_DELAY` variables.
- Identify Tencent and Eastmoney as the actual successful A-share price source, including provider fallback and sliced price windows.

- Carry the Portfolio Manager's typed rating into desktop results and memory. Unparseable decisions now display REVIEW instead of silently becoming Hold.
- Bind tool symbols and dates to the current run, clip historical market/news/social inputs, and withhold historical fundamentals whose publication date cannot be established.
- Register market verification tools, bound analyst tool rounds, and stream under each run's own vendor configuration.
- Resume compatible CLI and desktop checkpoints without duplicate work, close SQLite savers after failures, and start fresh when graph settings change.
- Serialize memory writes, prevent duplicate decisions, exclude lessons learned after the analysis date, and settle only complete holding windows with matching benchmark endpoints.
- Reject invalid holding periods before analysis and exclude live daily candles from settlement across local/UTC midnight.
- Update Next.js, sharp, DiceBear, and nanoid to patched versions; classify the Tailwind typography plugin as a build-time dependency for production auditing.
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
