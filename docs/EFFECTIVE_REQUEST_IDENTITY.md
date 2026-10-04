# Saved effective outer-request alignment, v1

This assessment checks the saved outer tool selector against the requested run
identifier. It does **not** certify provider requests, issuer identity, article
subjects, venue, provenance, or financial truth. Provider request and entity
statuses are always `unknown` in v1. Exact bare identifiers can align literally
while venue and entity remain unknown. Existing saved Evidence, Numeric Review,
Memory and Readiness v1 payloads and business policies remain unchanged. Evidence
adds the optional policy-hash manifest key and browser owner validation is strengthened.

The normative policy is
`docs/contracts/effective_request_identity_policy_v1.json`. Its SHA-256 is over
compact, sorted-key, UTF-8 JSON, without ASCII escaping. Production embeds this
exact policy; it does not load a documentation file or call `normalize_symbol`.
The shared offline cases are `tests/fixtures/effective_request_identity_v1.json`.

## Attachment

The Python state field is `effective_request_identity`; desktop/completed and
frontend use `effectiveRequestIdentity`. Absence on an older version means
unknown, and does not trigger posthoc assessment generation. A present null or
invalid attachment is invalid. One immutable assessment belongs to each frozen
report version/run. Retained copies of the same run must agree exactly.

All keys below are required; unknown keys are invalid. JSON numbers are bounded
integers only. Strings, nulls, arrays and objects are otherwise exact saved
values. Assessment fields:

```text
schema_version: 1
scope: "saved_effective_outer_request_alignment"
policy_version: "saved-effective-request-v1"
policy_sha256: lowercase SHA-256 of the normative policy
run_id: canonical UUID, equal to Evidence and ReportTextSnapshot
instrument: exact Evidence/ReportTextSnapshot instrument
analysis_date: exact Evidence/ReportTextSnapshot YYYY-MM-DD
evidence_bundle_sha256: final Evidence bundle SHA-256
report_snapshot_sha256: exact ReportTextSnapshot SHA-256
reviewed_at: valid UTC YYYY-MM-DDTHH:MM:SS.ffffffZ
records: RecordAssessment[], sorted by ASCII evidence_id, complete
summary: Summary
assessment_sha256: canonical component SHA-256, excluding only this key
```

`reviewed_at` must be at or after snapshot `captured_at`, Evidence `created_at`
and every record's `fetched_at`. Inherited Evidence clocks keep their existing
seconds/1–6 fractional-digit syntax; new clocks require exactly six digits.
The final snapshot binds exact published report sections and citation audit.

The optional Evidence manifest `effective_request_identity_policy_sha256`
marks new runs whose completed versions require this assessment. When present,
it must equal the frozen v1 policy hash for a valid assessment. Missing or invalid assessments on marked
completed versions fail closed at the completed/version boundary. Unmarked older
versions retain absence as unknown and are not silently reassessed. A marked
assessment with any unsafe IDs requires the authoritative rating extracted from
the frozen `final_trade_decision`, the owner's typed decision, and any saved Memory
decision to be `REVIEW`. Storage can retain an explicit invalid diagnostic without
an assessment, including an unknown policy marker, so the failure remains visible;
all report exports are then blocked. This diagnostic does not validate the policy.
An explicitly supplied dated
assessment for an unmarked legacy archive can describe conflict alongside its
unchanged original decision; it does not retroactively certify that decision.
Such an archive can be imported as a new owner; an assessment cannot be added to
an already retained frozen version that lacked it.

```text
RecordAssessment = {
  evidence_id, tool, content_scope,
  canonical_selector_key: "symbol" | "ticker" | null,
  canonical_alignment: "consistent" | "conflict" | "unknown" | "proxy" | "not_applicable",
  canonical_reason, canonical_rule,
  record_alignment: same enum,
  record_reason,
  venue: "SH" | "SZ" | "HK" | null,
  unexpected_selector_keys: sorted additional selector-like keys,
  sources: [{source_index, provider, data_sha256,
             provider_request: "unknown", provider_entity: "unknown"}]
}
Summary = {
  record_count, source_count, consistent_count, conflict_count,
  unknown_count, proxy_count, not_applicable_count,
  unsafe_record_ids: sorted evidence IDs
}
```

Every Evidence record appears exactly once. Every source, including a non-head,
withheld, unknown, or null-data source, appears in its original indexed position.
Source provider/data SHA are copied exactly. No selective or omitted coverage is
allowed. All derived fields, coverage and the summary are independently
recomputed during validation. Coherent rehashing cannot make a false result
valid. Bounds are the policy bounds plus the existing validated Evidence and
snapshot bounds. Errors use a fixed diagnostic without data, paths or secrets.

