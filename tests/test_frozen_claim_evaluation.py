"""Owned fictional claims, independent arithmetic, and public boundary attacks."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from decimal import Decimal, ROUND_HALF_UP, localcontext
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from tradingagents.evaluation import (
    evaluate_file,
    evaluate_pack,
    validate_evaluation_result,
    validate_pack,
)
from tradingagents.evaluation.io import write_result
from tradingagents.evaluation.oracle import exact_price_change_percent
from tradingagents.evidence import audit_citations
from tradingagents.memory.schema import hash_value, make_component
from tradingagents.research.numeric_review import derive_numeric_review

ROOT = Path(__file__).parents[1]
FIXTURE = ROOT / "tests/fixtures/frozen_claims/pack_v1.json"
CLI = ROOT / "scripts/evaluate_frozen_research.py"
EXPECTED = [
    ["MATCH", "MISMATCH"],
    ["MATCH", "MISMATCH"],
    ["MATCH"],
    ["MISMATCH"],
    ["MISSING", "MISSING", "MISSING"],
    ["MISSING"],
    ["MISSING"],
    ["MISSING"],
    ["MANUAL", "MANUAL"],
    ["MANUAL"],
    ["UNKNOWN_LEGACY"],
]


def owned_pack():
    return json.loads(FIXTURE.read_bytes())


def rehash(pack):
    retained_cases = {}
    for case in pack["cases"]:
        for index, claim in enumerate(case["claims"]):
            case["claims"][index] = make_component(claim, "claim_sha256")
        case["report_sha256"] = hash_value(case["research_report"])
        case.update(make_component(case, "case_sha256"))
        retained_cases[case["case_id"]] = case
    labels = []
    for label_set in pack["label_sets"]:
        case = retained_cases.get(label_set["case_id"])
        if case is None:
            continue
        claims = {claim["claim_id"]: claim for claim in case["claims"] if "claim_id" in claim}
        label_set["case_sha256"] = case["case_sha256"]
        label_set["labels"] = [
            {**label, "claim_sha256": claims[label["claim_id"]]["claim_sha256"]}
            for label in label_set["labels"]
            if label["claim_id"] in claims
        ]
        if label_set["labels"]:
            labels.append(make_component(label_set, "label_set_sha256"))
    pack["label_sets"] = labels
    return make_component(pack, "pack_sha256")


def bind_saved_operands(pack):
    for case in pack["cases"]:
        evidence = case["research_report"]["evidence_bundle"]
        if evidence is None:
            continue
        records = {record["id"]: record for record in evidence["records"]}
        for claim in case["claims"]:
            selection = claim["selection"]
            for operand in selection.get("operands", [selection.get("operand")]):
                if operand is not None:
                    source = records[operand["evidence_id"]]["sources"][operand["source_index"]]
                    for key in ("provider", "data_sha256", "units", "adjustments"):
                        operand[key] = source[key]
    return pack


def case_pack(case_id, claim_index=0):
    pack = owned_pack()
    case = next(case for case in pack["cases"] if case["case_id"] == case_id)
    case["claims"] = [case["claims"][claim_index]]
    pack["cases"] = [case]
    return rehash(pack)


def claim_result(pack):
    return evaluate_pack(rehash(pack))["cases"][0]["claims"][0]


def raw_span(text, literal, occurrence=0):
    start = -1
    for _ in range(occurrence + 1):
        start = text.index(literal, start + 1)
    offset = len(text[:start].encode("utf-8"))
    return {"start_byte": offset, "end_byte": offset + len(literal.encode()), "text": literal}


def refresh_owner(pack):
    """Recompute hashes independently after a deliberate semantic mutation."""
    for case in pack["cases"]:
        envelope = case["research_report"]
        report = envelope["report"]
        evidence = envelope["evidence_bundle"]
        if evidence is not None:
            envelope["evidence_bundle"] = audit_citations(evidence, report["reportSections"])
        snapshot = envelope["report_text_snapshot"]
        if snapshot is not None:
            snapshot["report_sections"] = deepcopy(report["reportSections"])
            snapshot["evidence_bundle_sha256"] = envelope["evidence_bundle"]["bundle_sha256"]
            envelope["report_text_snapshot"] = make_component(snapshot, "snapshot_sha256")
        for claim in case["claims"]:
            claim["target"]["report_snapshot_sha256"] = (
                envelope["report_text_snapshot"]["snapshot_sha256"] if snapshot else None
            )
            text = report["reportSections"][claim["target"]["section_key"]]
            claim["target"]["section_utf8_sha256"] = hashlib.sha256(text.encode()).hexdigest()
    return rehash(pack)


def replace_table(pack, payload):
    envelope = pack["cases"][0]["research_report"]
    evidence = envelope["evidence_bundle"]
    source = evidence["records"][0]["sources"][0]
    old = source["data_sha256"]
    artifact = {"kind": "normalized_data", "payload": payload}
    digest = hash_value(artifact)
    del evidence["artifacts"][old]
    evidence["artifacts"][digest] = artifact
    source["data_sha256"] = digest
    envelope["evidence_bundle"] = make_component(evidence, "bundle_sha256")
    return refresh_owner(bind_saved_operands(pack))


def replace_text(pack, text, literal):
    case = pack["cases"][0]
    case["research_report"]["report"]["reportSections"]["market_report"] = text
    case["claims"][0]["span"] = raw_span(text, literal)
    return refresh_owner(pack)


def decimal_reference(start, end, places):
    with localcontext() as context:
        context.prec = 6000
        expected = ((Decimal(end) - Decimal(start)) / Decimal(start) * Decimal(100)).quantize(
            Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP
        )
        if expected == 0:
            expected = abs(expected)
        return format(expected, "f")


def test_owned_frozen_pack_denominator_and_original_bytes():
    pack = owned_pack()
    before = deepcopy(pack)
    assert validate_pack(pack) == pack
    result = evaluate_pack(pack)
    assert pack == before
    assert validate_evaluation_result(result, pack) == result
    assert len(pack["cases"]) == 11
    assert [[claim["status"] for claim in case["claims"]] for case in result["cases"]] == EXPECTED
    assert result["summary"]["denominator"] == 16
    assert result["summary"]["counts"] == {
        "MATCH": 3,
        "MISMATCH": 3,
        "MISSING": 6,
        "MANUAL": 3,
        "UNKNOWN_LEGACY": 1,
    }
    assert result["summary"]["arithmetic_comparable_count"] == 6
    assert result["summary"]["expert_status"] == "NOT_EVALUATED"
    assert result["summary"]["strata"] == {
        "engineering": {
            "annotated_claim_denominator": 16,
            "labels_present": 16,
            "agreement": 16,
            "disagreement": 0,
            "unlabeled": 0,
        },
        "independent_arithmetic": {
            "annotated_claim_denominator": 16,
            "labels_present": 6,
            "agreement": 6,
            "disagreement": 0,
            "unlabeled": 10,
        },
    }
    assert result["summary"]["external_expert"] == {
        "approved_claim_denominator": 0,
        "dimensions": {
            "semantic_support": "NOT_EVALUATED",
            "temporal_validity": "NOT_EVALUATED",
            "inference_classification": "NOT_EVALUATED",
            "abstention_appropriateness": "NOT_EVALUATED",
        },
    }
    for original, evaluated in zip(pack["cases"], result["cases"]):
        assert evaluated["case_id"] == original["case_id"]
        assert evaluated["research_report_sha256"] == hash_value(original["research_report"])
        for claim, output in zip(original["claims"], evaluated["claims"]):
            assert output["claim_id"] == claim["claim_id"]
            assert output["target"] == claim["target"]
            assert output["span"] == claim["span"]
            raw = original["research_report"]["report"]["reportSections"][
                claim["target"]["section_key"]
            ].encode()
            assert (
                raw[claim["span"]["start_byte"] : claim["span"]["end_byte"]]
                == claim["span"]["text"].encode()
            )
        assert all(
            "📈" in text and "\r\n" in text
            for text in original["research_report"]["report"]["reportSections"].values()
        )


@pytest.mark.parametrize(
    "start,end,places,hand_expected",
    [
        ("100", "101.005", 2, "1.01"),
        ("100", "102.675", 2, "2.68"),
        ("100", "98.995", 2, "-1.01"),
        ("100", "97.325", 2, "-2.68"),
        ("100", "99.999", 2, "0.00"),
        ("1", "1", 18, "0.000000000000000000"),
        ("1", "1.00000000000000000001", 18, "0.000000000000000001"),
        ("1e1024", "2e1024", 2, "100.00"),
        ("1e-1024", "2e-1024", 2, "100.00"),
        ("9007199254740993", "9007199254740994", 18, None),
        ("1e-1024", "1e1024", 18, None),
        ("9.999999999999999999", "10", 18, None),
    ],
)
def test_percent_oracle_independent_decimal_6000_precision(start, end, places, hand_expected):
    expected = decimal_reference(start, end, places)
    if hand_expected is not None:
        assert expected == hand_expected
    assert exact_price_change_percent(start, end, places) == expected


@pytest.mark.parametrize(
    "start,end,places",
    [
        ("0", "1", 2),
        ("-1", "1", 2),
        ("1", "0", 2),
        ("1", "-1", 2),
        ("true", "1", 2),
        (True, "1", 2),
        ("1", "NaN", 2),
        ("1", "Infinity", 2),
        ("01", "1", 2),
        ("1", "1,000", 2),
        ("1e1025", "2", 2),
        ("1e-1025", "2", 2),
        ("1." + "1" * 128, "2", 2),
        ("1", "2", -1),
        ("1", "2", 19),
        ("1", "2", True),
    ],
)
def test_percent_oracle_never_coerces_invalid_decimal_or_precision(start, end, places):
    assert exact_price_change_percent(start, end, places) is None


def test_unknown_currency_basis_and_expert_stay_unestablished_after_arithmetic_match():
    result = evaluate_pack(case_pack("unknown_context"))
    claim = result["cases"][0]["claims"][0]
    assert claim["status"] == "MATCH"
    assert result["summary"]["expert_status"] == "NOT_EVALUATED"
    witness = claim["witness"]
    assert witness is not None
    assert witness["context_results"]["units"] == "unknown"
    assert witness["context_results"]["basis"] == "unknown"
    assert witness["source_context"]["units"] is None
    assert witness["source_context"]["adjustments"] is None
    assert witness["temporal_scope"]["exchange_calendar_verified"] is False
    assert witness["temporal_scope"]["historical_vintage_verified"] is False
    assert "source_reliability" in witness["unreviewed_dimensions"]
    assert "historical_vintage" in witness["unreviewed_dimensions"]


def test_numeric_v1_single_field_percent_remains_manual_and_forecast_is_not_fact():
    pack = case_pack("manual_forms")
    case = pack["cases"][0]
    claim = case["claims"][0]
    envelope = case["research_report"]
    request = {
        "review_id": "33333333-3333-4333-8333-333333333333",
        "reviewed_at": "2026-01-09T12:00:00.000000Z",
        "previous_review_sha256": None,
        "target": claim["target"],
        "numeric_span": claim["span"],
        **claim["selection"],
    }
    request["operand"] = {
        key: request["operand"][key] for key in ("evidence_id", "source_index", "selector")
    }
    review = derive_numeric_review(
        envelope["report_text_snapshot"], envelope["evidence_bundle"], request
    )
    assert review["result"]["status"] == "manual_inference"
    assert claim_result(pack)["status"] == "MANUAL"
    prediction = claim_result(case_pack("prediction"))
    assert prediction["status"] == "MANUAL"
    assert prediction["witness"]["usage"] == "prediction"
    assert prediction["witness"]["baseline"]["status"] == "MATCH"
    assert prediction["witness"]["baseline"]["review"]["result"]["status"] == "match"


@pytest.mark.parametrize(
    "text,literal",
    [
        ("研究📈\r\nChange 11.01%", "1.01%"),
        ("研究📈\r\nChange -1.01%", "1.01%"),
        ("研究📈\r\nChange +1.01%", "1.01%"),
        ("研究📈\r\nChange 1,001.01%", "1.01%"),
        ("研究📈\r\nChange 1.01e2%", "1.01"),
        ("研究📈\r\nChange 1.01％", "1.01％"),
        ("研究📈\r\nChange 1.01٪", "1.01٪"),
        ("研究📈\r\nChange 1.01%%", "1.01%"),
        ("研究📈\r\nChange 1.01%％", "1.01%"),
        ("研究📈\r\nChange 1.01%M", "1.01%"),
        ("研究📈\r\nChange 1.01% million", "1.01%"),
        ("研究📈\r\nChange 1.01%万", "1.01%"),
    ],
)
def test_percent_partial_group_exponent_localized_and_repeated_suffixes_manual(text, literal):
    pack = replace_text(case_pack("percent_baseline"), text, literal)
    assert claim_result(pack)["status"] == "MANUAL"


@pytest.mark.parametrize(
    "payload",
    [
        '{"columns":["Date","Close","Close"],"rows":[["2026-01-07",100,100],["2026-01-08",101.005,101.005]]}',
        '{"columns":["Date","Close"],"rows":[["2026-01-07",100],["2026-01-07",100],["2026-01-08",101.005]]}',
        '{"columns":["Date","Open"],"rows":[["2026-01-07",100],["2026-01-08",101.005]]}',
        '{"columns":["Date","Close"],"rows":[["2026-01-08",101.005]]}',
        '{"columns":["Date","Close"],"rows":[["2026-01-07",null],["2026-01-08",101.005]]}',
        '{"columns":["Date","Close"],"rows":[["2026-01-07",true],["2026-01-08",101.005]]}',
        '{"columns":["Date","Close"],"rows":[["2026-01-07","100"],["2026-01-08",101.005]]}',
    ],
)
def test_percent_missing_ambiguous_and_non_numeric_rows_stay_in_denominator(payload):
    result = evaluate_pack(replace_table(case_pack("percent_baseline"), payload))
    assert result["summary"]["denominator"] == 1
    assert result["summary"]["counts"]["MISSING"] == 1
    assert result["cases"][0]["claims"][0]["status"] == "MISSING"


@pytest.mark.parametrize("row_date", ["2026-01-06", "2026-01-10"])
def test_percent_present_row_outside_observed_window_or_future_is_missing(row_date):
    pack = case_pack("percent_baseline")
    payload = f'{{"columns":["Date","Close"],"rows":[["2026-01-07",100],["{row_date}",101.005]]}}'
    pack = replace_table(pack, payload)
    operands = pack["cases"][0]["claims"][0]["selection"]["operands"]
    if row_date < "2026-01-07":
        operands[0]["selector"]["row_date"] = row_date
        operands[1]["selector"]["row_date"] = "2026-01-07"
    else:
        operands[1]["selector"]["row_date"] = row_date
    assert claim_result(pack)["status"] == "MISSING"


@pytest.mark.parametrize(
    "attack", ["task", "version", "run", "snapshot", "section", "utf8", "offset"]
)
def test_claim_owner_and_utf8_authority_reject_coherently_rehashed_attack(attack):
    pack = case_pack("field_baseline")
    claim = pack["cases"][0]["claims"][0]
    if attack == "task":
        claim["target"]["task_id"] += "-different"
    if attack == "version":
        claim["target"]["version_id"] += "-different"
    if attack == "run":
        claim["target"]["run_id"] = "22222222-2222-4222-8222-222222222222"
    if attack == "snapshot":
        claim["target"]["report_snapshot_sha256"] = "f" * 64
    if attack == "section":
        claim["target"]["section_key"] = "final_trade_decision"
    if attack == "utf8":
        claim["target"]["section_utf8_sha256"] = "f" * 64
    if attack == "offset":
        claim["span"]["start_byte"] -= 1
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


@pytest.mark.parametrize(
    "attack",
    [
        "report_run",
        "report_ticker",
        "report_date",
        "report_sections",
        "present_null",
        "legacy_disguise",
    ],
)
def test_full_report_saved_owner_fields_and_genuine_absence_gate(attack):
    pack = case_pack("field_baseline")
    envelope = pack["cases"][0]["research_report"]
    if attack == "report_run":
        envelope["report"]["runId"] = "22222222-2222-4222-8222-222222222222"
    if attack == "report_ticker":
        envelope["report"]["task"]["ticker"] = "OTHER"
    if attack == "report_date":
        envelope["report"]["task"]["analysisDate"] = "2026-01-08"
    if attack == "report_sections":
        envelope["report"]["reportSections"]["market_report"] += "changed"
    if attack == "present_null":
        envelope["report_text_snapshot"] = {"schema_version": None}
    if attack == "legacy_disguise":
        envelope["report"]["legacy"] = True
        envelope["report"]["runId"] = "legacy-run-" + envelope["report"]["task_id"]
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


def test_legacy_flag_does_not_discard_present_saved_authority():
    pack = case_pack("field_baseline")
    pack["cases"][0]["research_report"]["report"]["legacy"] = True
    assert claim_result(pack)["status"] == "MATCH"


@pytest.mark.parametrize("legacy_run", [None, "opaque-owned-historical-run", "absent"])
def test_genuine_legacy_missing_or_opaque_run_and_optional_name_preserved(legacy_run):
    pack = case_pack("legacy")
    case = pack["cases"][0]
    report = case["research_report"]["report"]
    if legacy_run == "absent":
        del report["runId"]
    else:
        report["runId"] = legacy_run
    del report["task"]["instrumentName"]
    case["claims"][0]["target"]["run_id"] = None if legacy_run == "absent" else legacy_run
    pack = rehash(pack)
    original = deepcopy(pack)
    result = evaluate_pack(pack)
    assert pack == original
    assert result["cases"][0]["claims"][0]["status"] == "UNKNOWN_LEGACY"
    assert result["cases"][0]["research_report_sha256"] == hash_value(case["research_report"])
    assert "instrumentName" not in pack["cases"][0]["research_report"]["report"]["task"]


def test_optional_null_name_and_partial_null_run_metadata_preserve_real_report_fields():
    pack = case_pack("field_baseline")
    report = pack["cases"][0]["research_report"]["report"]
    report["task"]["instrumentName"] = None
    report["run"] = {
        "appVersion": None,
        "coreVersion": "fictional",
        "llmProvider": None,
        "maxDebateRounds": None,
        "runtimeRunSettings": None,
    }
    pack = rehash(pack)
    before = deepcopy(pack)
    result = evaluate_pack(pack)
    assert pack == before
    assert result["cases"][0]["claims"][0]["status"] == "MATCH"
    assert result["cases"][0]["research_report_sha256"] == hash_value(
        pack["cases"][0]["research_report"]
    )


def test_empty_legacy_run_literal_is_malformed_and_cannot_hide_missing_owner():
    pack = case_pack("legacy")
    pack["cases"][0]["research_report"]["report"]["runId"] = ""
    pack["cases"][0]["claims"][0]["target"]["run_id"] = ""
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


@pytest.mark.parametrize("price", ["0", "-100"])
def test_nonpositive_saved_price_is_manual_without_losing_denominator(price):
    payload = (
        f'{{"columns":["Date","Close"],"rows":[["2026-01-07",{price}],["2026-01-08",101.005]]}}'
    )
    result = evaluate_pack(replace_table(case_pack("percent_baseline"), payload))
    assert result["summary"]["denominator"] == 1
    assert result["summary"]["counts"]["MANUAL"] == 1
    assert result["cases"][0]["claims"][0]["reason"] == "nonpositive_price"


def test_saved_scientific_source_lexemes_are_preserved_in_public_percent_witness():
    payload = '{"columns":["Date","Close"],"rows":[["2026-01-07",1e2],["2026-01-08",1.01005e2]]}'
    result = claim_result(replace_table(case_pack("percent_baseline"), payload))
    assert result["status"] == "MATCH"
    assert result["witness"]["rounded_decimal"] == "1.01"
    assert [item["raw_number_lexeme"] for item in result["witness"]["operands"]] == [
        "1e2",
        "1.01005e2",
    ]
    assert [item["original_row_label"] for item in result["witness"]["operands"]] == [
        "2026-01-07",
        "2026-01-08",
    ]


def test_whole_ascii_exponent_percent_is_supported_but_partial_exponent_is_manual():
    pack = case_pack("percent_baseline")
    payload = '{"columns":["Date","Close"],"rows":[["2026-01-07",100],["2026-01-08",110]]}'
    pack = replace_table(pack, payload)
    assert claim_result(replace_text(pack, "研究📈\r\nChange 1e1%", "1e1%"))["status"] == "MATCH"
    assert claim_result(replace_text(pack, "研究📈\r\nChange 1e1%", "1"))["status"] == "MANUAL"


@pytest.mark.parametrize(
    "currency,source_units,expected",
    [("USD", "USD", "MATCH"), ("EUR", "USD", "MISMATCH"), ("USD", None, "MISSING")],
)
def test_declared_currency_literal_binding_has_no_conversion_or_missing_inference(
    currency, source_units, expected
):
    pack = case_pack("percent_baseline")
    text = f"研究📈\r\nFICT {currency} 2026-01-07 to 2026-01-08 fictional_raw change 1.01%."
    pack = replace_text(pack, text, "1.01%")
    case = pack["cases"][0]
    bindings = case["claims"][0]["selection"]["context_bindings"]
    for key, literal in (
        ("instrument", "FICT"),
        ("start_date", "2026-01-07"),
        ("end_date", "2026-01-08"),
        ("units", currency),
        ("basis", "fictional_raw"),
    ):
        bindings[key] = raw_span(text, literal)
    evidence = case["research_report"]["evidence_bundle"]
    evidence["records"][0]["sources"][0]["units"] = source_units
    case["research_report"]["evidence_bundle"] = make_component(evidence, "bundle_sha256")
    result = claim_result(refresh_owner(bind_saved_operands(pack)))
    assert result["status"] == expected
    assert "currency_conversion" in result["witness"]["unreviewed_dimensions"]
    if expected == "MATCH":
        assert set(result["witness"]["context_results"].values()) == {"match_declared_literal"}


@pytest.mark.parametrize("field,value", [("evidence_id", "ev-" + "b" * 32), ("source_index", 1)])
def test_dangling_percent_operand_reference_is_invalid(field, value):
    pack = case_pack("percent_baseline")
    second = pack["cases"][0]["claims"][0]["selection"]["operands"][1]
    if field in {"field", "table_path"}:
        second["selector"][field] = value
    else:
        second[field] = value
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


@pytest.mark.parametrize("family", ["field", "source", "record", "table"])
def test_valid_cross_family_operands_are_manual_not_arithmetic_or_invalid_receipts(family):
    pack = case_pack("percent_baseline")
    case = pack["cases"][0]
    envelope = case["research_report"]
    evidence = envelope["evidence_bundle"]
    first, second = case["claims"][0]["selection"]["operands"]
    if family == "field":
        second["selector"]["field"] = "TieOne"
    elif family == "source":
        evidence["records"][0]["sources"].append(deepcopy(evidence["records"][0]["sources"][0]))
        second["source_index"] = 1
    elif family == "record":
        record = deepcopy(evidence["records"][0])
        record["id"] = "ev-" + "b" * 32
        output = {
            "kind": "tool_text",
            "payload": f"[E:{record['id']}]\nFictional second saved source.",
        }
        record["output_sha256"] = hash_value(output)
        evidence["artifacts"][record["output_sha256"]] = output
        evidence["records"].append(record)
        second["evidence_id"] = record["id"]
    else:
        table = {
            "columns": ["Date", "Close"],
            "rows": [["2026-01-07", 100], ["2026-01-08", 101.005]],
        }
        payload = json.dumps({"latest_ohlcv": table, "recent_closes": table})
        pack = replace_table(pack, payload)
        case = pack["cases"][0]
        envelope = case["research_report"]
        evidence = envelope["evidence_bundle"]
        first, second = case["claims"][0]["selection"]["operands"]
        first["selector"]["table_path"] = ["latest_ohlcv"]
        second["selector"]["table_path"] = ["recent_closes"]
    envelope["evidence_bundle"] = make_component(evidence, "bundle_sha256")
    result = evaluate_pack(refresh_owner(bind_saved_operands(pack)))
    assert result["summary"]["denominator"] == 1
    assert result["summary"]["counts"]["MANUAL"] == 1
    assert result["cases"][0]["claims"][0]["witness"] is not None


@pytest.mark.parametrize("family", ["source", "field"])
def test_outside_percent_family_with_context_mismatch_still_abstains_manual(family):
    pack = replace_text(
        case_pack("percent_baseline"), "研究📈\r\nEUR declared change 1.01%", "1.01%"
    )
    case = pack["cases"][0]
    envelope = case["research_report"]
    evidence = envelope["evidence_bundle"]
    selection = case["claims"][0]["selection"]
    selection["context_bindings"]["units"] = raw_span(
        envelope["report"]["reportSections"]["market_report"], "EUR"
    )
    if family == "source":
        evidence["records"][0]["sources"].append(deepcopy(evidence["records"][0]["sources"][0]))
        selection["operands"][1]["source_index"] = 1
    else:
        selection["operands"][1]["selector"]["field"] = "TieOne"
    envelope["evidence_bundle"] = make_component(evidence, "bundle_sha256")
    result = claim_result(refresh_owner(bind_saved_operands(pack)))
    assert result["status"] == "MANUAL"
    assert result["witness"]["context_results"]["units"] == "mismatch"


@pytest.mark.parametrize(
    "field,value",
    [
        ("provider", "tencent"),
        ("data_sha256", "f" * 64),
        ("units", "EUR"),
        ("adjustments", "invented_basis"),
    ],
)
def test_operand_receipt_metadata_must_match_actual_saved_source(field, value):
    pack = case_pack("percent_baseline")
    pack["cases"][0]["claims"][0]["selection"]["operands"][0][field] = value
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


@pytest.mark.parametrize(
    "marker",
    [
        "memory_target_binding_sha256",
        "research_readiness_policy_sha256",
        "effective_request_identity_policy_sha256",
    ],
)
def test_marked_completed_report_requires_saved_attachment_in_both_directions(marker):
    pack = case_pack("field_baseline")
    envelope = pack["cases"][0]["research_report"]
    evidence = envelope["evidence_bundle"]
    evidence["manifest"][marker] = "f" * 64
    evidence["manifest_sha256"] = hash_value(evidence["manifest"])
    envelope["evidence_bundle"] = make_component(evidence, "bundle_sha256")
    with pytest.raises(ValueError):
        evaluate_pack(refresh_owner(pack))


def test_copied_version_preserves_complete_same_run_authority_and_claim_order():
    pack = case_pack("field_baseline")
    copy = deepcopy(pack["cases"][0])
    copy["case_id"] = "same-saved-run-copied-version"
    copy["research_report"]["report"]["id"] = "copied-version-id"
    copy["research_report"]["report"]["versionNumber"] = 2
    copy["research_report"]["report"]["createdAt"] = "2026-01-09T12:00:00.000000Z"
    copy["claims"][0]["target"]["version_id"] = "copied-version-id"
    copy["claims"][0]["claim_id"] = "copied-version-field-1"
    pack["cases"].append(copy)
    result = evaluate_pack(rehash(pack))
    assert result["summary"]["denominator"] == 2
    assert [case["claims"][0]["status"] for case in result["cases"]] == ["MATCH", "MATCH"]


@pytest.mark.parametrize("conflict", ["same_run_new_text", "same_version_new_metadata"])
def test_global_saved_run_and_version_conflicts_reject_coherent_rehash(conflict):
    pack = case_pack("field_baseline")
    copy = deepcopy(pack["cases"][0])
    copy["case_id"] = "conflicting-saved-owner"
    copy["claims"][0]["claim_id"] = "conflicting-owner-unique-field-1"
    pack["cases"].append(copy)
    if conflict == "same_run_new_text":
        copy["research_report"]["report"]["id"] = "different-version-same-run"
        copy["claims"][0]["target"]["version_id"] = "different-version-same-run"
        copy["research_report"]["report"]["reportSections"]["news_report"] += "Altered later prose."
        pack = refresh_owner(pack)
    else:
        copy["research_report"]["report"]["stats"]["toolCalls"] += 1
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


def test_independent_arithmetic_stratum_does_not_create_external_expert_acceptance():
    pack = case_pack("percent_baseline")
    pack["provenance"]["stratum"] = "independent_arithmetic"
    result = evaluate_pack(rehash(pack))
    assert result["provenance"] == {
        "stratum": "independent_arithmetic",
        "labeler": None,
        "expert_labels": None,
    }
    assert result["summary"]["expert_status"] == "NOT_EVALUATED"


def test_claim_ids_are_globally_unique_across_valid_copied_cases():
    pack = case_pack("field_baseline")
    copy = deepcopy(pack["cases"][0])
    copy["case_id"] = "different-case-duplicate-claim-id"
    copy["research_report"]["report"]["id"] = "different-version-duplicate-claim"
    copy["claims"][0]["target"]["version_id"] = "different-version-duplicate-claim"
    pack["cases"].append(copy)
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


def test_false_hand_label_is_measured_disagreement_and_cannot_override_actual_result():
    pack = owned_pack()
    labels = next(
        item
        for item in pack["label_sets"]
        if item["case_id"] == "field_baseline" and item["provenance"] == "independent_arithmetic"
    )
    labels["labels"][1]["expected"] = {
        "status": "MATCH",
        "rounded_decimal": "999.00",
        "reason": "invented_label",
    }
    result = evaluate_pack(rehash(pack))
    assert result["cases"][0]["claims"][1]["status"] == "MISMATCH"
    comparison = next(
        item
        for item in result["label_evaluations"]
        if item["label_set_id"] == labels["label_set_id"]
    )
    assert comparison["labels"][1]["comparison"] == "DISAGREEMENT"
    assert comparison["labels"][1]["actual"] == {
        "status": "MISMATCH",
        "rounded_decimal": "101.01",
        "reason": "value_mismatch",
    }
    assert comparison["labels"][1]["expected"] == labels["labels"][1]["expected"]
    assert result["summary"]["strata"]["independent_arithmetic"] == {
        "annotated_claim_denominator": 16,
        "labels_present": 6,
        "agreement": 5,
        "disagreement": 1,
        "unlabeled": 10,
    }
    assert result["summary"]["external_expert"]["approved_claim_denominator"] == 0


def test_missing_labels_stay_unlabeled_against_all_claim_denominator():
    pack = owned_pack()
    pack["label_sets"] = []
    result = evaluate_pack(rehash(pack))
    assert result["summary"]["denominator"] == 16
    for stratum in ("engineering", "independent_arithmetic"):
        assert result["summary"]["strata"][stratum] == {
            "annotated_claim_denominator": 16,
            "labels_present": 0,
            "agreement": 0,
            "disagreement": 0,
            "unlabeled": 16,
        }
    assert result["label_evaluations"] == []


@pytest.mark.parametrize(
    "attack",
    [
        "case_binding",
        "claim_binding",
        "unknown_claim",
        "duplicate_label",
        "external_expert",
        "revision_zero",
        "invalid_status",
        "invalid_rounded",
        "duplicate_set_id",
        "distribution",
        "policy",
    ],
)
def test_label_revision_bindings_distribution_and_external_provenance_are_strict(attack):
    pack = owned_pack()
    label_set = pack["label_sets"][0]
    if attack == "case_binding":
        label_set["case_sha256"] = "f" * 64
    if attack == "claim_binding":
        label_set["labels"][0]["claim_sha256"] = "f" * 64
    if attack == "unknown_claim":
        label_set["labels"][0]["claim_id"] = "nonexistent-claim"
    if attack == "duplicate_label":
        label_set["labels"].append(deepcopy(label_set["labels"][0]))
    if attack == "external_expert":
        label_set["provenance"] = "external_expert"
    if attack == "revision_zero":
        label_set["revision"] = 0
    if attack == "invalid_status":
        label_set["labels"][0]["expected"]["status"] = "APPROVED"
    if attack == "invalid_rounded":
        label_set["labels"][0]["expected"]["rounded_decimal"] = {"value": "1.00"}
    if attack == "duplicate_set_id":
        pack["label_sets"][1]["label_set_id"] = label_set["label_set_id"]
    if attack == "distribution":
        pack["distribution"]["status"] = "unlicensed_provider_data"
    if attack == "policy":
        pack["policy_sha256"] = "f" * 64
    pack["label_sets"] = [make_component(item, "label_set_sha256") for item in pack["label_sets"]]
    with pytest.raises(ValueError):
        evaluate_pack(make_component(pack, "pack_sha256"))


@pytest.mark.parametrize("attack", ["claim", "report", "case"])
def test_individual_claim_report_and_case_hashes_are_required_authorities(attack):
    pack = owned_pack()
    case = pack["cases"][0]
    if attack == "claim":
        case["claims"][0]["claim_sha256"] = "f" * 64
    if attack == "report":
        case["report_sha256"] = "f" * 64
    if attack == "case":
        case["case_sha256"] = "f" * 64
    with pytest.raises(ValueError):
        evaluate_pack(make_component(pack, "pack_sha256"))


@pytest.mark.parametrize("case_count,claim_count", [(33, 1), (1, 101)])
def test_bounded_cases_and_claims_reject_oversize_without_reducing_denominator(
    case_count, claim_count
):
    pack = case_pack("legacy")
    template = deepcopy(pack["cases"][0])
    pack["cases"] = []
    pack["label_sets"] = []
    for case_index in range(case_count):
        case = deepcopy(template)
        case["case_id"] = f"owned-large-case-{case_index}"
        case["claims"] = []
        for claim_index in range(claim_count):
            claim = deepcopy(template["claims"][0])
            claim["claim_id"] = f"owned-large-claim-{case_index}-{claim_index}"
            case["claims"].append(claim)
        pack["cases"].append(case)
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


@pytest.mark.parametrize("source_number", ["1e1024", "9007199254740993"])
def test_pure_oracle_numeric_bounds_do_not_expand_inherited_evidence_admission(source_number):
    # The pure oracle accepts both, but Evidence v1's normalization rejects a
    # nonfinite float or an integer above its JSON safe-integer envelope cap.
    assert exact_price_change_percent(source_number, source_number, 2) == "0.00"
    payload = (
        '{"columns":["Date","Close"],"rows":'
        f'[["2026-01-07",{source_number}],["2026-01-08",101.005]]}}'
    )
    with pytest.raises(ValueError):
        replace_table(case_pack("percent_baseline"), payload)


@pytest.mark.parametrize(
    "attack",
    [
        "duplicate_case",
        "duplicate_claim",
        "empty_claims",
        "missing_claim_id",
        "expert_flag",
        "expert_labels",
        "unknown_provenance",
        "missing_case",
        "extra_pack_field",
    ],
)
def test_pack_denominator_and_provenance_attacks_rejected(attack):
    pack = owned_pack()
    if attack == "duplicate_case":
        pack["cases"].append(deepcopy(pack["cases"][0]))
    if attack == "duplicate_claim":
        pack["cases"][0]["claims"].append(deepcopy(pack["cases"][0]["claims"][0]))
    if attack == "empty_claims":
        pack["cases"][0]["claims"] = []
    if attack == "missing_claim_id":
        del pack["cases"][0]["claims"][0]["claim_id"]
    if attack == "expert_flag":
        pack["provenance"]["stratum"] = "expert"
    if attack == "expert_labels":
        pack["provenance"]["expert_labels"] = {"accepted": True}
    if attack == "unknown_provenance":
        pack["provenance"]["labeler"] = "invented expert"
    if attack == "missing_case":
        pack["cases"] = []
    if attack == "extra_pack_field":
        pack["expert_status"] = "ACCEPTED"
    with pytest.raises(ValueError):
        evaluate_pack(rehash(pack))


@pytest.mark.parametrize(
    "attack", ["claim_status", "witness", "denominator", "case_hash", "expert", "implementation"]
)
def test_self_consistent_result_hash_never_replaces_replay(attack):
    pack = owned_pack()
    result = evaluate_pack(pack)
    if attack == "claim_status":
        result["cases"][0]["claims"][1]["status"] = "MATCH"
    if attack == "witness":
        result["cases"][0]["claims"][0]["witness"] = None
    if attack == "denominator":
        result["summary"]["denominator"] = 15
    if attack == "case_hash":
        result["cases"][0]["research_report_sha256"] = "f" * 64
    if attack == "expert":
        result["summary"]["expert_status"] = "ACCEPTED"
    if attack == "implementation":
        result["implementation"] = {"source_sha256": "f" * 64}
    result = make_component(result, "result_sha256")
    with pytest.raises(ValueError):
        validate_evaluation_result(result, pack)


def test_atomic_publication_no_overwrite_invalid_partial_and_concurrent_writers(tmp_path):
    pack = owned_pack()
    result = evaluate_pack(pack)
    output = tmp_path / "owned-result.json"
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(write_result, output, result, pack) for _ in range(4)]
        outcomes = []
        for future in futures:
            try:
                future.result()
                outcomes.append("published")
            except (ValueError, OSError):
                outcomes.append("preserved")
    assert outcomes.count("published") == 1
    assert json.loads(output.read_bytes()) == result
    assert list(tmp_path.iterdir()) == [output]
    before = output.read_bytes()
    with pytest.raises((ValueError, OSError)):
        write_result(output, result, pack)
    assert output.read_bytes() == before
    wrong = deepcopy(result)
    wrong["summary"]["denominator"] = 0
    wrong = make_component(wrong, "result_sha256")
    invalid = tmp_path / "invalid.json"
    with pytest.raises(ValueError):
        write_result(invalid, wrong, pack)
    assert not invalid.exists()
    assert list(tmp_path.iterdir()) == [output]


def test_failed_atomic_link_cleans_only_own_temporary_and_preserves_inputs(tmp_path, monkeypatch):
    pack = case_pack("percent_baseline")
    result = evaluate_pack(pack)
    sentinel = tmp_path / "existing-owned-note.txt"
    sentinel.write_bytes(b"owned existing bytes")
    output = tmp_path / "failed-output.json"

    def failed_link(*args, **kwargs):
        raise OSError("Owned injected publication failure")

    monkeypatch.setattr(os, "link", failed_link)
    with pytest.raises(ValueError):
        write_result(output, result, pack)
    assert list(tmp_path.iterdir()) == [sentinel]
    assert sentinel.read_bytes() == b"owned existing bytes"


def test_public_file_api_and_cli_work_from_owned_directory_without_heavy_imports(tmp_path):
    input_path = tmp_path / "input.json"
    input_path.write_bytes(FIXTURE.read_bytes())
    original = input_path.read_bytes()
    expected = evaluate_pack(owned_pack())
    api_output = tmp_path / "api.json"
    evaluate_file(input_path, api_output)
    assert json.loads(api_output.read_bytes()) == expected
    cli_output = tmp_path / "cli.json"
    hook = r"""
