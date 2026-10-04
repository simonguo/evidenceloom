"""Fictional saved-field reviews, independently calculated decimals and attacks."""

from copy import deepcopy
from decimal import Decimal, ROUND_HALF_UP, localcontext
import hashlib
import json
from pathlib import Path
from uuid import NAMESPACE_URL, uuid5

import pytest

from tradingagents.evidence import audit_citations, validate_evidence_bundle
from tradingagents.evidence.ledger import _timestamp
from tradingagents.memory.schema import hash_value, make_component
from tradingagents.research.numeric_decimal import decimal_parts, equal_decimal, round_saved_decimal
from tradingagents.research.numeric_review import (
    NUMERIC_REVIEW_POLICY,
    POLICY_SHA256,
    NumericReviewError,
    REPORT_SECTION_KEYS,
    derive_numeric_review,
    date_component,
    make_report_text_snapshot,
    parse_saved_numbers,
    validate_numeric_review,
    validate_numeric_reviews,
    validate_report_text_snapshot,
)
from tradingagents.research.numeric_spans import supported_numeric_span

FETCHED = "2026-01-09T10:00:00.000000Z"
CAPTURED = "2026-01-09T11:00:00.000000Z"
REVIEWED = "2026-01-09T12:00:00.000000Z"
RECORD_ID = "ev-" + "a" * 32
REPORT = (
    "研究📈\r\nFICT 2026-01-08 close 125.02\n"
    "OTHER 2026-01-09 USD 999.00\n"
    "Ties 1.01 2.68 -1.01 -2.68 carry 10.00 zero 0.00 scientific 100.00 large 1e127\n"
    "Unsupported 1125.02 -125.02 125.02e2 1,125.02 125.02M 125.02% −125.02\n"
    "CJK 收盘价125.02元 1万\n"
    f"Saved reference [E:{RECORD_ID}]"
)
TABLE = (
    '{"columns":["Date","Close","TieOne","TieTwo","NegativeOne","NegativeTwo",'
    '"Carry","Zero","Scientific","Large","Null","Boolean","String"],'
    '"rows":[["2026-01-08",125.02345678901236,1.005,2.675,-1.005,-2.675,'
    '9.995,-0.004,1e2,1e127,null,false,"1.005"],'
    '["2026-01-07",124.92345678901235,1,2,-1,-2,9,0,1,1,null,true,"2"]]}'
)
DECIMAL_VECTORS = [
    {"source": "1.005", "places": 2, "expected": "1.01"},
    {"source": "2.675", "places": 2, "expected": "2.68"},
    {"source": "-1.005", "places": 2, "expected": "-1.01"},
    {"source": "-2.675", "places": 2, "expected": "-2.68"},
    {"source": "9.995", "places": 2, "expected": "10.00"},
    {"source": "-0.004", "places": 2, "expected": "0.00"},
    {"source": "-0", "places": 0, "expected": "0"},
    {"source": "1e2", "places": 2, "expected": "100.00"},
    {"source": "1e-1024", "places": 18, "expected": "0.000000000000000000"},
    {"source": "1e127", "places": 18, "expected": "1" + "0" * 127 + "." + "0" * 18},
    {"source": "1e128", "places": 0, "expected": "1" + "0" * 128},
]
SPAN_VECTORS = [
    ("Close125.02", "125.02", True),
    ("收盘价125.02元", "125.02", True),
    ("125.02USD", "125.02", True),
    ("+125.02", "+125.02", True),
    ("1125.02", "125.02", False),
    ("-125.02", "125.02", False),
    ("125.02e2", "125.02", False),
    ("1,125.02", "125.02", False),
    ("125.02M", "125.02", False),
    ("125.02%", "125.02", False),
    ("−125.02", "125.02", False),
    ("Ⅻ,125.02", "125.02", False),
    ("1\u202f125.02", "125.02", False),
    ("1 Million", "1", False),
    ("1 MILLION", "1", False),
    ("1万", "1", False),
    (".5", "5", False),
    ("٫5", "5", False),
    ("．5", "5", False),
    ("1，125.02", "125.02", False),
    ("100％", "100", False),
    ("100٪", "100", False),
    ("100‱", "100", False),
    ("﹢125.02", "125.02", False),
    ("±125.02", "125.02", False),
    ("1萬", "1", False),
    ("1億", "1", False),
    ("收盘价，125.02元", "125.02", True),
]


