# ResearchReadiness v1 contract (implementation candidate)

Research input checks are separate from model output format, citation resolution and the final directional rating. Passing these checks establishes recorded input conditions only; it does not establish factual claim support, numerical accuracy of model prose or predictive value. A missing contract in a legacy report is unknown.

The deterministic gate reads saved EvidenceBundle records before the Portfolio Manager. It performs no model call, provider request, repair fetch or extra tool round. Reports with insufficient or unverified required inputs receive `REVIEW` with explicit reasons, rather than treating a lack of evidence as a balanced `Hold`. Unselected analyst domains remain `not_selected`; their sources are not acquired silently.

## Envelope

The exact fields are:

```text
schema_version: 1
run_id: canonical lower-case UUID
instrument: exact EvidenceBundle instrument
analysis_date: exact EvidenceBundle analysis_date
policy: ResearchReadinessPolicy
evidence_inputs: EvidenceInput[]
checks: InputCheck[]
status: ready | insufficient_evidence | review_required
recommendation_allowed: boolean
assessment_sha256: SHA-256 of the canonical envelope excluding this field
```

Hashing uses the existing sorted compact UTF-8 canonical JSON envelope. Numeric market facts remain exact opaque canonical-JSON strings in Evidence artifacts, rather than being reserialized into this envelope.

`ResearchReadinessPolicy` has exact fields:

```text
schema_version: 1
policy_version: research-readiness-v1
selected_analysts: unique ordered market | social | news | fundamentals keys
required_checks: unique ordered check keys derived below
research_started_at: actual UTC Z timestamp, microsecond precision
research_as_of: analysis-date end UTC, microsecond precision
research_calendar_date: frozen host-local start date
host_utc_offset: ASCII ±HH:MM
temporal_mode: same_host_date | historical_date_only | future_date
max_tool_rounds: integer 1..10000
max_complete_row_age_days: 3
required_indicators: the ordered default snapshot indicator names
policy_sha256: canonical policy hash excluding this field
```

The policy freezes at research start and survives checkpoint recovery. Its hash is retained as `research_readiness_policy_sha256` in the Evidence manifest. Selected analysts and tool-round limits must equal that manifest. Date classification uses the host calendar explicitly; it does not invent a market timezone or historical publication vintage.

The offset is bounded to ±14:00, with minutes 00–59 and no minutes at 14 hours; `-00:00` is rejected. Applying it to the UTC start must reproduce the frozen host date. Graph state additionally binds start/date/offset to the separately frozen Memory evaluation plan.

`EvidenceInput` has exact fields `record_id`, `output_sha256`, and `data_sha256s`. Inputs contain every saved evidence record, sorted by record ID. Data references are the unique sorted non-null normalized source hashes for that record. All references must resolve to the same EvidenceBundle; the pre-manager assessment does not reference the complete bundle hash because the later citation audit changes it.

`InputCheck` has exact fields `key`, `required`, `status`, `reason_codes`, `evidence_ids`, and `artifact_sha256s`. Reference arrays are unique and sorted. Required checks are, in order, `temporal_availability`, `market_verification`, `indicator_warmup`, then `selected_sources.<analyst>` for each selected analyst in policy order. Advisory checks are `price_vintage` and `exchange_calendar_coverage`. These advisory unknowns remain visible and never imply verified historical availability or exchange-calendar coverage.

Check status is `passed`, `missing`, `unavailable`, `partial`, `invalid`, `not_selected`, or `unknown`. Fixed reason codes are:

```text
historical_availability_unknown
future_analysis_date
market_not_selected
missing_required_verification
provider_unavailable
empty_observations
partial_observations
unknown_source_provenance
verification_quality_unknown
invalid_ohlcv
conflicting_daily_rows
provisional_daily_rows
unknown_bar_completion
insufficient_indicator_history
unsupported_indicator
indicator_calculation_failed
missing_selected_source
unknown_price_basis
unknown_price_vintage
unknown_exchange_calendar
stale_or_unknown_session_coverage
price_basis_conflict
source_withheld
```

