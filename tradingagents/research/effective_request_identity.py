"""Saved outer-request alignment, not provider/entity identity certification.

The policy is embedded, immutable by version, and independent of current vendor
resolvers. Every attachment is rederived from complete validated saved inputs.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import re

from tradingagents.evidence import validate_evidence_bundle
from tradingagents.memory.schema import (
    canonical_json,
    hash_component,
    hash_value,
    make_component,
    _safe,
)
from tradingagents.research.numeric_review import validate_report_text_snapshot

EFFECTIVE_REQUEST_IDENTITY_POLICY = {
    "schema_version": 1,
    "policy_version": "saved-effective-request-v1",
    "scope": "saved_effective_outer_request_alignment",
    "normalization": {
        "ascii_case": "a-z_to_A-Z",
        "strip_plus": False,
        "trim_characters": ["U+0009", "U+000A", "U+000B", "U+000C", "U+000D", "U+0020"],
        "unicode_normalization": "none",
    },
    "tool_scopes": {
        "fetch_china_sentiment_sources": {
            "content_scope": "retrieval_context",
            "selector": "ticker",
        },
        "fetch_reddit_posts": {"content_scope": "retrieval_context", "selector": "ticker"},
        "fetch_stocktwits_messages": {"content_scope": "retrieval_context", "selector": "ticker"},
        "get_balance_sheet": {
            "content_scope": "single_instrument_requested_data",
            "selector": "ticker",
        },
        "get_cashflow": {"content_scope": "single_instrument_requested_data", "selector": "ticker"},
        "get_fundamentals": {
            "content_scope": "single_instrument_requested_data",
            "selector": "ticker",
        },
        "get_global_news": {"content_scope": "global_query", "selector": None},
        "get_income_statement": {
            "content_scope": "single_instrument_requested_data",
            "selector": "ticker",
        },
        "get_indicators": {
            "content_scope": "single_instrument_requested_data",
            "selector": "symbol",
        },
        "get_insider_transactions": {
            "content_scope": "single_instrument_requested_data",
            "selector": "ticker",
        },
        "get_market_data_snapshot": {
            "content_scope": "legacy_tool_scope_unknown",
            "selector": None,
        },
        "get_news": {"content_scope": "retrieval_context", "selector": "ticker"},
        "get_stock_data": {
            "content_scope": "single_instrument_requested_data",
            "selector": "symbol",
        },
        "get_verified_market_snapshot": {
            "content_scope": "single_instrument_requested_data",
            "selector": "symbol",
        },
        "resolve_instrument_context": {"content_scope": "identity_context", "selector": "ticker"},
    },
    "selector_like_keys": ["instrument", "symbol", "ticker"],
    "notation_rules": [
        {
            "grammar": [
                "^[0-9]{6}\\.SH$",
                "^[0-9]{6}\\.SS$",
                "^SH[0-9]{6}$",
                "^[0-9]{6}\\.SZ$",
                "^SZ[0-9]{6}$",
            ],
            "id": "mainland_explicit_venue_v1",
            "same_venue_aliases": {"SH": [".SH", ".SS", "SH_prefix"], "SZ": [".SZ", "SZ_prefix"]},
            "venue_inference_from_bare_code": False,
        },
        {
            "bare_code_equivalence": False,
            "canonical_notation": "left_pad_code_to_four_digits_plus_.HK",
            "five_digit_leading_zero_equivalence": False,
            "grammar": "^[0-9]{1,4}\\.HK$",
            "id": "hk_explicit_suffix_padding_v1",
        },
    ],
    "proxy_pairs": {
        "BCOUSD": "BZ=F",
        "BRENT": "BZ=F",
        "COPPER": "HG=F",
        "DE40": "^GDAXI",
        "DJI30": "^DJI",
        "EU50": "^STOXX50E",
        "FRA40": "^FCHI",
        "GER30": "^GDAXI",
        "GER40": "^GDAXI",
        "GOLD": "GC=F",
        "HK50": "^HSI",
        "JP225": "^N225",
        "JPN225": "^N225",
        "NAS100": "^NDX",
        "NATGAS": "NG=F",
        "SILVER": "SI=F",
        "SPX": "^GSPC",
        "SPX500": "^GSPC",
        "UK100": "^FTSE",
        "UKOIL": "BZ=F",
        "US100": "^NDX",
        "US30": "^DJI",
        "US500": "^GSPC",
        "USOIL": "CL=F",
        "USTEC": "^NDX",
        "WS30": "^DJI",
        "WTI": "CL=F",
        "WTICOUSD": "CL=F",
        "XAG": "SI=F",
        "XAGUSD": "SI=F",
        "XAU": "GC=F",
        "XAUUSD": "GC=F",
        "XCUUSD": "HG=F",
        "XNGUSD": "NG=F",
        "XPDUSD": "PA=F",
        "XPTUSD": "PL=F",
        "XAUUSD+": "GC=F",
    },
    "currency_codes": [
        "AUD",
        "CAD",
        "CHF",
        "CNH",
        "CNY",
        "EUR",
        "GBP",
        "HKD",
        "JPY",
        "NZD",
        "SGD",
        "USD",
    ],
    "crypto_bases": [
        "ADA",
        "AVAX",
        "BCH",
        "BNB",
        "BTC",
        "DOGE",
        "DOT",
        "ETH",
        "LINK",
        "LTC",
        "SOL",
        "UNI",
        "XLM",
        "XRP",
    ],
    "provider_request_status": "unknown",
    "provider_entity_status": "unknown",
    "record_order": "ascii_evidence_id",
    "source_order": "original_zero_based_index",
    "extra_selector_rule": "canonical_conflict_precedes_extra_metadata_otherwise_record_unknown",
    "missing_selector_rule": "never_use_alternate_key",
    "plain_identifier_grammar": "\\^?[A-Z0-9][A-Z0-9._=-]{0,63}",
    "limits": {"max_identifier_bytes": 256, "max_records": 100000, "max_sources_per_record": 10000},
    "unsafe_record_reasons": [
        "effective_request_conflict",
        "effective_request_missing",
        "effective_request_unusable",
        "unqualified_venue",
        "explicit_venue_conflict",
        "unreviewed_identifier_relation",
        "declared_proxy_reference",
        "unexpected_selector_metadata",
        "legacy_tool_scope_unknown",
    ],
    "reason_codes": [
        "effective_request_aligned",
        "effective_request_conflict",
        "effective_request_missing",
        "effective_request_unusable",
        "unqualified_venue",
        "explicit_venue_conflict",
        "unreviewed_identifier_relation",
        "declared_proxy_reference",
        "unexpected_selector_metadata",
        "global_query_not_instrument_scoped",
        "legacy_tool_scope_unknown",
    ],
    "unsafe_rule": "every_non_global_record_alignment_conflict_unknown_or_proxy",
}
POLICY_SHA256 = hash_value(EFFECTIVE_REQUEST_IDENTITY_POLICY)
_UTC = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\Z")
_ASCII_UPPER = str.maketrans("abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRSTUVWXYZ")
_MAINLAND = re.compile(r"(?:(SH|SZ)([0-9]{6})|([0-9]{6})\.(SH|SS|SZ))\Z")
_HK = re.compile(r"([0-9]{1,4})\.HK\Z")
_PLAIN = re.compile(EFFECTIVE_REQUEST_IDENTITY_POLICY["plain_identifier_grammar"] + r"\Z")
_ALIGNMENTS = ("consistent", "conflict", "unknown", "proxy", "not_applicable")


class EffectiveRequestIdentityError(ValueError):
    def __init__(self):
        super().__init__("Invalid or conflicting effective outer-request assessment")


def _fail():
    raise EffectiveRequestIdentityError()


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
        raise EffectiveRequestIdentityError() from None


def _normalized(value):
    if not isinstance(value, str) or len(value.encode("utf-8")) > 256:
        return None
    value = value.strip(" \t\r\n\f\v").translate(_ASCII_UPPER)
    return value or None


def _mainland(value):
    match = _MAINLAND.fullmatch(value)
    if match is None:
        return None
    venue, code, suffix_code, suffix = match.groups()
    return ("SH" if (venue or suffix) in {"SH", "SS"} else "SZ", code or suffix_code)


def _qualified(value):
    mainland = _mainland(value)
    if mainland:
        return mainland
    hk = _HK.fullmatch(value)
    return ("HK", hk[1].zfill(4)) if hk else None


def _pair(value):
    # These are saved spelling relations, not a detected asset type/namespace.
    value = value[:-2] if value.endswith("=X") else value
    for quote in EFFECTIVE_REQUEST_IDENTITY_POLICY["currency_codes"]:
        for base in (
            *EFFECTIVE_REQUEST_IDENTITY_POLICY["currency_codes"],
            *EFFECTIVE_REQUEST_IDENTITY_POLICY["crypto_bases"],
        ):
            if value in {base + quote, base + "-" + quote}:
                return base, quote
    return None


def _relation(expected, selected):
    if expected is None or selected is None:
        return "unknown", "effective_request_unusable", "no_proved_effective_selector", None
    if expected == selected:
        rule = "ascii_literal" if expected.isascii() else "exact_preserved_literal"
        return "consistent", "effective_request_aligned", rule, None
    proxies = EFFECTIVE_REQUEST_IDENTITY_POLICY["proxy_pairs"]
    if proxies.get(expected) == selected or proxies.get(selected) == expected:
        return "proxy", "declared_proxy_reference", "explicit_yahoo_reference_pair", None
    a, b = _qualified(expected), _qualified(selected)
    if a and b:
        if a == b:
            rule = "hk_explicit_suffix_padding_v1" if a[0] == "HK" else "mainland_explicit_venue_v1"
            return "consistent", "effective_request_aligned", rule, a[0]
        if a[1] == b[1] and a[0] != b[0]:
            return "conflict", "explicit_venue_conflict", "mainland_explicit_venue_v1", None
    for bare, qualified in ((expected, b), (selected, a)):
        if qualified and re.fullmatch(r"[0-9]{1,6}", bare):
            code = bare.zfill(4) if qualified[0] == "HK" and len(bare) <= 4 else bare
            if code == qualified[1]:
                return "unknown", "unqualified_venue", "no_bare_venue_inference", None
    if not expected.isascii() or not selected.isascii():
        return "unknown", "unreviewed_identifier_relation", "no_unicode_normalization", None
    if "+" in expected or "+" in selected:
        return "unknown", "unreviewed_identifier_relation", "unsupported_broker_qualifier", None
    if any(v.endswith(".HK") and _HK.fullmatch(v) is None for v in (expected, selected)):
        return "unknown", "unreviewed_identifier_relation", "outside_reviewed_hk_rule", None
    if any(
        re.search(r"\.(?:SH|SS|SZ)\Z", v) and _mainland(v) is None for v in (expected, selected)
    ):
        return "unknown", "unreviewed_identifier_relation", "malformed_qualified_identifier", None
    if _pair(expected) is not None and _pair(expected) == _pair(selected):
        return "unknown", "unreviewed_identifier_relation", "pair_namespace_not_captured", None
    for discussion, pair in ((expected, selected), (selected, expected)):
        if discussion.endswith(".X") and (parts := _pair(pair)) and discussion[:-2] == parts[0]:
            return (
                "unknown",
                "unreviewed_identifier_relation",
                "discussion_namespace_not_captured",
                None,
            )
    if _PLAIN.fullmatch(expected) and _PLAIN.fullmatch(selected):
        return "conflict", "effective_request_conflict", "different_saved_ascii_literal", None
    return "unknown", "unreviewed_identifier_relation", "unsupported_identifier_notation", None


def _assess_selector(instrument, tool, parameters):
    scopes = EFFECTIVE_REQUEST_IDENTITY_POLICY["tool_scopes"]
    if tool not in scopes or not isinstance(parameters, dict):
        _fail()
    scope = scopes[tool]
    selector = scope["selector"]
    extras = sorted(
        k
        for k in EFFECTIVE_REQUEST_IDENTITY_POLICY["selector_like_keys"]
        if k != selector and k in parameters
    )
    if scope["content_scope"] == "legacy_tool_scope_unknown":
        # No proven selector exists for this unproduced legacy name.
        extras = []
    if scope["content_scope"] == "global_query":
        alignment, reason, rule, venue = (
            "not_applicable",
            "global_query_not_instrument_scoped",
            "global_query",
            None,
        )
    elif selector is None:
        alignment, reason, rule, venue = (
            "unknown",
            "legacy_tool_scope_unknown",
            "legacy_unknown",
            None,
        )
    elif selector not in parameters:
        alignment, reason, rule, venue = (
            "unknown",
            "effective_request_missing",
            "no_proved_effective_selector",
            None,
        )
    else:
        alignment, reason, rule, venue = _relation(
            _normalized(instrument), _normalized(parameters[selector])
        )
    record_alignment, record_reason = alignment, reason
    if extras and alignment != "conflict":
        record_alignment, record_reason = "unknown", "unexpected_selector_metadata"
    return {
        "tool": tool,
        "content_scope": scope["content_scope"],
        "canonical_selector_key": selector,
        "canonical_alignment": alignment,
        "canonical_reason": reason,
        "canonical_rule": rule,
        "record_alignment": record_alignment,
        "record_reason": record_reason,
        "venue": venue,
        "unexpected_selector_keys": extras,
    }


def assess_selector(instrument, tool, parameters):
    """Compare only the proven saved outer selector; never call a resolver."""
    return _checked(lambda: _assess_selector(instrument, tool, parameters))


def _unsafe(record):
    return record["content_scope"] != "global_query" and record["record_alignment"] in {
        "conflict",
        "unknown",
        "proxy",
    }


def _records(bundle):
    if len(bundle["records"]) > EFFECTIVE_REQUEST_IDENTITY_POLICY["limits"]["max_records"]:
        _fail()
    records = []
    for record in sorted(bundle["records"], key=lambda row: row["id"]):
        if (
            len(record["sources"])
            > EFFECTIVE_REQUEST_IDENTITY_POLICY["limits"]["max_sources_per_record"]
        ):
            _fail()
        projection = _assess_selector(bundle["instrument"], record["tool"], record["parameters"])
        projection["evidence_id"] = record["id"]
        projection["sources"] = [
            {
                "source_index": index,
                "provider": source["provider"],
                "data_sha256": source["data_sha256"],
                "provider_request": "unknown",
                "provider_entity": "unknown",
            }
            for index, source in enumerate(record["sources"])
        ]
        records.append(projection)
    return records


def unsafe_effective_request_ids(evidence):
    """Validate complete saved coverage and derive the scoped PM guard IDs."""

    def derive():
        bundle = _bundle(evidence)
        return [record["evidence_id"] for record in _records(bundle) if _unsafe(record)]

    return _checked(derive)


def _reviewed(value):
    if not isinstance(value, str) or not _UTC.fullmatch(value):
        _fail()
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _assessment(bundle, snapshot, reviewed_at):
    if _reviewed(reviewed_at) < _reviewed(snapshot["captured_at"]):
        _fail()
    records = _records(bundle)
    summary = {
        "record_count": len(records),
        "source_count": sum(len(record["sources"]) for record in records),
    }
    summary.update(
        {
            alignment + "_count": sum(record["record_alignment"] == alignment for record in records)
            for alignment in _ALIGNMENTS
        }
    )
    summary["unsafe_record_ids"] = [record["evidence_id"] for record in records if _unsafe(record)]
    if (
        "effective_request_identity_policy_sha256" in bundle["manifest"]
        and summary["unsafe_record_ids"]
    ):
        from tradingagents.agents.utils.rating import extract_rating

        final_text = snapshot["report_sections"]["final_trade_decision"]
        if not isinstance(final_text, str) or extract_rating(final_text) != "REVIEW":
            _fail()
    return make_component(
        {
            "schema_version": 1,
            "scope": EFFECTIVE_REQUEST_IDENTITY_POLICY["scope"],
            "policy_version": EFFECTIVE_REQUEST_IDENTITY_POLICY["policy_version"],
            "policy_sha256": POLICY_SHA256,
            "run_id": bundle["run_id"],
            "instrument": bundle["instrument"],
            "analysis_date": bundle["analysis_date"],
            "evidence_bundle_sha256": bundle["bundle_sha256"],
            "report_snapshot_sha256": snapshot["snapshot_sha256"],
            "reviewed_at": reviewed_at,
            "records": records,
            "summary": summary,
        },
        "assessment_sha256",
    )


def _bundle(evidence):
    bundle = validate_evidence_bundle(evidence)
    if (
        "effective_request_identity_policy_sha256" in bundle["manifest"]
        and bundle["manifest"]["effective_request_identity_policy_sha256"] != POLICY_SHA256
    ):
        _fail()
    return bundle


def _inputs(evidence, snapshot):
    bundle = _bundle(evidence)
    captured = validate_report_text_snapshot(snapshot, bundle)
    return bundle, captured


def assess_effective_request_identity(evidence, snapshot, *, reviewed_at=None):
    """Make one complete immutable as-completed attachment from saved facts."""

    def make():
        bundle, captured = _inputs(evidence, snapshot)
        clock = (
            reviewed_at
            if reviewed_at is not None
            else datetime.now(timezone.utc)
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z")
        )
        return _assessment(bundle, captured, clock)

    return _checked(make)


def validate_effective_request_identity(value, evidence, snapshot):
    """Recompute complete coverage, chronology, business rules and own hash."""

    def validate():
        candidate = deepcopy(value)
        _safe(candidate)
        if not isinstance(candidate, dict):
            _fail()
        bundle, captured = _inputs(evidence, snapshot)
        expected = _assessment(bundle, captured, candidate.get("reviewed_at"))
        if (
            canonical_json(candidate) != canonical_json(expected)
            or hash_component(candidate, "assessment_sha256") != candidate["assessment_sha256"]
        ):
            _fail()
        return deepcopy(expected)

    return _checked(validate)