def span(section, literal, *, occurrence=0):
    index = -1
    for _ in range(occurrence + 1):
        index = section.index(literal, index + 1)
    start = len(section[:index].encode("utf-8"))
    return {"start_byte": start, "end_byte": start + len(literal.encode()), "text": literal}


def fictional_evidence(payload=TABLE, *, status="available", withheld=False, units=None):
    artifact = {"kind": "normalized_data", "payload": payload}
    digest = hash_value(artifact)
    output = {"kind": "tool_text", "payload": f"[E:{RECORD_ID}]\nFictional saved table"}
    output_digest = hash_value(output)
    source = {
        "provider": "yfinance",
        "url": None,
        "observed_window": {"start": "2026-01-07", "end": "2026-01-08"},
        "publication_dates": None,
        "historical_availability": "withheld" if withheld else "unknown",
        "units": units,
        "adjustments": None,
        "transformations": ["Fictional offline table"],
        "data_sha256": None if withheld else digest,
    }
    artifacts = {output_digest: output}
    if not withheld:
        artifacts[digest] = artifact
    evidence = make_component(
        {
            "schema_version": 1,
            "run_id": "5c042f1b-67ff-4d37-8690-7d38afca64ff",
            "instrument": "FICT",
            "analysis_date": "2026-01-09",
            "research_as_of": "2026-01-09T23:59:59.999999Z",
            "as_of_policy": "analysis_date_end_utc",
            "market_timezone": None,
            "created_at": FETCHED,
            "manifest": {"analysts": ["market"]},
            "manifest_sha256": hash_value({"analysts": ["market"]}),
            "records": [
                {
                    "id": RECORD_ID,
                    "analyst": "market",
                    "tool": "get_stock_data",
                    "instrument": "FICT",
                    "parameters": {"symbol": "FICT"},
                    "status": status,
                    "fetched_at": FETCHED,
                    "output_sha256": output_digest,
                    "sources": [source],
                    "attempts": [],
                }
            ],
            "artifacts": artifacts,
            "citation_audit": {},
        },
        "bundle_sha256",
    )
    return validate_evidence_bundle(evidence)


def scenario(*, payload=TABLE, report=REPORT, status="available", withheld=False, units=None):
    evidence = fictional_evidence(payload, status=status, withheld=withheld, units=units)
    sections = {key: None for key in REPORT_SECTION_KEYS}
    sections["market_report"] = report
    evidence = audit_citations(evidence, sections)
    snapshot = make_report_text_snapshot(evidence, sections, captured_at=CAPTURED)
    request = {
        "review_id": str(uuid5(NAMESPACE_URL, "fictional numeric review")),
        "reviewed_at": REVIEWED,
        "previous_review_sha256": None,
        "target": {
            "task_id": "task-fictional",
            "version_id": "version-fictional",
            "run_id": snapshot["run_id"],
            "report_snapshot_sha256": snapshot["snapshot_sha256"],
            "section_key": "market_report",
            "section_utf8_sha256": hashlib.sha256(report.encode()).hexdigest(),
        },
        "numeric_span": span(report, "125.02"),
        "operand": {
            "evidence_id": RECORD_ID,
            "source_index": 0,
            "selector": {
                "kind": "table_cell",
                "table_path": [],
                "row_date": "2026-01-08",
                "field": "Close",
            },
        },
        "rounding": {"mode": "saved_decimal_half_up", "places": 2},
        "context_bindings": {"instrument": None, "row_date": None, "units": None},
    }
    return evidence, snapshot, request


def test_policy_is_exact_normative_json():
    policy = json.loads(
        (Path(__file__).parents[1] / "docs/contracts/numeric_review_policy_v1.json").read_bytes()
    )
    assert policy == NUMERIC_REVIEW_POLICY
    assert hash_value(policy) == POLICY_SHA256


