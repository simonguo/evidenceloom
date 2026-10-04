# Frozen selected-claim evaluation v1

This offline evaluation harness binds explicitly selected claims to a complete
saved `research_report` JSON export. It retains the original report, nullable
sections, Evidence artifacts and receipts. It runs no research graph, model,
provider retrieval or report extraction. A passing selected number does not
verify its surrounding sentence, thesis, prediction or economic entity.

The normative policy is
[`contracts/frozen_claim_evaluation_policy_v1.json`](contracts/frozen_claim_evaluation_policy_v1.json).
It is embedded in `tradingagents.evaluation.policy`; packs must name its exact
Python parsed-canonical SHA-256. This is a new offline evaluation protocol; the
saved Numeric v1, Memory v1/v2, Evidence v1 and report export protocols are unchanged.

## Running an evaluation

From a source checkout with the existing frozen project environment:

```sh
.venv/bin/python scripts/evaluate_frozen_research.py \
  tests/fixtures/frozen_claims/pack_v1.json --output /path/to/new-result.json
```

The output parent directory must exist. The CLI writes one new result and prints
its component SHA-256. An existing output is never overwritten. Diagnostics are
fixed strings and do not include input bodies, filesystem paths or subprocess
output. The output is independently replay-validated before publication.

The CLI sets bootstrap mode **before importing `tradingagents`**. It does not
load dotenv, profiles or credential files, initialize providers, or make network
requests. Inherited safety validators may inspect secret-shaped values already
present in the process environment to reject matching unsafe input text; these
values are never included in results or diagnostics. Ordinary unsafe report or
metadata text is rejected, rather than redacted into a different historical
report. Opaque normalized-data JSON strings are checked by the inherited Evidence
and lossless numeric validators; their original number lexemes remain intact.

The public Python functions are:

```python
from tradingagents.evaluation import (
    validate_research_report, validate_pack, evaluate_pack,
    validate_evaluation_result, evaluate_file,
)
```

Applications importing these APIs have already run the normal parent-package
initialization unless they chose bootstrap mode before their first package
import. The APIs themselves perform saved-input validation and arithmetic only;
the CLI is the configuration-isolated entry point. No dependency was added.

## Pack and immutable authorities

A pack contains `schema_version: 1`, `kind: frozen_claim_evaluation_pack`, its
`pack_id`, exact `policy_sha256`, a distribution declaration, a provenance
declaration, ordered `cases`, ordered `label_sets`, and `pack_sha256`.
The distribution record explicitly declares `fictional_owned`. Distribution
and provenance are reported as `DECLARED_NOT_INDEPENDENTLY_VERIFIED`; a declaration
is not evidence of independent labeling, source licensing or expert acceptance.

There are at most 32 cases, 100 claims per case and 1,000 claims overall. Case IDs,
claim IDs and label-set IDs are unique across a pack. Every case contains:

| Field | Meaning |
| --- | --- |
| `case_id` | Stable case identifier |
| `research_report` | Complete, unmodified exported report envelope |
| `report_sha256` | Hash of the complete parsed report envelope |
| `claims` | Explicit selections in denominator order |
| `case_sha256` | Hash of the case excluding this own hash field |

Every claim has `claim_id`, `kind`, `target`, `span`, `selection`, nullable `note`
and `claim_sha256`. The target binds task ID, saved version ID, saved run ID,
ReportTextSnapshot SHA (or null when absent), section key and the section's raw
UTF-8 SHA. Spans are exact UTF-8 half-open byte offsets with the exact selected
text. Emoji, CRLF and null sections are retained. Rendering, trimming, Unicode
normalization and regenerated prose cannot become span authority.

Complete reports are checked against the export whitelist. Optional `runId`,
`instrumentName`, optional runtime metadata and absent `outputQuality` remain
absent; nulls are not replaced. Known output-quality records must have their
actual schema, status, source and reason shape. Format metadata does not certify
factual quality. A present modern `runId` must be a canonical UUID. Empty run IDs
are invalid. Nonempty opaque legacy run literals and missing/null run IDs remain
unknown report-run owners and cannot establish numerical claim authority.

