# Research evidence bundle contract

Implementation contract for the evidence pipeline on `quality/research-evidence-bundles`. The product quality objective and visual acceptance remain open. Source/citation resolution does not establish factual support or research accuracy.

## Wire format v1

Python state/logs use `evidence_bundle`; desktop events, tasks and report versions use `evidenceBundle`. The bundle's internal keys remain snake_case in every language.

```
{
  schema_version: 1,
  run_id: UUID,
  instrument: string,
  analysis_date: YYYY-MM-DD,
  research_as_of: UTC ISO timestamp,
  as_of_policy: "analysis_date_end_utc",
  market_timezone: null | string,
  created_at: UTC ISO timestamp,
  manifest: safe run settings,
  manifest_sha256: hex64,
  records: [{
    id: "ev-" + UUID hex,
    analyst: market | social | news | fundamentals | identity,
    tool: known tool/source name,
    instrument: exact run instrument,
    parameters: allowed instrument/date/indicator/window/limit parameters,
    status: available | partial | empty | unavailable | withheld,
    fetched_at: UTC ISO timestamp,
    output_sha256: hex64,
    sources: [{
      provider: known public provider,
      url: null | public URL without credentials/query/fragment,
      observed_window: null | { start: YYYY-MM-DD, end: YYYY-MM-DD },
      publication_dates: null | [UTC ISO timestamps],
      historical_availability: "unknown" | "within_as_of" | "withheld",
      units: null | safe string,
      adjustments: null | safe string,
      transformations: [safe descriptive strings],
      data_sha256: null | hex64
    }],
    attempts: [{provider: known public provider, status: available | empty | unavailable | withheld | not_configured, elapsed_ms: integer}]
  }],
  artifacts: { hex64: { kind: "tool_text" | "normalized_data", payload: string } },
  citation_audit: { report_key: { referenced_ids: [evidenceID], unresolved_ids: [evidenceID], status: "resolved" | "unresolved" | "none" } },
  bundle_sha256: hex64
}
```

Hashes are SHA-256 over UTF-8 canonical JSON (`sort_keys=True`, compact separators, `ensure_ascii=False`, `allow_nan=False`). An artifact hashes its entire `{kind,payload}` object. A bundle hashes its complete object excluding `bundle_sha256`. The envelope contains only safe integers (absolute value at most 2^53−1), booleans, strings, lists, objects and null; fractional manifest settings are decimal strings. A `normalized_data` payload is canonical JSON text, retaining the original numerical precision inside that string. This avoids Python, JavaScript and Rust formatting the same floating number differently when checking envelope hashes. Normalized data may be parsed for inspection, but exports retain the exact payload text. Missing/unknown fields cannot be treated as verified. Daily UTC cutoff (`analysis_dateT23:59:59.999999Z`) is the explicit current compatibility policy; precise market-time, intraday and adjustment-vintage acceptance remains open.

Each model-visible captured source is prefixed with `[E:ev-UUIDhex]`. The `tool_text` artifact stores that exact sanitized input, including the prefix. Full-precision normalized data is a separate artifact attached before rounded prose is produced. An evidence record identifies the effective, enforced request parameters; metadata must never infer an actual provider from the configured adapter when fallback differs. Unobserved dates and transformations stay unknown.

Artifacts are normalized inputs for local research. Raw HTTP envelopes, headers, credentials, private endpoints, exception bodies and absolute paths are excluded. Redistribution rights of third-party content are not established by capture. Exports identify that limit. Persistence failures stop the input from reaching a model. Each call has its own evidence ID and attempts; matching payloads share content-addressed artifacts.

The bundle is bounded to 64 MiB, 4096 records and 16384 artifacts; individual text payloads are limited to 8 MB. Oversize inputs fail before use rather than being silently truncated. Unknown metadata remains null or `unknown`. `partial` identifies usable evidence with retrieval/coverage limitations; successful fallback attempts remain inspectable. Effective provider searches/topics are saved with their observed source data, rather than attributing a configured Yahoo query to Alpha's unrelated topic request.

Daily source dates do not establish an archived content revision. Current company identity metadata and cached metadata retain an explicit unknown historical vintage. Explicitly withheld sources cannot return live values through their tool text. Failure records contain a fixed unavailable notice, without claiming that source values were delivered successfully.

## Python API owned by root

`tradingagents.evidence` exports:

- `EvidenceLedger(instrument, analysis_date, manifest, storage_dir, *, market_timezone=None, secrets=())`; `ledger.bind()` context manager; `ledger.bundle(analyst=None, reports=None)` returns a validated, independently copied bundle, optionally projected to one analyst's records/artifacts.
- `EvidenceLedger.restore(bundle, storage_dir, *, secrets=())`; validate manifest, artifact and bundle hashes before reuse; preserve run ID and dates. Each run is saved atomically to `storage_dir/<run_id>/bundle.json`, with restrictive POSIX permissions and a stable `.lock` file. POSIX/Windows process locks serialize strict durable unions, so a stale run owner cannot overwrite another owner's captures. Restore strictly joins the supplied checkpoint with the latest validated same-run saved bundle. Captures present only on disk replay once, in sequence, by analyst/tool/effective parameters; already checkpointed captures do not replay as new calls. This preserves partial-node inputs without conflating genuinely repeated calls.
- `current_ledger()`; `analyst_evidence(name)` context manager to identify private analyst captures.
- `capture_evidence(tool, parameters, operation) -> str`: with no ledger, returns `operation()` unchanged. With a ledger, capture source observations and attempts, persist before returning the prefixed sanitized text. Exceptions propagate safely after recording an unavailable result where appropriate.
- `observe_source(provider, *, url=None, normalized_data=None, observed_window=None, publication_dates=None, historical_availability="unknown", units=None, adjustments=None, transformations=())`: attaches trustworthy provider metadata to the active call; no-op outside capture. Providers allowed: yfinance, eastmoney, tencent, alpha_vantage, akshare, stocktwits, reddit, local_calculation, unknown.
- `observe_attempt(provider, status, elapsed_ms=0)`: fixed categories, no exception text or private endpoint.
- `merge_evidence_bundles(previous, update) -> dict`: strict same-run union, no silently overwritten conflicting records/artifacts; empty input is neutral.
- `validate_evidence_bundle(value) -> dict`: verify shape, hashes, references and bounds; malformed values raise a safe `ValueError`.
- `audit_citations(bundle, reports) -> dict`: returns the bundle with resolution audit for `[E:...]` references; missing references remain visible. Malformed, empty or unclosed tags contribute the unresolved `invalid-citation` sentinel, without storing their unsafe contents. Existing evidence IDs do not prove the cited passage is factually supported.

Graph entry points own one bound ledger per run. Private graphs identify their analyst and return only their own projected evidence. Checkpoint restore reconstructs the exact ledger and frozen initial context, avoiding repeat source retrieval. The final state and report logs contain the complete bundle and audit. Root owns desktop bridge serialization; runtime agent owns graph and prompt integration.

## Acceptance evidence

Required cases include actual fallback attribution, full-precision values retained before rendering, unknown source dates, no future-dated observations silently considered valid, two concurrent runs/analysts, repeated calls, atomic persistence failure, corruption detection, interrupted/resumed execution without changed evidence, exact source artifacts after task/version reload, matching hashes in self-contained exports, citation resolution and missing IDs, and secret/private-URL filtering. Browser and rendered export inspection are required alongside automated checks.