@pytest.mark.parametrize("vector", DECIMAL_VECTORS)
def test_decimal_half_up_independent_reference(vector):
    with localcontext() as context:
        context.prec = 1300
        expected = Decimal(vector["source"]).quantize(
            Decimal(1).scaleb(-vector["places"]), rounding=ROUND_HALF_UP
        )
        if expected == 0:
            expected = abs(expected)
        assert format(expected, "f") == vector["expected"]
    assert round_saved_decimal(vector["source"], vector["places"]) == vector["expected"]
    if vector["source"] in {"1e127", "1e128"}:
        assert equal_decimal(vector["source"], vector["expected"])
    assert round(2.675, 2) == 2.67  # forbidden float path is observably different


@pytest.mark.parametrize(
    "unsupported", ["NaN", "Infinity", "01", "1,005", "1e1025", "1e-1025", "1." + "0" * 128]
)
def test_decimal_supported_bounds(unsupported):
    assert decimal_parts(unsupported) is None


@pytest.mark.parametrize("section,literal,expected", SPAN_VECTORS)
def test_exact_whole_number_boundaries(section, literal, expected):
    assert supported_numeric_span(section, span(section, literal)) is expected


def test_unicode_crlf_raw_authority_and_scope():
    evidence, snapshot, request = scenario()
    assert request["numeric_span"] == {"start_byte": 34, "end_byte": 40, "text": "125.02"}
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["status"] == "match"
    assert review["operand"]["raw_number_lexeme"] == "125.02345678901236"
    assert review["result"]["source_context"]["units"] is None
    assert review["result"]["unreviewed_dimensions"] == [
        *NUMERIC_REVIEW_POLICY["unreviewed_dimensions"],
        "instrument",
        "row_date",
        "units",
    ]
    assert snapshot["report_sections"]["market_report"] == REPORT
    assert (
        validate_numeric_review(
            review, snapshot, evidence, task_id="task-fictional", version_id="version-fictional"
        )
        == review
    )


@pytest.mark.parametrize(
    "field,literal",
    [
        ("TieOne", "1.01"),
        ("TieTwo", "2.68"),
        ("NegativeOne", "-1.01"),
        ("NegativeTwo", "-2.68"),
        ("Carry", "10.00"),
        ("Zero", "0.00"),
        ("Scientific", "100.00"),
        ("Large", "1e127"),
    ],
)
def test_saved_exact_lexemes_and_large_expansion(field, literal):
    evidence, snapshot, request = scenario()
    request["numeric_span"] = span(REPORT, literal, occurrence=1 if field == "Zero" else 0)
    request["operand"]["selector"]["field"] = field
    if field == "Large":
        request["rounding"]["places"] = 18
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["status"] == "match"
    assert review["result"]["reason"] == "value_match"


def test_context_picker_does_not_verify_report_and_explicit_disagreements_win():
    evidence, snapshot, request = scenario()
    request["numeric_span"] = span(REPORT, "999.00")
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["reason"] == "value_mismatch"
    request["context_bindings"] = {
        "instrument": span(REPORT, "OTHER"),
        "row_date": span(REPORT, "2026-01-09"),
        "units": span(REPORT, "USD"),
    }
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["reason"] == "context_mismatch"
    assert review["result"]["context_results"] == {
        "instrument": "mismatch",
        "row_date": "mismatch",
        "units": "missing",
    }
    request["context_bindings"] = {
        "instrument": None,
        "row_date": None,
        "units": span(REPORT, "USD"),
    }
    assert (
        derive_numeric_review(snapshot, evidence, request)["result"]["reason"] == "value_mismatch"
    )
    request["numeric_span"] = span(REPORT, "125.02")
    assert (
        derive_numeric_review(snapshot, evidence, request)["result"]["reason"] == "context_missing"
    )


def test_exact_context_literals_and_partial_words():
    evidence, snapshot, request = scenario(units="USD")
    request["context_bindings"] = {
        "instrument": span(REPORT, "FICT"),
        "row_date": span(REPORT, "2026-01-08"),
        "units": span(REPORT, "USD"),
    }
    result = derive_numeric_review(snapshot, evidence, request)["result"]
    assert result["context_results"] == {
        "instrument": "match",
        "row_date": "match",
        "units": "match",
    }
    evidence, snapshot, request = scenario(report="FICTOTHER 125.02")
    request["context_bindings"]["instrument"] = span("FICTOTHER 125.02", "FICT")
    assert (
        derive_numeric_review(snapshot, evidence, request)["result"]["context_results"][
            "instrument"
        ]
        == "missing"
    )