`ready` requires every required check to be `passed`. `insufficient_evidence` applies when a required check is missing, unavailable or invalid. Other unmet required checks produce `review_required`. `recommendation_allowed` is true exactly for `ready`. A withheld recommendation must have effective rating `REVIEW` in the saved task, frozen version, final decision text and Memory decision artifact. This is an input gate, not a portfolio confidence score.

The market and indicator checks consume the recognized `market_verification_quality` normalized artifact, its exact source hashes and saved record binding. A successful tool invocation or an `available` record alone is insufficient. Scientific row integrity, conservatively completed provider daily labels and indicator warm-up are checked explicitly. Source timezone, price basis, publication/revision vintage and calendar coverage are reported at the level actually observed. Historical requests with unknown historical availability require review.

The frozen indicator list is `close_10_ema`, `close_50_sma`, `close_200_sma`, `rsi`, `boll`, `boll_ub`, `boll_lb`, `macd`, `macds`, `macdh`, `atr`, in that order. A three-calendar-day latest-complete-row age limit is a conservative input policy, not an exchange-session calendar. A longer gap requires review with `stale_or_unknown_session_coverage`; a missing date cannot be labeled a holiday without calendar evidence.

## Deterministic check rules

Checks appear in the exact order of `policy.required_checks`, followed by the two advisory checks. Required flags must match that list exactly; no duplicate, omitted or extra checks are valid. Evidence inputs reference every final saved record. No new source capture occurs after the pre-manager gate; only the citation audit changes the complete Evidence envelope. All ID/hash references bind to those records and artifacts.

When several findings apply to a check, status precedence is `invalid`, `unavailable`, `missing`, `partial`, `unknown`, `not_selected`, then `passed`. Reasons are the union of all findings. A receipt maps unavailable to `provider_unavailable`, withheld to `source_withheld`, empty to missing/`empty_observations`, and partial to `partial_observations`. The indicator check inherits all market findings in addition to its own. The executable reference is [readiness.py](../tradingagents/research/readiness.py).

Typed quality belongs to a `local_calculation` normalized source; its named provider must also have normalized data in the same receipt and be one of `yfinance`, `eastmoney`, `tencent`, `alpha_vantage` or `akshare`. Malformed/missing/multiple quality artifacts and out-of-window observation times become unknown/`verification_quality_unknown`, never a passing transport receipt. Observation time must fall between research start and cutoff and be no later than receipt retrieval. Counts are integers bounded to 1,000,000. Exact required indicator rows are 10, 50, 200, 15, 20, 20, 20, 26, 34, 34 and 15 in policy order (optional `vwma` requires 14); these are minimum inputs, not a convergence guarantee. Every available selected-domain receipt must itself have actual normalized provider input, even when another receipt has good provenance.

The [saved-row proof](../tradingagents/research/market_inputs.py) independently checks each enriched, non-withheld normalized table for the claimed provider. It requires the observed OHLCV and original source-clock columns, validates finite coherent values, reconstructs duplicate/valid/completed/provisional/unknown row counts and latest labels, and binds observed and requested windows, timezone origin, and optional saved history/price-basis metadata. Intermediate adapter tables without those clock columns cannot certify completion. An empty table or a contradictory local summary cannot substitute for the saved observations. Every relevant enriched table must agree.

This proof admits exact case-sensitive observed IANA names in its explicit v1 registry, and canonical `UTC±HH:MM` fixed offsets within ±14:00 excluding negative zero. An unfamiliar name requires review rather than inference from the ticker. The original source-local day and UTC day must both have elapsed; an intraday timestamp, including nonzero nanoseconds, remains provisional. Supported raw OHLCV proof numbers have absolute value at most `2**53-1`, which prevents cross-language numeric rounding from certifying impossible or indistinguishable huge integer prices. This conservative proof bound does not alter original artifact strings or the separate Memory evaluation contract.

`temporal_availability` is passed only for `same_host_date` with every captured record fetched no later than the frozen research cutoff. Historical date-only inputs are unknown with `historical_availability_unknown`; future analysis dates are unknown with `future_analysis_date`. Its reference arrays cover all records and normalized artifacts.

