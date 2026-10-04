# BLS CPI current public-source corpus

This is a data-only source fixture. It contains two real BLS CPI-U U.S. city-average all-items monthly series and 48 observations for 2023–2024. It is not a stock-price table, an observed production analyst report, an expert-approved case set, or proof of a historical as-of vintage.

`raw.json` is the original response entity, copied byte for byte: 4,393 bytes, SHA-256 `d0e9ef0055f65b7e2593054f0ae0bb6e2eace7bfc02005c36399676b00e20a90`. The recorded request was a single unauthenticated POST to `https://api.bls.gov/publicAPI/v1/timeseries/data/`, selecting `CUSR0000SA0` and `CUUR0000SA0`, start year 2023, end year 2024. Retrieval started at 2026-10-04T09:51:29.776446+00:00 and completed at 2026-10-04T09:51:31.990955+00:00; HTTP status 200 and API status REQUEST_SUCCEEDED. The safe capture fields and exact request are retained in `manifest_v1.json`. No credential, request header, private endpoint or transport transcript is included.

Values remain the original decimal strings, with the original response series/observation indexes, period names and footnotes. `CUSR0000SA0` is seasonally adjusted; `CUUR0000SA0` is not seasonally adjusted. Their subject is CPI-U, U.S. city average, all items; their unit is an index with base 1982–84=100, not USD or percent. Definition-derived subject/units/adjustment metadata is separately declared: [BLS series identifiers](https://www.bls.gov/cpi/factsheets/cpi-series-ids.htm), [BLS base-period example](https://www.bls.gov/help/column.htm). API v1 itself does not supply descriptive metadata. No daily Date, Close, issuer, market bar or stock ticker is fabricated.

Source: U.S. Bureau of Labor Statistics. Retrieved October 4, 2026.

> BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.

The official [BLS copyright statement](https://www.bls.gov/bls/linksite.htm) permits use of published public-domain material and asks for attribution, while excluding previously copyrighted photographs/illustrations and protecting the BLS emblem. This fixture contains numerical data and none of those assets. The [BLS API terms](https://www.bls.gov/developers/termsOfService.htm) require the retrieval-date citation and notice above, and prohibit falsely representing altered content as BLS source content. This records official statements, not a blanket legal attestation or agency endorsement.

Current retrieval does not establish historical vintage, publication time or first public availability: all remain explicit null/unknown in this manifest. [BLS documents seasonal revisions](https://www.bls.gov/cpi/seasonal-adjustment/using-seasonally-adjusted-data.htm), and the two dated [January 11, 2024](https://www.bls.gov/news.release/archives/cpi_01112024.htm) / [February 13, 2024](https://www.bls.gov/news.release/archives/cpi_02132024.htm) reference pages report December 2023 seasonally adjusted monthly changes of 0.3 / 0.2 percent. Those numbers in the manifest are reference metadata only. The browsing tool could read the pages, but an identified normal HTTP request for the January HTML returned 403 on October 4, 2026. The exact observed failure is retained. Neither historical raw body was captured; no source hash, normalized archive table or positive historical numerical authority is invented. The ET-to-UTC timestamps describe the reported winter release headers, not independently observed first availability.

`pending_review_v1.json` binds this exact manifest and raw hash. It contains engineering expectations from direct inspection and an unfilled independent-review package. All four expert dimensions are PENDING, reviewer/time are null, labels are empty, and approved expert denominator is zero. An actual independent review must be recorded separately, with its own provenance and method.

The saved source files are immutable inputs. Normalization and validator outputs must name their separate derived hashes; reserializing the raw JSON does not preserve the original response-byte identity. Existing Evidence, Numeric, Memory and frozen-claims v1 contracts are unchanged.

From a source checkout, the read-only verifier can inspect the exact fixture and its pending package:

```sh
python3 scripts/verify_public_source_corpus.py \
  tests/fixtures/public_sources/bls-cpi-2023-2024/manifest_v1.json \
  tests/fixtures/public_sources/bls-cpi-2023-2024/raw.json \
  --review-package tests/fixtures/public_sources/bls-cpi-2023-2024/pending_review_v1.json
```

The source functions `validate_corpus`, `derive_bls_table` and `validate_pending_review` check explicitly supplied inputs. The CLI writes no files and makes no network request; its summary reports the raw/manifest/derived-table identities, two series, 48 observations, unavailable historical authority and expert status NOT_EVALUATED. The derived table retains decimal strings, original monthly labels and period names, calendar-month boundaries (not daily bars), footnotes and source response indexes. These checks establish consistency with the supplied source body; they do not authenticate the originating server, attest rights, certify economic truth, fill missing historical bytes, establish first public availability, or replace independent expert assessment.