@pytest.mark.parametrize("field", ["Null", "Boolean", "String"])
def test_null_boolean_numeric_strings_do_not_become_zero(field):
    evidence, snapshot, request = scenario()
    request["operand"]["selector"]["field"] = field
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["reason"] == "field_not_numeric"
    assert review["operand"]["raw_number_lexeme"] is None


@pytest.mark.parametrize(
    "payload,reason",
    [
        ('{"other":1}', "table_missing"),
        ('{"columns":["Date","Close","Close"],"rows":[["2026-01-08",1,2]]}', "table_ambiguous"),
        (
            '{"columns":["Date","Close"],"rows":[["2026-01-08",1],["2026-01-08",2]]}',
            "row_ambiguous",
        ),
        ('{"columns":["Date","Open"],"rows":[["2026-01-08",1]]}', "field_missing"),
        ('{"columns":["Date","Close"],"rows":[["2026-01-07",1]]}', "row_missing"),
        ('{"columns":["Date","Close"],"rows":[["2026-01-08",1,2]]}', "table_missing"),
    ],
)
def test_missing_and_ambiguous_tables_are_valid_receipts(payload, reason):
    evidence, snapshot, request = scenario(payload=payload)
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["status"] == "missing" and review["result"]["reason"] == reason
    assert validate_numeric_review(review, snapshot, evidence) == review


@pytest.mark.parametrize(
    "status,withheld,reason",
    [("unavailable", False, "source_unavailable"), ("withheld", True, "source_withheld")],
)
def test_unavailable_and_withheld_sources_cannot_supply_price(status, withheld, reason):
    evidence, snapshot, request = scenario(status=status, withheld=withheld)
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["reason"] == reason
    assert review["operand"]["raw_number_lexeme"] is None
    assert review["result"]["source_context"]["row_date"] is None


def test_rehashed_false_match_and_bindings_cannot_pass():
    evidence, snapshot, request = scenario()
    review = derive_numeric_review(snapshot, evidence, request)
    for mutation in (
        lambda r: r["result"].update(rounded_decimal="999.00"),
        lambda r: r["operand"].update(raw_number_lexeme="125.02"),
        lambda r: r["operand"].update(provider="tencent"),
        lambda r: r["operand"].update(data_sha256=evidence["records"][0]["output_sha256"]),
        lambda r: r["target"].update(report_snapshot_sha256="f" * 64),
        lambda r: r["numeric_span"].update(text="999.00"),
        lambda r: r.update(schema_version=True),
    ):
        attack = deepcopy(review)
        mutation(attack)
        attack = make_component(attack, "review_sha256")
        with pytest.raises(NumericReviewError):
            validate_numeric_review(attack, snapshot, evidence)
    with pytest.raises(NumericReviewError):
        validate_numeric_review(review, snapshot, evidence, version_id="another-version")


def test_invalid_utf8_boundary_and_lossless_duplicate_keys():
    evidence, snapshot, request = scenario()
    request["numeric_span"] = {"start_byte": 1, "end_byte": 3, "text": "研"}
    with pytest.raises(NumericReviewError):
        derive_numeric_review(snapshot, evidence, request)
    with pytest.raises(NumericReviewError):
        parse_saved_numbers('{"x":1,"x":2}')
    assert parse_saved_numbers("[1.005,1e2,-0]") == ["1.005", "1e2", "-0"]


def test_snapshot_temporal_hash_safety_and_valid_legacy_evidence_clocks():
    evidence, snapshot, _ = scenario()
    evidence["created_at"] = "2026-01-09T10:00:00Z"
    evidence["records"][0]["fetched_at"] = "2026-01-09T10:00:00.1Z"
    evidence = make_component(evidence, "bundle_sha256")
    assert make_report_text_snapshot(evidence, snapshot["report_sections"], captured_at=CAPTURED)
    with pytest.raises(NumericReviewError):
        make_report_text_snapshot(evidence, snapshot["report_sections"], captured_at=FETCHED)
    for text in ("\ud800", "token=secret-test-value", "https://internal.local/private"):
        sections = deepcopy(snapshot["report_sections"])
        sections["market_report"] = text
        with pytest.raises(NumericReviewError):
            make_report_text_snapshot(evidence, sections, captured_at=CAPTURED)
    changed = deepcopy(snapshot)
    changed["report_sections"]["market_report"] += "\nEdited without updating hash"
    with pytest.raises(NumericReviewError):
        validate_report_text_snapshot(changed, fictional_evidence())


