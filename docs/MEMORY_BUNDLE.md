# MemoryBundle v1

This is the authoritative cross-language contract for immutable research memory.
EvidenceBundle v1 is unchanged. JSON records, never model-written Markdown tags or
delimiters, are settlement authority. Existing Markdown is retained read-only and
excluded from new authoritative records and historical memory inputs.

## Hashes and bounds

Canonical JSON uses sorted object keys, compact separators, UTF-8, literal Unicode,
and no non-finite numbers. Envelope values are strings, safe integers
(`abs(value) <= 2^53-1`), booleans, null, arrays, and objects; no floats. Every
component hashes its canonical object excluding only its own named SHA field.
Artifacts are `{kind: "text" | "canonical_json", payload: string, sha256: string}`;
their SHA excludes only `sha256`. Numeric price facts retain their received
precision inside the canonical JSON **payload string**, never rounded prose.
SHA references identify artifact envelopes, not the raw payload bytes.
Objects have exactly the documented keys; unknown keys, duplicate JSON keys,
unsafe integers, invalid UTF-8, invalid references, and hashes fail validation.
Recorded text is the exact **sanitized** model-visible input: callers sanitize
configured/environment secrets before hashing. Validators reject credential-like
strings, private endpoints, URL credentials/queries/fragments and local paths
that the shared evidence sanitizer would alter. Recursive metadata (including
inside JSON artifact payloads) rejects `api_key`, `apikey`, `access_token`,
`authorization`, `password`, `secret`, `headers`, `cookies`, `raw_response`,
`backend_url`, `__proto__`, `constructor`, and `prototype` keys, case-insensitively.
Model-written HTML, `ENTRY_END`, and `REFLECTION` remain legal untrusted text;
they cannot create authoritative JSON records. Canonical JSON payload strings
are hashed verbatim and parsed safely without numerical re-serialization.
JSON artifact safety checks parsed leaf strings/keys, not escaped JSON syntax;
for example a real newline following `Decision:` is legal, while an actual
Windows private path, credential, or private endpoint is rejected.
Maximum serialized record/bundle is 64 MiB; each text payload is at most 8 MiB.
UTC timestamps use ISO 8601 `Z` with up to six fractional digits. Dates are ISO
`YYYY-MM-DD`; UUIDs are canonical lowercase hyphenated UUID strings.

## DecisionSnapshot

```
{schema_version:1, run_id, decision, contract, outcome:null|Outcome,
 reflection:null|Reflection, artifacts:{artifact_sha:Artifact}, snapshot_sha256}
```

`decision` has exactly:

```
{schema_version:1, decision_id, run_id, instrument, asset_type, analysis_date,
 research_started_at, research_as_of, recorded_at, analysis_calendar_date,
 host_utc_offset, rating, decision_text_sha256, contract_sha256,
 evidence_bundle_sha256, decision_sha256}
```

`decision_id == run_id == EvidenceBundle.run_id`. Separate runs with the same
ticker/date remain separate. `research_as_of` equals the analysis date's end in
UTC (`T23:59:59.999999Z`). `recorded_at` is actual successful research completion
time, not the requested analysis date or a closing price date. It is no earlier
than `research_started_at`. `analysis_calendar_date` is the **host-local calendar
date at research start**, derived using frozen `host_utc_offset` (e.g. `+08:00`);
this host calendar policy makes no claim about market timezone. Rating is exactly
`Buy`, `Overweight`, `Hold`, `Underweight`, `Sell`, or `REVIEW`.

The finalized `contract` has exactly:

```
{schema_version:1, analysis_date, research_calendar_date, host_utc_offset,
 resolved_benchmark, holding_period_days, holding_period_unit,
 evaluation_mode, not_evaluable_reason, policy_version, evaluator_version,
 evaluator_code_sha256, entry_policy, exit_policy, alignment_policy,
 session_policy, completion_policy, price_basis, return_policy,
 effective_history_parameters, decision_text_sha256, contract_sha256}
```

`holding_period_days` is a positive integer (maximum 10000); despite the legacy
configuration name, its unit is `common_complete_provider_daily_rows`.
Freeze an evaluation plan at research start and retain it in checkpoints; bind
the decision text artifact SHA at completion to produce this contract. Never
regenerate the plan from current settings on resume or settlement.

Exact v1 policies:

| Key | Value |
|---|---|
| policy_version | common-daily-close-v1 |
| entry_policy | first_common_complete_date_after_recorded_source_and_utc_dates |
| exit_policy | holding_count_common_row_transitions |
| alignment_policy | identical_session_date_no_fill |
| session_policy | provider_daily_rows_timezone_required |
| completion_policy | date_elapsed_in_source_timezone_and_utc |
| price_basis | provider_adjusted_close |
| return_policy | simple_return_difference_no_fx |