Evidence, ReportTextSnapshot and numeric review histories are validated and
rederived with the inherited validators. Each available attachment is bound to
the report's instrument, analysis date and known run owner; its original sections
must agree exactly with the report. The snapshot capture clock cannot precede
Memory's recorded decision. An absent snapshot is never rebuilt from matching
current text, Evidence, a Memory decision or a later saved review.

Memory's complete bundle, target marker, owner decision text/rating/asset and
append histories are structurally validated. Readiness and effective-request
identity markers require their original receipts. Complete readiness checks and
identity selector assessments are rederived from saved Evidence; coherently
rehashed false assessments fail. Blocked readiness and marked unsafe request
receipts require the original REVIEW decision. The inherited selector and
readiness derivations are reused; the byte-identical local rating helper avoids
the eager agent/model imports in the inherited public validators' blocked paths.
No Memory outcome arithmetic, model eligibility or new reflection is certified
by this harness.

A saved version ID has one global immutable report owner. Repeated versions may
retain compatible append-only numeric/evaluation histories. Copies under distinct
version IDs may refer to the same frozen run only when its complete as-generated
report and attachments agree. All saved Memory decisions, including decisions
inside input contexts and later reviews, share a global run authority; compatible
later extensions are allowed, contradictory decisions/contracts/facts/reflections
are rejected. Hashing an altered copy does not establish a second owner.

## Numerical scope

The selected saved-field baseline reuses Numeric v1 without modifying its policy,
span rules, arithmetic or supported inference scope. Its witness retains the
complete rederived numeric review, original number lexeme, source binding and
unreviewed dimensions. In particular, a standalone Numeric v1 field selected
from a percentage expression remains manual inference.

Every operand names its Evidence record ID, source index and table-cell selector,
plus explicit `provider`, `data_sha256`, `units` and `adjustments` witnesses. These
must exactly match the referenced saved source. Null source metadata stays null.
A false or dangling source witness is invalid input, even after coherent rehashing.

The only additional arithmetic family is explicit two-row price change:

```text
100 * (end - start) / start
```

Both operands must use the same Evidence record, source index, artifact SHA,
table path and field, with field exactly `Close` or `Adj Close`. Two otherwise
valid operands outside this family remain `MANUAL` in the denominator, including
when another selected context literal disagrees. They do not disappear as an
invalid numerical case or receive a percentage certification.

Within that family, both prices must be positive supported JSON number lexemes.
Numbers are converted exactly to rational fractions. The formula is evaluated
without binary floats or intermediate rounding, then quantized once with HALF-UP,
0–18 places, ties away from zero and positive rounded zero. Huge adjacent integers,
scientific notation in saved sources and ties preserve their original lexemes.
A selected percentage must be a complete signed ASCII number followed by `%`;
a complete exponent form such as `1e1%` is supported. Partial signs/exponents,
substrings, grouped or localized numbers, repeated percent signs and scale suffixes
remain manual.

Rows must have distinct chronological local date components. Full saved labels
are preserved. Selected dates cannot be after the research cutoff date or outside
a present declared observed window. This is **date-component comparison only**:
it performs no timezone conversion, exchange-calendar verification, bar-completion
assessment or historical-vintage certification. An absent observed window stays
unknown, and numerical comparison alone does not fill it in.

Context bindings select exact report literals for instrument, dates, units and
basis. A matching declared literal is reported separately from an unknown or
missing dimension. Source `adjustments` is declared metadata, not proof that a
provider performed an adjustment correctly. An unknown currency, economic entity,
vintage, method, calendar or basis remains unknown even if arithmetic matches.

