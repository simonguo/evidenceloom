# Saved public-source report case v1

This independent offline protocol binds one complete engineering report to the
retained BLS current API snapshot. It is separate from stock/crypto research
exports, Evidence, Memory, Numeric, fictional frozen-claim packs, public-source
corpora and pending expert packages. Their v1 contracts and fixtures are unchanged.

The report is an `engineering_fixture`. No human author identity, observed
production research execution, external research-model run or independent expert
approval is asserted. Hashes bind supplied artifacts; they do not authenticate an
author or originating provider. This is a real-source snapshot case for explicit
cell-literal comparisons, not an observed production analyst report.

## Files and immutable owners

The complete `report_v1.json` artifact carries a canonical UUID `report_id`, a
separate UUID `version_id`, positive version number, engineering composition time,
authorship declaration, title, original `full_text`, authority unknowns, pending
expert review and parsed-canonical component `report_sha256`. Author identity,
production run and external research-model run must remain null in this version.
The raw file is UTF-8 JSON, protected by its exact Git `-text` rule; its original
CRLF file separators and the full text's CJK, emoji and CRLF remain unchanged.
The same exact-file rule declares `whitespace=cr-at-eol`, allowing retained CRLF
line endings while ordinary trailing spaces still fail Git's whitespace check.

`case_v1.json` has its own UUID `case_id`, exact `policy_sha256`, external
`report_ref`, `source_ref`, ordered selected `claims` and component `case_sha256`.
The report reference binds both independent owner IDs, complete report file-byte
SHA-256, report component SHA and decoded full-text UTF-8 SHA. The source reference
binds corpus ID plus manifest, original response-byte and derived-table hashes.
Existing corpus validation and lossless monthly-table derivation are reused.

Every claim repeats these report/source targets and has a unique ID and selected
span. Spans use original decoded full-text UTF-8 half-open byte offsets and exact
text. No rendering, newline normalization, character-index conversion or current
prose regeneration establishes a saved selection. Repeated numeric span ranges
are rejected. Component hashes use inherited Python parsed-canonical JSON with
only the component's own hash excluded.

Each `cell` names series ID, year, monthly period, reference-period label, original
series/observation indexes and original decimal value string. All must agree with
the independent derived row. Units, adjustment and metadata status must match the
saved manifest declarations. Explicit context spans bind the series ID, reference
period, `index (1982-84=100)` unit label and seasonal-adjustment label. They show
only that those exact literals exist and agree with declared metadata; they do
not prove their semantic relationship to the number or surrounding sentence.

A coherently rehashed case cannot impersonate the independently supplied report
owner, source identity or original spans. A legitimate new report version and
rebound case may change a reported number. That remains valid input and produces
`MISMATCH`; it is not discarded as a malformed source case. Replacing an entire
consistent set of input authorities creates a different declared case, not
authenticated history of the previous one.

## Comparison and limitations

The four shipped selected claims reproduce the original saved literals:

| Series | Reference period | Original value | Original indexes |
| --- | --- | --- | --- |
| CUSR0000SA0 | 2023-11 | 308.148 | 0, 13 |
| CUSR0000SA0 | 2023-12 | 308.741 | 0, 12 |
| CUUR0000SA0 | 2023-11 | 307.051 | 1, 13 |
| CUUR0000SA0 | 2023-12 | 306.746 | 1, 12 |

Selections are complete supported ASCII decimal literals. Comparison is exact
original string equality, with no float conversion, rounding, scaling or formula.
Even a numerically equivalent spelling can be `MISMATCH` under this literal
policy. Valid input produces `MATCH` or `MISMATCH` for every submitted claim, in
input order. Counts retain the full selected-claim denominator. These counts do
not measure all numerical or factual assertions in the complete report, semantic
support, economic truth, or independent research accuracy.

Units and SA/NSA labels remain `manifest_declarations_only`. Monthly reference
periods are not daily market bars, publication times or first public availability.
The report concerns the snapshot recorded as retrieved on 2026-10-04, including
reference periods in 2023. It does not establish what was available during 2023.
Provider origin stays `NOT_AUTHENTICATED`; historical vintage and first availability
stay unknown, publication/first-availability times stay null, and historical
authority stays `UNAVAILABLE`. Absent historical release bodies are not replaced
by the saved reference notes. No percentage, prediction or investment conclusion
is added. The existing corpus attribution and required BLS notice are retained.

Semantic support is `NOT_EVALUATED`. Expert status and all four expert dimensions
remain `PENDING`, reviewer/time null, labels empty and approved claim denominator
zero. The four engineering cell matches do not fill this expert denominator.
Unrecognized schemas, invented author/run/expert/source authority, invalid or
dangling references and unsupported selections are rejected with a fixed error.

## Offline read-only execution

```sh
python scripts/verify_public_source_report_case.py \
  tests/fixtures/public_source_reports/bls-current-snapshot/case_v1.json \
  tests/fixtures/public_source_reports/bls-current-snapshot/report_v1.json \
  tests/fixtures/public_sources/bls-cpi-2023-2024/manifest_v1.json \
  tests/fixtures/public_sources/bls-cpi-2023-2024/raw.json
```

The CLI reads only four explicit files, bounded to 1 MiB each for report/case and
8 MiB each for manifest/raw. Case, report and manifest files must be UTF-8; raw
source JSON retains the existing corpus parser's encoding detection, including
UTF-16 and UTF-32. Duplicate keys, non-finite/deep JSON, invalid encoding for the
respective input and invalid supplied authorities are rejected. Package bootstrap
is set before imports; dotenv/profile loading, providers, network, research graphs and models
are omitted. Inherited sanitizers can inspect already-present environment values
to reject unsafe text; these are never included in output or diagnostics.

The CLI writes no file. Normal stdout is compact hashes, counts and explicit
unknown/pending states; it excludes report text, selected values, paths and author
details. Invalid input and argument errors return 1 with only
`Invalid public-source report case` on stderr. Valid cases, including mismatches,
return 0: exit success means a valid replay, not correct report numbers.

Public functions in `tradingagents.evaluation.public_source_reports` are
`validate_report_case`, `evaluate_report_case` and `validate_report_case_result`.
The result validator replays all declared selections and rejects a coherently
rehashed false count or status. Application imports retain the parent's normal
package initialization unless bootstrap was selected before importing it; the CLI
is the isolated entry point. No dependency is added.