`effective_history_parameters` is exactly `{interval:"1d",auto_adjust:false,
back_adjust:false,actions:true,repair:false,rounding:false,keepna:true,prepost:false}`.
Prospective mode is `prospective_reference` with null reason only when
`analysis_date == research_calendar_date`. An older requested date is
`not_evaluable` with `historical_decision_availability_unknown`. Future dates fail
validation. Calendar/offset fields agree with the decision. This measures
close-to-close reference performance, not executable fills, a trading strategy's
profit, risk-adjusted alpha, or an independently proven complete exchange calendar.

`Outcome` has exactly:

```
{schema_version:1, contract_sha256, observed_at, status, reason,
 facts_sha256, calculation_sha256, outcome_sha256}
```

Available outcomes have status `available`, null reason, and two canonical_json
artifact references. Facts include original row labels/timezones, requests,
full-precision Close/Adj Close/actions, observed times, and coverage/vintage
limitations; calculation contains exact selected endpoints, raw and benchmark
returns and their difference. `observed_at >= recorded_at`. Persist these facts
before any reflection call. Pending/incomplete observations are **not** terminal
outcomes and cannot freeze a decision permanently. `not_evaluable` has a safe
lower_snake_case reason code, null calculation, optional facts artifact, and no
reflection. Historical mode's reason must match its contract.

`Reflection` has exactly:

```
{schema_version:1, outcome_sha256, reflected_at, model_context_sha256,
 prompt_sha256, response_sha256, reflection_sha256}
```

It requires an available outcome, references canonical_json model context and
text prompt/response artifacts, and `reflected_at >= observed_at`. A failed
reflection leaves the outcome durable; retries load the original facts without
provider refetch. Every referenced artifact is present; orphan artifacts fail.
Each non-null outcome/reflection is immutable. Conflicting replacements fail.

## Exact memory input

`ContextSnapshot` has exactly:

```
{schema_version:1, instrument, selected_at, research_cutoff, availability_cutoff,
 selector_version:"recent-reflections-v1", same_ticker_limit, cross_ticker_limit,
 decisions:[full DecisionSnapshots], context_artifact:Artifact,
 raw_text_sha256, context_sha256, input_sha256}
```

`availability_cutoff = min(selected_at,research_cutoff)`. Include only available
outcomes with reflections whose decision `recorded_at`, outcome `observed_at`,
and reflection `reflected_at` all precede or equal this cutoff. An endpoint date
never establishes when a lesson became available. Legacy unknown dates are
excluded. Retain ordered full snapshots, not mutable lookup references. Instrument
comparison maps ASCII `A`–`Z` to `a`–`z`; all other Unicode codepoints compare
exactly. There is no platform-dependent Unicode case folding. The
exact text artifact is the deterministic v1 context renderer's output.
`raw_text_sha256` hashes UTF-8 text bytes; `context_sha256` hashes the canonical
JSON **string**, matching `cli.research_manifest.context_sha256` and the existing
evidence manifest's `memory_input_sha256`. `input_sha256` hashes this entire
context snapshot excluding that own field. Order is same-instrument records
first, then cross-instrument records; each group sorts descending by reflection
time, decision recording time, then canonical run UUID. Context selection limits only prompt
input; it never deletes authoritative decisions. Resume uses the frozen snapshot
and performs no settlement or context reselection.

## Completion and review attachments

```
MemoryBundle = {schema_version:1,run_id,instrument,analysis_date,
 evidence_bundle_sha256,persistence_status:"durable"|"memory_only",
 input_snapshot:ContextSnapshot,decision_snapshot:DecisionSnapshot,bundle_sha256}
```

Identity, date, research cutoff, evidence SHA, and decision UUID agree throughout;
a context selection is no earlier than research start and no later than decision
recording. A completion joined to EvidenceBundle requires the manifest's
`memory_input_sha256` to equal the input context SHA and its frozen
`holding_period_days`/`benchmark_ticker` to equal the decision contract.
a run cannot include itself as a prior lesson. There is no circular hash back
into EvidenceBundle. The completed event and immutable report version retain
this full bundle after durable decision storage. Later dated review attachments
carry validated full DecisionSnapshots/artifacts separately; they do not rewrite
the as-generated input snapshot. SQLite/browser storage are validated mirrors;
Python per-decision JSON remains settlement authority. JSON/HTML/Markdown exports
retain full contracts, facts and reflection artifacts, not only displayed returns.

An evaluation review attachment has exactly:

```
{schema_version:1,decision_id,reviewed_at,snapshot:DecisionSnapshot,attachment_sha256}
```