def test_append_history_parent_uuid_and_time_are_bound():
    evidence, snapshot, request = scenario()
    first = derive_numeric_review(snapshot, evidence, request)
    request["previous_review_sha256"] = first["review_sha256"]
    request["review_id"] = str(uuid5(NAMESPACE_URL, "second numeric review"))
    second = derive_numeric_review(snapshot, evidence, request)
    assert validate_numeric_reviews(
        [first, second],
        snapshot,
        evidence,
        task_id="task-fictional",
        version_id="version-fictional",
    ) == [first, second]
    for invalid in ([second], [first, first], [second, first]):
        with pytest.raises(NumericReviewError):
            validate_numeric_reviews(
                invalid,
                snapshot,
                evidence,
                task_id="task-fictional",
                version_id="version-fictional",
            )


@pytest.mark.parametrize("fraction", ["", ".1", ".12", ".123", ".1234", ".12345", ".123456"])
def test_valid_evidence_clock_precision_is_preserved(fraction):
    stamp = "2026-01-09T10:00:00" + fraction + "Z"
    evidence, _, _ = scenario()
    evidence["created_at"] = stamp
    evidence["records"][0]["fetched_at"] = stamp
    evidence = make_component(evidence, "bundle_sha256")
    assert validate_evidence_bundle(evidence)["created_at"] == stamp
    assert _timestamp(stamp).microsecond == int(fraction[1:].ljust(6, "0") or "0")


@pytest.mark.parametrize("path", [["latest_ohlcv"], ["recent_closes"]])
def test_only_frozen_table_paths_select_saved_cells(path):
    evidence, snapshot, request = scenario(payload='{"' + path[0] + '":' + TABLE + "}")
    request["operand"]["selector"]["table_path"] = path
    assert derive_numeric_review(snapshot, evidence, request)["result"]["status"] == "match"


@pytest.mark.parametrize("digits", range(1, 10))
def test_original_date_fraction_precision_is_not_rewritten(digits):
    label = "2026-01-08T00:00:00." + "123456789"[:digits] + "+14:00"
    assert date_component(label) == "2026-01-08"
    payload = TABLE.replace('"2026-01-08"', json.dumps(label))
    evidence, snapshot, request = scenario(payload=payload)
    request["operand"]["selector"]["row_date"] = label
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["source_context"]["row_date"] == label
    assert review["result"]["status"] == "match"


@pytest.mark.parametrize(
    "label,expected",
    [
        ("2026-01-08 00:00:00-14:00", "2026-01-08"),
        ("2026-01-08T00:00:00+14:01", None),
        ("2026-01-08T00:00:00+15:00", None),
        ("2026-01-08T00:00:00-00:00", None),
        ("2026-01-08T24:00:00Z", None),
        ("2026-02-30", None),
        ("2026-01-08T00:00", None),
    ],
)
def test_date_label_bounds(label, expected):
    assert date_component(label) == expected


def test_missing_saved_artifact_null_is_normal_broken_reference_is_invalid():
    evidence, snapshot, request = scenario()
    source = evidence["records"][0]["sources"][0]
    del evidence["artifacts"][source["data_sha256"]]
    source["data_sha256"] = None
    evidence = make_component(evidence, "bundle_sha256")
    snapshot = make_report_text_snapshot(
        evidence, snapshot["report_sections"], captured_at=CAPTURED
    )
    request["target"]["report_snapshot_sha256"] = snapshot["snapshot_sha256"]
    review = derive_numeric_review(snapshot, evidence, request)
    assert review["result"]["reason"] == "table_missing"
    assert review["operand"]["data_sha256"] is None
    evidence["records"][0]["sources"][0]["data_sha256"] = "f" * 64
    evidence = make_component(evidence, "bundle_sha256")
    with pytest.raises(NumericReviewError):
        derive_numeric_review(snapshot, evidence, request)