## Comparison and reasons

Trim only ASCII space, tab, CR, LF, FF and VT; uppercase only ASCII a–z.
Preserve raw saved values. Do not normalize Unicode, infer a venue from a bare
code, truncate malformed codes, strip arbitrary plus signs, or merge aliases
through a current resolver.

The policy names the sole proven selector for each tool. Missing or non-string,
empty or overlong selectors are unknown. An alternate key cannot substitute.
Canonical conflict takes precedence. Otherwise any extra `instrument`,
`symbol`, or `ticker` key makes record-level metadata ambiguous/unknown,
regardless of its value; it does not prove that key reached a provider.
Canonical alignment/reason/rule remain independently visible.

Exact normalized equality is literal alignment. Reviewed complete mainland
six-digit SH/SS/SH-prefix and SZ/SZ-prefix spellings can align notation; explicit
different venues conflict. Explicit HK suffixes with 1–4 ASCII digits can be
left-padded to four. Five-digit HK and bare-qualified relations are unreviewed.
Different supported ASCII literals otherwise conflict only as request spelling,
not as a claim of different economic issuers. Differing malformed/non-ASCII
forms are unknown. The bounded policy currency/crypto lists recognize differing
pair notation as unknown; discussion `.X` notation is also unknown.

The frozen proxy pairs identify a declared reference relation only when both
saved literals are that exact pair. This is `proxy`, never identity consistency
or proof of actual provider conversion. Two aliases sharing a reference are
not automatically equivalent. Retrieval-context tools do not verify the
subject of every returned article or post. Global news is not applicable;
the unproduced legacy `get_market_data_snapshot` selector scope is unknown.

Reason codes are exactly the policy `reason_codes`. Canonical rule strings and
their precedence are frozen by the Python helper and shared cases. The summary
marks every non-global record whose record alignment is `conflict`, `unknown`
or `proxy` unsafe for automatic directional recommendation use. This includes
legacy unknown tool scope, unresolved qualification and retrieval-context
unknown relations. Global queries are harmless to this scoped gate. Missing
provider/entity observations alone do not block a consistent literal request.

## Execution and APIs

`assess_selector(instrument, tool, parameters)` is the pure scoped derivation.
`assess_effective_request_identity(evidence, snapshot, reviewed_at=...)` validates
and captures input copies, derives complete coverage and creates an attachment.
`validate_effective_request_identity(value, evidence, snapshot)` rederives every
field and returns an independent copy only when the exact assessment matches.
`unsafe_effective_request_ids(evidence)` independently validates Evidence and
returns the policy-derived sorted unsafe IDs before any PM use.
`freeze_effective_request_identity(storage_dir, evidence, snapshot, existing=...)`
in `effective_request_identity_persistence.py` atomically freezes one assessment
under the Evidence run lock. Retries retain the first reviewed clock. Changed
Evidence, snapshot or an existing same-run assessment is rejected; persisted
bytes are bounded to 64 MiB. Write/read errors have fixed sanitized diagnostics.

The ledger guard runs before replay lookup and before the operation callback.
Explicit canonical conflict produces a persisted, citation-bearing `withheld`
record with no provider attempts or sources and a fixed `REQUEST_WITHHELD`
notice. The conflicting saved parameters remain available for diagnosis. An
old replay queue cannot deliver an unsafe saved body. Unknown/proxy requests
remain observable instead of being silently converted to consistency. No-ledger
direct calls retain their public behavior. The graph guard stops PM use of unsafe
saved request records and returns a cited `REVIEW` without a manager model call.
Completion independently checks both the original decision prose and typed rating
before recording Memory, then freezes the assessment against the final Evidence
and original report snapshot. Readiness v1 business rules are not rewritten.

Browser validators bind present attachments to the actual task's ticker/date or the
selected version's task metadata/run UUID. An imported object containing both
task-status and version-task discriminators is rejected as an ambiguous owner.
These ownership checks also apply to inherited Evidence, Memory, Readiness and
Numeric attachments; their v1 policies and saved payloads are unchanged.
Legacy absence remains unknown and explicit invalid diagnostics remain visible;
retaining a diagnostic does not authenticate the imported owner.

This slice leaves provider-resolved symbols, alias conversion observations,
venue/entity resolution, Memory target freezing, and whole financial claims
outside its proof. Tests and fixtures use fictional saved data; no provider or
model calls are needed.