The UUID matches the full snapshot. `reviewed_at` is no earlier than its decision
recording, outcome observation, or reflection completion. When attached to a
report version, compare `decision_sha256` and `contract_sha256` to that version's
completed MemoryBundle and require a strict monotonic merge whose result equals
the review snapshot (no omission of completed components). Dedupe identical
`snapshot_sha256` per version, irrespective of review time. A changed immutable
decision/contract/outcome/reflection fails; an attachment never replaces the
as-generated MemoryBundle or its input snapshot.

The no-provider inventory uses the existing known `smoke_test` command with
`memoryInventory:true` and 1–20 requested UUIDs. Its event is exactly
`{type:"memory_inventory",schema_version:1,requested_ids:[UUID],reviews:[ReviewAttachment],
missing_ids:[UUID]}` plus the protocol emitter's optional `HH:MM:SS` timestamp.
Requested IDs are unique; reviews/missing IDs are disjoint and cover the request.
Missing or moved storage is explicit missing, never reconstructed facts.
The entire single JSONL event is bounded by 64 MiB. Inventory initializes no
research graph/model/provider and reports no filesystem paths or raw exceptions.
The configured memory path is read from `TRADINGAGENTS_MEMORY_LOG_PATH` or the
existing default `~/.tradingagents/memory/trading_memory.md`, without importing
current research configuration. Constructor/load/list are read-only and never
mkdir, chmod, or write a lock file; atomic file images make unlocked reads safe.

## Python API and persistence

`tradingagents.memory.schema` exposes `canonical_json`, `hash_value`,
`hash_component(value,own_hash_key)`, `make_component(value,own_hash_key)`,
`make_artifact(kind,payload)`, `build_decision_snapshot`, `validate_decision`,
`merge_decision`, `validate_context_snapshot`, `validate_bundle`.
`build_review_attachment(snapshot,*,reviewed_at=None,completion_bundle=None)` and
`validate_review_attachment(value,completion_bundle=None)` provide the above
standalone and version-bound review validation.
The builder's keyword arguments are the decision fields above (except generated
hashes/schema/id), `decision_text`, and a finalized bound `contract`.

`MemoryStore(memory_log_path=None, *, storage_dir=None)` uses sibling
`decisions-v1/<UUID>/decision.json` next to configured `memory_log_path`, or an
explicit storage directory. No path means an explicit in-memory-only store.
Methods: `record_decision(snapshot)`, `load_decision(UUID)`, `list_decisions()`,
`attach_outcome(UUID,outcome,artifacts)`, `attach_reflection(UUID,reflection,artifacts)`,
`context_snapshot(instrument,research_cutoff,*,selected_at=None,same_ticker_limit=5,
cross_ticker_limit=3)`, `bundle(run_id,input_snapshot,*,evidence_bundle_sha256)`.
`bundle` atomically freezes `completion.json` under the same run lock once;
exact retries return the original completion even if `decision.json` has since
gained an outcome/reflection. A changed input/evidence/immutable decision fails.
`load_bundle(UUID)` reads this frozen completion. In-memory-only stores cache
completions separately with the same behavior.
Each return is an independent validated copy. `persistence_status` is exposed and
frozen in completed bundles. Disabled stores cannot serve later durable reviews.
The durable directory is private, writers use a stable advisory lock, strict
union is checked under lock, and writes fsync a temporary file before replace
and fsync the parent directory where supported. Fixed validation/persistence
errors expose no path, payload or provider exception. Exact retries preserve the
same snapshot; stale owners union monotonic outcome/reflection additions.

## Application mirrors and exports

Tasks and frozen report versions retain `memoryBundle`, `memoryValidation`, and
`evaluationReviews`. Legacy absence means unknown. A known invalid attachment
remains visible with exactly `{status:"invalid",reason}`; reason is one of
`malformed`, `hash_mismatch`, `unsafe_content`, `reference_mismatch`,
`temporal_mismatch`, or `verification_unavailable`. Invalid content is excluded
from mirrors and blocks export. Decision text and rating must equal the selected
report's exact frozen final decision and typed rating. Reports sharing a run UUID
must share its one immutable completion bundle. Review histories reject conflicting
non-null components and removal of earlier completed components; equal review
times require the same snapshot. Later reviews never modify original inputs.

Report JSON is the versioned envelope
`{schema_version:1,kind:"research_report",report,evidence_bundle:EvidenceBundle|null,
memory_bundle:MemoryBundle|null,evaluation_reviews:[ReviewAttachment]}`. `report`
contains frozen version metadata, sections, and output quality; attachments occur
only in the explicit top-level fields. HTML and Markdown include readable contract,
status and availability metadata plus complete escaped/dynamically fenced JSON
appendices for memory and review attachments. All formats verify cloned selected
versions before rendering. Large UI payloads are rendered lazily and previews may
be bounded with explicit notices; the full exact payload remains in exports.