Prediction selections retain their actual Numeric v1 selected-field baseline
(which may match a saved number), then return overall `MANUAL` with
`prediction_not_evaluated`. A price fact or correctly reproduced percentage is
not evidence that a forecast, entry/stop/target or investment thesis is valid.

## Labels, disagreements and full denominators

Each label set is an independently hashable component with exact fields:

```text
schema_version, label_set_id, provenance, method_record, revision,
case_id, case_sha256, labels, label_set_sha256
```

Only `engineering` and `independent_arithmetic` strata are supported. There is at
most one set for each case/stratum, at most twice the number of cases overall,
and a positive revision plus a safe method record. Each ordered label names the
exact claim ID and SHA and an expected triple `{status, rounded_decimal, reason}`.
The set's case SHA binds the complete frozen report and claim choices. Empty and
partial label sets are retained; expert label provenance is rejected.

Computed statuses are `MATCH`, `MISMATCH`, `MISSING`, `MANUAL` and
`UNKNOWN_LEGACY`. Every declared claim stays in input order and in the denominator,
including unavailable/withheld/non-numeric sources, unsupported operations,
predictions and absent original numeric authority. Evidence absence and snapshot
absence are reported separately; a Memory v2 export with no ReportTextSnapshot
still has unknown original numeric authority.

A label is compared with the complete computed status/rounded-decimal/reason
triple. A wrong label is a `DISAGREEMENT`; it cannot replace the computed result.
Each stratum separately reports the full annotated-claim denominator,
`labels_present`, `agreement`, `disagreement` and `unlabeled`. The labeler's
provenance and method remain declarations. An engineering match count is not
an independent arithmetic reference count, nor an estimate of report accuracy.

The shipped fictional pack contains 11 cases and 16 ordered claims: 3 MATCH,
3 MISMATCH, 6 MISSING, 3 MANUAL and 1 UNKNOWN_LEGACY. Its engineering labels cover
all 16 claims. Six independently hand-calculated comparison labels cover the
comparable arithmetic claims; the other ten are explicitly unlabeled in that
stratum. These values describe this fictional pack, not production research quality.

External expert approved denominator is zero. The four claim dimensions
`semantic_support`, `temporal_validity`, `inference_classification` and
`abstention_appropriateness` are all `NOT_EVALUATED`. No result-level overall
verified badge, professional acceptance or expert success score is produced.
Actual licensed/source-complete cases, approved independent expert labels and
broader inference families remain future work.

## Reproduction and publication

Component hashes use Python parsed-canonical JSON: sorted object keys, compact
separators, UTF-8, no NaN and the own hash field excluded. They are not file-byte
hashes or a promise of cross-language numeric canonicalization. Original embedded
JSON payload strings retain their raw number lexemes. Duplicate JSON keys,
non-finite input and bounded-depth/size violations are rejected.

Results record the complete readable `tradingagents/**/*.py` source manifest,
including the evaluator and byte-identical rating helper, the CLI, CLI package
initializer and manifest helper, declared `pyproject.toml`/`uv.lock` bytes, and
Python implementation/version/cache tag. Dependency file identity is not an
attestation of all installed packages or standard-library bytes. Saved-input
execution imports only standard-library and receipt-validation modules.

`validate_evaluation_result` replays all claims, receipts, labels, denominator
counts and local implementation identity. A coherently rehashed false result is
rejected. Verification under changed source/Python identity requires the recorded
implementation; an old identity is not silently replaced with the current one.

Output publication fsyncs an owned temporary file, links it atomically to the new
output without overwrite, and always cleans the temporary path. On platforms
supporting directory descriptors, the containing directory is also fsynced.
Validation and failures before linking produce no new output. A durability error
after the successful link can leave the complete new file present while reporting
a fixed I/O error; an existing file is never replaced. Unsupported filesystem
operations fail with a fixed diagnostic. This source CLI
validation does not prove packaged sidecar, installer/signature or interactive
frontend behavior; those require their own release evidence.
