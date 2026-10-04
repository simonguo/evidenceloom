"""Verify an offline BLS monthly corpus without inventing historical authority."""

from __future__ import annotations

from calendar import monthrange
from copy import deepcopy
from datetime import date
from decimal import Decimal
import hashlib
import re

from tradingagents.memory.schema import make_component, parse_json

from .guards import bounded, component, fail, integer, sha, shape, text, timestamp, day

MAX_SOURCE_BYTES = 8 * 1024 * 1024
NORMALIZATION_POLICY = "bls-api-monthly-decimal-string-v1"
API_URL = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
RIGHTS_URLS = [
    "https://www.bls.gov/bls/linksite.htm",
    "https://www.bls.gov/developers/termsOfService.htm",
]
NOTICE = (
    "BLS.gov cannot vouch for the data or analyses derived from these data "
    "after the data have been retrieved from BLS.gov."
)
SERIES = {
    "CUSR0000SA0": "seasonally_adjusted",
    "CUUR0000SA0": "not_seasonally_adjusted",
}
SUBJECT = {
    "index_type": "CPI-U",
    "area_code": "0000",
    "area_name": "U.S. city average",
    "item_code": "SA0",
    "item_name": "All items",
}
UNITS = {"kind": "index", "base": "1982-84=100"}
METADATA_URLS = [
    "https://www.bls.gov/cpi/factsheets/cpi-series-ids.htm",
    "https://www.bls.gov/help/column.htm",
]
MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
EXPERT_DIMENSIONS = {
    "semantic_support",
    "temporal_validity",
    "inference_classification",
    "abstention_appropriateness",
}
# These are retained reader-derived declarations, not authenticated archive
# bodies or historical numerical authority. V1 admits only these two notes.
REFERENCE_METADATA = {
    "https://www.bls.gov/news.release/archives/cpi_01112024.htm": {
        "release_id": "USDL-24-0019",
        "reference_period": "2023-12",
        "reported_publication_literal": "8:30 a.m. (ET) Thursday, January 11, 2024",
        "reported_publication_utc": "2024-01-11T13:30:00.000000Z",
        "reported_value": "0.3",
    },
    "https://www.bls.gov/news.release/archives/cpi_02132024.htm": {
        "release_id": "USDL-24-0265",
        "reference_period": "2023-12",
        "reported_publication_literal": "8:30 a.m. (ET) Tuesday, February 13, 2024",
        "reported_publication_utc": "2024-02-13T13:30:00.000000Z",
        "reported_value": "0.2",
    },
}


class PublicSourceCorpusError(ValueError):
    def __init__(self):
        super().__init__("Invalid public-source corpus")


def _checked(operation):
    try:
        return operation()
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        OverflowError,
        RecursionError,
        UnicodeError,
        AttributeError,
    ):
        raise PublicSourceCorpusError() from None


def _raw_table(raw_bytes):
    if type(raw_bytes) is not bytes or not 0 < len(raw_bytes) <= MAX_SOURCE_BYTES:
        fail()
    body = bounded(parse_json(raw_bytes))
    shape(body, {"status", "responseTime", "message", "Results"})
    if body["status"] != "REQUEST_SUCCEEDED" or body["message"] != []:
        fail()
    integer(body["responseTime"])
    shape(body["Results"], {"series"})
    series = body["Results"]["series"]
    if not isinstance(series, list) or not 1 <= len(series) <= len(SERIES):
        fail()
    seen_series, seen_periods, rows = set(), set(), []
    for series_index, entry in enumerate(series):
        shape(entry, {"seriesID", "data"})
        series_id, observations = entry["seriesID"], entry["data"]
        if series_id not in SERIES or series_id in seen_series:
            fail()
        seen_series.add(series_id)
        if not isinstance(observations, list) or not 1 <= len(observations) <= 120:
            fail()
        for observation_index, item in enumerate(observations):
            shape(item, {"year", "period", "periodName", "value", "footnotes"})
            year, period, value = item["year"], item["period"], item["value"]
            if (
                not isinstance(year, str)
                or not re.fullmatch(r"[0-9]{4}", year)
                or not 1900 <= int(year) <= 9999
                or not isinstance(period, str)
                or not re.fullmatch(r"M(?:0[1-9]|1[0-2])", period)
            ):
                fail()
            year_number, month = int(year), int(period[1:])
            key = (series_id, year, period)
            if key in seen_periods or item["periodName"] != MONTH_NAMES[month - 1]:
                fail()
            seen_periods.add(key)
            if (
                not isinstance(value, str)
                or len(value) > 128
                or not re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value)
                or Decimal(value) <= 0
            ):
                fail()
            footnotes = item["footnotes"]
            if not isinstance(footnotes, list) or len(footnotes) > 20:
                fail()
            for note in footnotes:
                shape(note, set(), optional={"code", "text"})
                for content in note.values():
                    text(content, limit=4096)
            rows.append(
                {
                    "series_id": series_id,
                    "source_series_index": series_index,
                    "source_observation_index": observation_index,
                    "year": year,
                    "period": period,
                    "period_name": item["periodName"],
                    "reference_period": f"{year}-{month:02d}",
                    "period_start": date(year_number, month, 1).isoformat(),
                    "period_end": date(
                        year_number, month, monthrange(year_number, month)[1]
                    ).isoformat(),
                    "value": value,
                    "footnotes": deepcopy(footnotes),
                }
            )
    return make_component(
        {
            "schema_version": 1,
            "kind": "bls_monthly_decimal_table",
            "normalization_policy": NORMALIZATION_POLICY,
            "source_raw_sha256": hashlib.sha256(raw_bytes).hexdigest(),
            "rows": rows,
        },
        "table_sha256",
    )