import builtins, os, runpy, socket, sys
blocked = {"requests", "httpx", "dotenv", "pandas", "numpy", "yfinance", "akshare", "langgraph", "langchain", "langchain_core", "langchain_openai", "langchain_anthropic", "langchain_google_genai"}
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name.split(".")[0] in blocked:
        raise RuntimeError("Heavy or credential-loading import attempted: " + name)
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
def forbidden_network(*args, **kwargs):
    raise RuntimeError("Network attempted by offline evaluator")
socket.create_connection = forbidden_network
socket.socket.connect = forbidden_network
socket.socket.connect_ex = forbidden_network
original_open = builtins.open
def guarded_open(path, *args, **kwargs):
    if isinstance(path, (str, bytes, os.PathLike)):
        name = os.fsdecode(path)
        if os.path.basename(name) in {".env", ".env.local", "credentials", "credentials.json"}:
            raise RuntimeError("Profile or dotenv access attempted")
    return original_open(path, *args, **kwargs)
builtins.open = guarded_open
sys.argv = [sys.argv[1], sys.argv[2], "--output", sys.argv[3]]
runpy.run_path(sys.argv[0], run_name="__main__")
"""
    environment = {
        key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "WINDIR") if key in os.environ
    }
    environment["HOME"] = str(tmp_path / "owned-empty-home")
    completed = subprocess.run(
        [sys.executable, "-I", "-c", hook, str(CLI), str(input_path), str(cli_output)],
        cwd=tmp_path,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert json.loads(cli_output.read_bytes()) == expected
    assert input_path.read_bytes() == original


def test_invalid_public_cli_creates_no_output_or_partial(tmp_path):
    pack = owned_pack()
    pack["cases"][0]["claims"][0]["target"]["task_id"] = "different-owner"
    input_path = tmp_path / "invalid-input.json"
    input_path.write_text(json.dumps(rehash(pack)), encoding="utf-8")
    output = tmp_path / "must-not-exist.json"
    completed = subprocess.run(
        [sys.executable, str(CLI), str(input_path), "--output", str(output)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode != 0
    assert not output.exists()
    assert list(tmp_path.iterdir()) == [input_path]


@pytest.mark.parametrize("location", ["metadata", "nested_metadata", "legacy_text"])
def test_ordinary_fake_credential_text_fails_closed_without_cli_leak_or_output(location, tmp_path):
    pack = case_pack("legacy" if location == "legacy_text" else "field_baseline")
    case = pack["cases"][0]
    report = case["research_report"]["report"]
    marker = "owned-fake-credential-boundary-value"
    text = "api_key=" + marker
    if location == "metadata":
        report["task"]["instrumentName"] = text
    elif location == "nested_metadata":
        report["run"] = {"runtimeRunSettings": {"ordinary_note": text}}
    else:
        report["reportSections"]["market_report"] += "\r\n" + text
        pack = refresh_owner(pack)
    pack = rehash(pack)
    with pytest.raises(ValueError) as error:
        evaluate_pack(pack)
    assert marker not in str(error.value)
    input_path = tmp_path / "owned-input.json"
    input_path.write_text(json.dumps(pack), encoding="utf-8")
    output = tmp_path / "must-not-leak.json"
    original = input_path.read_bytes()
    completed = subprocess.run(
        [sys.executable, str(CLI), str(input_path), "--output", str(output)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode != 0
    assert marker not in completed.stdout + completed.stderr
    assert str(input_path) not in completed.stdout + completed.stderr
    assert not output.exists()
    assert input_path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [input_path]