def write_fixture():
    """Regenerate only fictional offline shared fixtures (never during tests)."""
    evidence, snapshot, request = scenario()
    reviews = []
    for name, literal, field in (
        ("match", "125.02", "Close"),
        ("mismatch", "999.00", "Close"),
        ("half_up", "1.01", "TieOne"),
        ("negative", "-2.68", "NegativeTwo"),
    ):
        item = deepcopy(request)
        item["review_id"] = str(uuid5(NAMESPACE_URL, name))
        item["previous_review_sha256"] = reviews[-1]["review_sha256"] if reviews else None
        item["numeric_span"] = span(REPORT, literal)
        item["operand"]["selector"]["field"] = field
        reviews.append(derive_numeric_review(snapshot, evidence, item))
    cases = []
    for name, options, changes in (
        (
            "context_mismatch",
            {},
            {"contexts": {"instrument": "OTHER", "row_date": "2026-01-09", "units": "USD"}},
        ),
        ("unknown_units", {}, {"contexts": {"units": "USD"}}),
        ("partial_numeric", {}, {"selection": "125.02M", "selected": "125.02"}),
        ("null_cell", {}, {"field": "Null"}),
        ("withheld", {"status": "withheld", "withheld": True}, {}),
        ("unavailable", {"status": "unavailable"}, {}),
        (
            "duplicate_rows",
            {"payload": '{"columns":["Date","Close"],"rows":[["2026-01-08",1],["2026-01-08",2]]}'},
            {},
        ),
        (
            "duplicate_columns",
            {"payload": '{"columns":["Date","Close","Close"],"rows":[["2026-01-08",1,2]]}'},
            {},
        ),
    ):
        case_evidence, case_snapshot, item = scenario(**options)
        item["review_id"] = str(uuid5(NAMESPACE_URL, name))
        if "contexts" in changes:
            for key, literal in changes["contexts"].items():
                item["context_bindings"][key] = span(REPORT, literal)
        if "selection" in changes:
            outer = span(REPORT, changes["selection"])
            item["numeric_span"] = {
                "start_byte": outer["start_byte"],
                "end_byte": outer["start_byte"] + len(changes["selected"].encode()),
                "text": changes["selected"],
            }
        if "field" in changes:
            item["operand"]["selector"]["field"] = changes["field"]
        cases.append(
            {
                "name": name,
                "evidence": case_evidence,
                "snapshot": case_snapshot,
                "request": item,
                "review": derive_numeric_review(case_snapshot, case_evidence, item),
            }
        )
    fixture = {
        "schema_version": 1,
        "fictional": True,
        "policy": NUMERIC_REVIEW_POLICY,
        "policy_sha256": POLICY_SHA256,
        "evidence": evidence,
        "snapshot": snapshot,
        "reviews": reviews,
        "decimal_vectors": DECIMAL_VECTORS,
        "span_vectors": [
            {"section": text, "span": span(text, literal), "supported": expected}
            for text, literal, expected in SPAN_VECTORS
        ],
        "cases": cases,
        "invalid_mutations": [
            "rehashed_false_match",
            "wrong_data_sha256",
            "cross_record_source_index",
            "wrong_span_text",
            "split_utf8_boundary",
            "wrong_snapshot_sha256",
            "duplicate_json_key",
        ],
    }
    path = Path(__file__).parent / "fixtures/numeric_review_v1.json"
    path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def test_shared_fixture_rederives_exact_receipts():
    fixture = json.loads((Path(__file__).parent / "fixtures/numeric_review_v1.json").read_bytes())
    assert (
        validate_report_text_snapshot(fixture["snapshot"], fixture["evidence"])
        == fixture["snapshot"]
    )
    assert (
        validate_numeric_reviews(
            fixture["reviews"],
            fixture["snapshot"],
            fixture["evidence"],
            task_id="task-fictional",
            version_id="version-fictional",
        )
        == fixture["reviews"]
    )
    for case in fixture["cases"]:
        assert (
            derive_numeric_review(case["snapshot"], case["evidence"], case["request"])
            == case["review"]
        )
        assert (
            validate_numeric_review(case["review"], case["snapshot"], case["evidence"])
            == case["review"]
        )