def derive_bls_table(raw_bytes):
    """Retain every row in source order with exact decimal strings and witnesses.

    Subject, base and seasonal adjustment are declared separately in the corpus;
    the v1 response itself does not provide that descriptive metadata.
    """
    return _checked(lambda: _raw_table(raw_bytes))


def _validate(manifest, raw_bytes):
    captured = bounded(manifest)
    shape(
        captured,
        {
            "schema_version",
            "kind",
            "corpus_id",
            "provider",
            "dataset",
            "normalization_policy",
            "request",
            "capture",
            "snapshot",
            "series",
            "rights",
            "historical_references",
            "acquisition_failure",
            "manifest_sha256",
        },
    )
    component(captured, "manifest_sha256")
    if (
        type(captured["schema_version"]) is not int
        or captured["schema_version"] != 1
        or captured["kind"] != "public_source_corpus"
        or captured["provider"] != "bls"
        or captured["dataset"] != "cpi"
        or captured["normalization_policy"] != NORMALIZATION_POLICY
    ):
        fail()
    text(captured["corpus_id"], nonempty=True, limit=256)
    request = captured["request"]
    shape(request, {"source_url", "method", "body_utf8", "body_sha256"})
    if request["source_url"] != API_URL or request["method"] != "POST":
        fail()
    text(request["body_utf8"], nonempty=True, limit=4096)
    sha(request["body_sha256"])
    if hashlib.sha256(request["body_utf8"].encode("utf-8")).hexdigest() != request["body_sha256"]:
        fail()
    body = parse_json(request["body_utf8"])
    shape(body, {"seriesid", "startyear", "endyear"})
    requested = body["seriesid"]
    if (
        not isinstance(requested, list)
        or not 1 <= len(requested) <= len(SERIES)
        or any(not isinstance(item, str) or item not in SERIES for item in requested)
        or len(set(requested)) != len(requested)
    ):
        fail()
    for name in ("startyear", "endyear"):
        if not isinstance(body[name], str) or not re.fullmatch(r"[0-9]{4}", body[name]):
            fail()
    start, end = int(body["startyear"]), int(body["endyear"])
    if not 1900 <= start <= end <= 9999 or end - start >= 10:
        fail()
    capture = captured["capture"]
    shape(
        capture,
        {
            "retrieval_started_at",
            "retrieval_completed_at",
            "http_status",
            "api_status",
            "content_type",
            "raw_bytes",
            "raw_sha256",
        },
    )
    began = timestamp(capture["retrieval_started_at"])
    completed = timestamp(capture["retrieval_completed_at"])
    if (
        began.utcoffset().total_seconds() != 0
        or completed.utcoffset().total_seconds() != 0
        or began > completed
        or end > completed.year
    ):
        fail()
    if type(capture["http_status"]) is not int or capture["http_status"] != 200:
        fail()
    if capture["api_status"] != "REQUEST_SUCCEEDED":
        fail()
    text(capture["content_type"], nonempty=True, limit=128)
    integer(capture["raw_bytes"], low=1, high=MAX_SOURCE_BYTES)
    sha(capture["raw_sha256"])
    table = _raw_table(raw_bytes)
    if (
        capture["raw_bytes"] != len(raw_bytes)
        or capture["raw_sha256"] != table["source_raw_sha256"]
    ):
        fail()
    if captured["snapshot"] != {
        "kind": "current_api_snapshot",
        "publication_time": None,
        "historical_vintage": "unknown",
        "first_public_availability": None,
        "first_public_availability_status": "unknown",
    }:
        fail()
    declarations = captured["series"]
    if not isinstance(declarations, list) or len(declarations) != len(requested):
        fail()
    expected_periods = {
        f"{year}-{month:02d}" for year in range(start, end + 1) for month in range(1, 13)
    }
    observed_ids = {row["series_id"] for row in table["rows"]}
    if observed_ids != set(requested):
        fail()
    declared_ids = set()
    for entry in declarations:
        shape(
            entry,
            {
                "series_id",
                "subject",
                "frequency",
                "units",
                "adjustment",
                "metadata_basis",
                "observed_coverage",
            },
        )
        series_id = entry["series_id"]
        if (
            not isinstance(series_id, str)
            or series_id not in requested
            or series_id in declared_ids
        ):
            fail()
        declared_ids.add(series_id)
        if (
            entry["subject"] != SUBJECT
            or entry["frequency"] != "monthly"
            or entry["units"] != UNITS
            or entry["adjustment"] != SERIES[series_id]
        ):
            fail()
        if entry["metadata_basis"] != {
            "status": "declared_from_official_definitions",
            "source_urls": METADATA_URLS,
        }:
            fail()
        rows = [row for row in table["rows"] if row["series_id"] == series_id]
        if {row["reference_period"] for row in rows} != expected_periods:
            fail()
        coverage = entry["observed_coverage"]
        shape(coverage, {"start", "end", "observation_count"})
        integer(coverage["observation_count"], low=1, high=120)
        if coverage != {"start": f"{start}-01", "end": f"{end}-12", "observation_count": len(rows)}:
            fail()
    rights = captured["rights"]
    shape(
        rights,
        {
            "basis",
            "source_urls",
            "checked_date",
            "attribution",
            "retrieval_date",
            "required_notice",
            "scope",
            "status",
        },
    )
    if (
        rights["basis"] != "official_public_domain_statement"
        or rights["source_urls"] != RIGHTS_URLS
        or rights["attribution"] != "Source: U.S. Bureau of Labor Statistics"
        or rights["required_notice"] != NOTICE
        or rights["scope"] != "numeric_data_only_excludes_logos_photographs_illustrations"
        or rights["status"] != "official_statements_recorded_not_legal_attestation"
    ):
        fail()
    if day(rights["retrieval_date"]) != completed.date().isoformat():
        fail()
    if day(rights["checked_date"]) < rights["retrieval_date"]:
        fail()
    references = captured["historical_references"]
    if not isinstance(references, list) or len(references) > 20:
        fail()
    reference_ids, reference_urls = set(), set()
    for entry in references:
        shape(
            entry,
            {
                "reference_id",
                "source_url",
                "release_id",
                "reference_period",
                "reported_publication_literal",
                "reported_timezone",
                "reported_publication_utc",
                "reported_value",
                "units",
                "acquisition_status",
                "raw_sha256",
                "raw_bytes",
                "support_status",
            },
        )
        for name in ("reference_id", "release_id", "reported_publication_literal"):
            text(entry[name], nonempty=True, limit=256)
        if entry["reference_id"] in reference_ids:
            fail()
        reference_ids.add(entry["reference_id"])
        url = entry["source_url"]
        if not isinstance(url, str) or url not in REFERENCE_METADATA or url in reference_urls:
            fail()
        reference_urls.add(url)
        if any(entry[name] != expected for name, expected in REFERENCE_METADATA[url].items()):
            fail()
        if (
            not isinstance(entry["source_url"], str)
            or not re.fullmatch(
                r"https://www\.bls\.gov/news\.release/archives/cpi_[0-9]{8}\.htm",
                entry["source_url"],
            )
            or not isinstance(entry["reference_period"], str)
            or not re.fullmatch(r"[0-9]{4}-(?:0[1-9]|1[0-2])", entry["reference_period"])
            or entry["reported_timezone"] != "ET"
            or entry["units"] != "percent_change_from_previous_month"
            or entry["acquisition_status"] != "web_reader_only"
            or entry["raw_sha256"] is not None
            or entry["raw_bytes"] is not None
            or entry["support_status"] != "reference_metadata_only_no_numeric_authority"
        ):
            fail()
        if timestamp(entry["reported_publication_utc"]).utcoffset().total_seconds() != 0:
            fail()
        text(entry["reported_value"], nonempty=True, limit=128)
        if not re.fullmatch(r"-?[0-9]+(?:\.[0-9]+)?", entry["reported_value"]):
            fail()
    failure = captured["acquisition_failure"]
    shape(failure, {"source_url", "retrieval_started_at", "http_status", "result"})
    if (
        failure["source_url"] not in {entry["source_url"] for entry in references}
        or type(failure["http_status"]) is not int
        or failure["http_status"] != 403
        or failure["result"] != "automatic_capture_unavailable_no_bypass"
    ):
        fail()
    if timestamp(failure["retrieval_started_at"]).utcoffset().total_seconds() != 0:
        fail()
    return captured