Market receipts are `market` analyst records for `get_verified_market_snapshot`, with exact instrument and requested `curr_date` matching the frozen policy. If market was not selected, both market and indicator checks are `not_selected` with `market_not_selected`. With no matching receipt, both are `missing` with `missing_required_verification`. Matching records and all their normalized hashes form the reference arrays for these two checks.

Each recognized quality artifact must have the exact schema documented by the verifier, matching symbol/date, recognized policy/completion policy, bounded counts, valid timestamps, a real observed provider, and resolvable outer source hash. An old receipt without this typed artifact is unknown with `verification_quality_unknown`. Invalid/nonfinite/impossible OHLC gives `invalid_ohlcv`; conflicting duplicate labels give `conflicting_daily_rows`; empty rows give `empty_observations`. Unknown completion or timezone requires review with `unknown_bar_completion`. Provisional rows may be excluded while a valid completed window remains; if no usable completed rows remain, use `provisional_daily_rows`. Unknown price basis requires review with `unknown_price_basis`. Different observed price bases across matching receipts require review with `price_basis_conflict`, without asserting that differently adjusted values contradict each other.

Every matching receipt must satisfy the market conditions. Available typed quality alone cannot override a failed, empty, partial or withheld matching record. With complete valid rows, the latest usable label must be no later than the analysis date and within the frozen age limit. Its source-observation timestamp must be between research start and the research cutoff. Passing row checks establish usable conservatively completed provider rows; calendar and revision vintage remain advisory unknowns.

`indicator_warmup` requires each frozen indicator in every recognized receipt to be `available`, have a finite saved value, positive required rows and at least that many usable rows. An insufficient warm-up is partial with `insufficient_indicator_history`; unsupported or failed calculations are partial with `unsupported_indicator` or `indicator_calculation_failed`; missing or unusable inputs remain unknown with `verification_quality_unknown`. It cannot pass if the market check is not passed.

`selected_sources.<analyst>` references every record and source hash belonging to that selected analyst. With no records it is missing with `missing_selected_source`. It passes only if at least one available record has an actual provider other than `unknown`/`local_calculation` and saved normalized data, and every record is available. Empty, partial, failed, withheld or unknown-provenance records remain explicit unmet checks; an available model-written report cannot substitute for source invocation. This establishes observed provider input only, not exhaustive topic coverage or factual support.

Advisory `price_vintage` and `exchange_calendar_coverage` are unknown with their corresponding fixed reason codes, bound to the matching market receipts. Checks and reason arrays are derived deterministically, with unique lexicographically sorted reasons. A ready contract can still end with `REVIEW` if the model provides no interpretable final rating. A withheld contract requires the first authoritative rating in the final text, the task/version rating and the Memory decision rating all to be `REVIEW`.

Selected-domain checks distinguish recorded provider inputs, observed empty results, failed providers, partial observations and no source invocation. They do not infer that a feed covers every relevant news item or that a retrieved filing was published before a historical cutoff.

## Persistence and display

Graph state uses `research_readiness_policy` and `research_readiness`. Streaming task/report fields use `researchReadiness` and optional `readinessValidation` with the existing fixed invalid-reason vocabulary. Current task and each report version retain their own contract; selection and export cannot borrow a different version's checks. SQLite and browser storage validate the exact contract, hash, references, manifest policy and effective rating. One run UUID has one assessment hash across all tasks and frozen versions; conflicting individually valid copies invalidate every attached browser owner, while identical copies and legacy absence remain allowed.

JSON, HTML and Markdown exports retain the complete envelope and underlying Evidence payloads. Missing legacy attachments remain unknown. Invalid attachments are visible and block export. The UI distinguishes run completion, schema formatting, saved input checks and factual research assessment. The [local validation record](validation/2026-10-04-research-readiness.md) records fictional scientific fixtures, gate/checkpoint behavior, storage checks, actual browser/download cases and an isolated packaged program. Native platform execution is tracked by the pull request's required checks; broader research and release acceptance remain open.
