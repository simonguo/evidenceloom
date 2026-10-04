# Offline public-source corpus

The first real-source corpus retains an actual unauthenticated BLS API v1 CPI
response, its exact request and retrieval record, descriptive metadata, rights
references and an unfilled expert-review package. It provides reproducible source
inputs for research acceptance work. It does not certify a research report,
investment conclusion, provider origin or historical as-of authority.

This data-only protocol is separate from Evidence, Numeric, Memory and the owned
fictional selected-claim pack. CPI is a monthly statistical series: no security,
daily market bar, `Date`, `Close` or `Adj Close` is invented to fit those contracts.

## Verify the retained corpus

From the repository root:

```bash
uv run --frozen python scripts/verify_public_source_corpus.py \
  tests/fixtures/public_sources/bls-cpi-2023-2024/manifest_v1.json \
  tests/fixtures/public_sources/bls-cpi-2023-2024/raw.json \
  --review-package tests/fixtures/public_sources/bls-cpi-2023-2024/pending_review_v1.json
```

The command reads only the explicit files and source modules, writes no output
file and makes no network or provider request. Its compact JSON summary retains
separate raw, manifest and derived-table hashes, series/observation counts,
`historical_authority: UNAVAILABLE` and `expert: NOT_EVALUATED`. A failed check
returns nonzero with a fixed diagnostic that excludes input, paths and exception
details. Package bootstrap is set before imports; dotenv/profile loading and
provider initialization are omitted. Inherited text sanitizers may inspect
already-present environment values to reject unsafe text, without emitting them.

## Version 1 boundaries

`kind: public_source_corpus` and `normalization_policy:
bls-api-monthly-decimal-string-v1` identify this bounded protocol. The manifest's
parsed-canonical component hash excludes only its own `manifest_sha256`. Raw
response identity uses SHA-256 over the complete original entity bytes, which
remain protected from Git newline conversion with `-text`. Reserializing JSON
does not reproduce that raw identity.

Inputs are bounded to 8 MiB. Duplicate JSON keys, non-finite numbers, unexpected
fields, duplicate series/months and invalid value syntax are rejected. Only the
two explicit U.S. city-average all-items CPI-U series `CUSR0000SA0` and
`CUUR0000SA0` are supported. Requests contain one or both unique IDs and an
inclusive span of at most ten complete years. Every requested month must be
present exactly once for each series. Partial responses cannot pass as complete
coverage. HTTP 200, `REQUEST_SUCCEEDED`, an empty API message list, exact request
and raw hashes, UTC retrieval timestamps in order and the declared coverage must
agree. The capture record is a retained observation, not an authenticated
transport transcript or independently proven server origin.

`derive_bls_table(raw_bytes)` retains every observation in its original order.
Each row records the original series/observation indexes, `year`, `period`,
decimal `value` string and footnotes. It derives a monthly reference-period label
and calendar start/end boundaries, including leap years. It does not convert
values to floats, round, calculate inflation or infer publication time from a
reference period. The separately hashed table binds its normalization policy,
complete rows and source raw hash.

Subject, 1982–84=100 index base and seasonal adjustment are separately declared
from official definitions. The raw v1 response does not supply that descriptive
metadata. Validation checks those declarations against this protocol's fixed
series definitions; this is not a fresh metadata retrieval or provider entity
attestation. Percent and USD cannot replace the index unit, and seasonally
adjusted values cannot be relabeled as unadjusted observations.

The saved snapshot must remain `current_api_snapshot`, with null publication and
first-public-availability times and unknown historical vintage. Reference notes
for the January/February 2024 releases retain their reported metadata, but both
historical raw bodies are absent. Their raw hashes/byte counts must remain null,
and their support stays `reference_metadata_only_no_numeric_authority`. The
two supported reference declarations must retain consistent release identifiers,
reference period, original header literal, declared UTC time and reported value;
this check does not independently authenticate either reference page. The
observed HTTP 403 acquisition failure is retained. Declared reported times and
values neither fill the absent archive bytes nor establish first availability.
Actual archived bodies and independent temporal review require a separate future
protocol; changing these unknowns cannot make this corpus historically eligible.

The rights record retains official statement URLs, attribution, retrieval date,
required BLS notice and numerical-data scope. It excludes logos, photographs and
illustrations and explicitly records that it is not legal attestation. See the
[fixture provenance and required notice](../tests/fixtures/public_sources/bls-cpi-2023-2024/README.md).

## Pending independent review

`validate_pending_review(pending, manifest, raw_bytes)` independently verifies the
supplied corpus before accepting the package. It binds the corpus ID, manifest
and raw hashes, verifies every selected engineering cell at its original source
indexes, and preserves full table counts. Engineering expectations are separately
identified. They are not external expert labels or report-claim scores.

This version accepts only an unfilled package: reviewer/time null, labels empty,
approved claim denominator zero and all four dimensions `PENDING` (semantic
support, temporal validity, inference classification and abstention
appropriateness). Coherently rehashing an invented approval, historical authority
or false source cell cannot pass. A completed independent review belongs in a
separate artifact with actual reviewer provenance and method; this validator
does not approve one.

Real source acquisition and lossless normalization are concrete acceptance
inputs. Licensed source-complete research cases, historical vintages, expert
adjudication, analyst workflows and broader release acceptance remain open in
[the professional quality requirements](PROFESSIONAL_QUALITY.md).