def validate_corpus(manifest, raw_bytes):
    """Verify declared capture consistency and bytes, retaining unknown vintage.

    This proves internal integrity against the supplied bytes. It cannot
    authenticate provider origin, retrieve missing archives or certify rights,
    historic availability, expert labels or research conclusions.
    """
    return _checked(lambda: _validate(manifest, raw_bytes))


def _pending(pending, manifest, raw_bytes):
    corpus = _validate(manifest, raw_bytes)
    table = _raw_table(raw_bytes)
    captured = bounded(pending)
    shape(
        captured,
        {
            "schema_version",
            "kind",
            "corpus_id",
            "manifest_sha256",
            "raw_sha256",
            "engineering_expectations",
            "expert_review",
            "pending_review_sha256",
        },
    )
    component(captured, "pending_review_sha256")
    if (
        type(captured["schema_version"]) is not int
        or captured["schema_version"] != 1
        or captured["kind"] != "public_source_pending_review"
        or captured["corpus_id"] != corpus["corpus_id"]
        or captured["manifest_sha256"] != corpus["manifest_sha256"]
        or captured["raw_sha256"] != table["source_raw_sha256"]
    ):
        fail()
    expectations = captured["engineering_expectations"]
    shape(
        expectations,
        {
            "provenance",
            "method_record",
            "series_count",
            "observation_count",
            "values_remain_decimal_strings",
            "selected_cells",
            "historical_reference_status",
            "historical_positive_numeric_case_count",
            "historical_vintage",
            "first_public_availability_status",
        },
    )
    text(expectations["method_record"], nonempty=True, limit=4096)
    integer(expectations["series_count"], low=1, high=2)
    integer(expectations["observation_count"], low=1, high=240)
    if (
        expectations["provenance"] != "engineering"
        or expectations["series_count"] != len(corpus["series"])
        or expectations["observation_count"] != len(table["rows"])
        or expectations["values_remain_decimal_strings"] is not True
        or type(expectations["historical_positive_numeric_case_count"]) is not int
        or expectations["historical_positive_numeric_case_count"] != 0
        or expectations["historical_reference_status"]
        != "reference_metadata_only_no_numeric_authority"
        or expectations["historical_vintage"] != "unknown"
        or expectations["first_public_availability_status"] != "unknown"
    ):
        fail()
    selected = expectations["selected_cells"]
    if not isinstance(selected, list) or len(selected) > len(table["rows"]):
        fail()
    witnesses = {
        (row["source_series_index"], row["source_observation_index"]): row for row in table["rows"]
    }
    seen = set()
    for cell in selected:
        shape(cell, {"series_id", "year", "period", "value", "series_index", "observation_index"})
        integer(cell["series_index"], high=1)
        integer(cell["observation_index"], high=119)
        key = (cell["series_index"], cell["observation_index"])
        if key in seen or key not in witnesses:
            fail()
        seen.add(key)
        row = witnesses[key]
        if any(cell[name] != row[name] for name in ("series_id", "year", "period", "value")):
            fail()
    expert = captured["expert_review"]
    shape(
        expert,
        {
            "status",
            "reviewer",
            "reviewed_at",
            "approved_claim_denominator",
            "dimensions",
            "labels",
            "instructions",
        },
    )
    if (
        expert["status"] != "PENDING"
        or expert["reviewer"] is not None
        or expert["reviewed_at"] is not None
        or type(expert["approved_claim_denominator"]) is not int
        or expert["approved_claim_denominator"] != 0
        or expert["dimensions"] != {name: "PENDING" for name in EXPERT_DIMENSIONS}
        or expert["labels"] != []
    ):
        fail()
    if not isinstance(expert["instructions"], list) or not 1 <= len(expert["instructions"]) <= 20:
        fail()
    for instruction in expert["instructions"]:
        text(instruction, nonempty=True, limit=4096)
    return captured


def validate_pending_review(pending, manifest, raw_bytes):
    """Bind unfilled review instructions and engineering cells to this corpus.

    Approved reviews require a separate future protocol; this pending package
    accepts no expert identity, labels, approval or historical numeric authority.
    """
    return _checked(lambda: _pending(pending, manifest, raw_bytes))
