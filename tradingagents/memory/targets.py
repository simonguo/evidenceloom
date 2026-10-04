"""Pure, versioned request notation/proxy policy; never provider identity proof."""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
import re

from . import history_adapter

POLICY_VERSION = "yahoo-evaluation-target-v1"
PROVIDER = "yfinance"
NAMESPACE = "yahoo_finance_ticker"
_SAFE = re.compile(r"[A-Z0-9._^=\-]{1,64}\Z")
_SHA = re.compile(r"[a-f0-9]{64}\Z")
_ASCII_WHITESPACE = " \t\r\n\f\v"
_PROXIES = {
    "XAUUSD": "GC=F",
    "XAU": "GC=F",
    "GOLD": "GC=F",
    "XAGUSD": "SI=F",
    "XAG": "SI=F",
    "SILVER": "SI=F",
    "XPTUSD": "PL=F",
    "XPDUSD": "PA=F",
    "WTICOUSD": "CL=F",
    "USOIL": "CL=F",
    "WTI": "CL=F",
    "BCOUSD": "BZ=F",
    "UKOIL": "BZ=F",
    "BRENT": "BZ=F",
    "NATGAS": "NG=F",
    "XNGUSD": "NG=F",
    "COPPER": "HG=F",
    "XCUUSD": "HG=F",
    "SPX500": "^GSPC",
    "US500": "^GSPC",
    "SPX": "^GSPC",
    "NAS100": "^NDX",
    "US100": "^NDX",
    "USTEC": "^NDX",
    "US30": "^DJI",
    "DJI30": "^DJI",
    "WS30": "^DJI",
    "GER40": "^GDAXI",
    "GER30": "^GDAXI",
    "DE40": "^GDAXI",
    "UK100": "^FTSE",
    "JP225": "^N225",
    "JPN225": "^N225",
    "FRA40": "^FCHI",
    "EU50": "^STOXX50E",
    "HK50": "^HSI",
}
_FOREX = frozenset(
    "USD EUR GBP JPY CHF CAD AUD NZD CNY CNH HKD SGD SEK NOK DKK PLN MXN ZAR TRY INR KRW BRL RUB THB".split()
)
_CRYPTO = frozenset("BTC ETH SOL XRP ADA DOGE LTC BCH DOT AVAX LINK".split())


def policy():
    """Return literal rules, not executable regular expressions from a receipt."""
    return {
        "schema_version": 1,
        "policy_version": POLICY_VERSION,
        "provider": PROVIDER,
        "request_namespace": NAMESPACE,
        "normalization": "ascii_outer_whitespace_and_uppercase",
        "venue_rule": "qualified_six_digit_sh_ss_sz_and_one_to_four_digit_hk_v1",
        "forex_currencies": sorted(_FOREX),
        "crypto_bases": sorted(_CRYPTO),
        "proxy_aliases": deepcopy(_PROXIES),
        "unknown_rule": "non_ascii_or_bare_numeric_or_broker_plus_or_invalid_request_or_unreviewed_numeric_venue",
        "identity_scope": "request_only_not_provider_or_entity_confirmation",
        "observation_rule": "identical_provider_namespace_request_and_parameters_share_exact_source_body_and_number_lexemes",
    }


def policy_artifact():
    from .schema import make_artifact

    return make_artifact("canonical_json", policy())


def code_sha256():
    from .schema import MemoryValidationError

    try:
        return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    except OSError:
        raise MemoryValidationError() from None


def derive_target(role, requested_symbol):
    from .schema import MemoryValidationError

    if role not in ("instrument", "benchmark") or not isinstance(requested_symbol, str):
        raise MemoryValidationError()
    target = {
        "role": role,
        "requested_symbol": requested_symbol,
        "request_symbol": None,
        "relation": "unknown",
    }
    symbol = requested_symbol.strip(_ASCII_WHITESPACE)
    if not symbol.isascii():
        return target
    symbol = symbol.upper()
    if not _SAFE.fullmatch(symbol) or symbol.isdigit():
        return target
    if (
        (
            re.match(r"[0-9].*\.", symbol)
            and not re.fullmatch(r"(?:[0-9]{6}\.(?:SH|SS|SZ)|[0-9]{1,4}\.HK)", symbol)
        )
        or (
            symbol.endswith((".SH", ".SS", ".SZ", ".HK"))
            and not re.fullmatch(r"(?:[0-9]{6}\.(?:SH|SS|SZ)|[0-9]{1,4}\.HK)", symbol)
        )
        or (re.match(r"(?:SH|SZ)[0-9]", symbol) and not re.fullmatch(r"(?:SH|SZ)[0-9]{6}", symbol))
    ):
        return target
    relation = "exact"
    if symbol in _PROXIES:
        symbol, relation = _PROXIES[symbol], "proxy"
    elif re.fullmatch(r"[0-9]{6}\.SH", symbol):
        symbol, relation = symbol[:-3] + ".SS", "venue_notation"
    elif re.fullmatch(r"(?:SH|SZ)[0-9]{6}", symbol):
        symbol, relation = symbol[2:] + (".SS" if symbol[:2] == "SH" else ".SZ"), "venue_notation"
    elif re.fullmatch(r"[0-9]{1,4}\.HK", symbol):
        symbol, relation = symbol[:-3].zfill(4) + ".HK", "venue_notation"
    elif symbol.endswith("USD") and symbol[:-3] in _CRYPTO:
        symbol, relation = symbol[:-3] + "-USD", "pair_notation"
    elif len(symbol) == 6 and symbol[:3] in _FOREX and symbol[3:] in _FOREX:
        symbol, relation = symbol + "=X", "pair_notation"
    target.update(request_symbol=symbol, relation=relation)
    return target


def make_binding(*, instrument, benchmark, research_started_at):
    from .schema import make_component, utc_timestamp

    utc_timestamp(research_started_at)
    return validate_binding(
        make_component(
            {
                "schema_version": 1,
                "research_started_at": research_started_at,
                "provider": PROVIDER,
                "request_namespace": NAMESPACE,
                "adapter_id": history_adapter.ADAPTER_ID,
                "adapter_code_sha256": history_adapter.code_sha256(),
                "resolver_code_sha256": code_sha256(),
                "policy_version": POLICY_VERSION,
                "policy_artifact_sha256": policy_artifact()["sha256"],
                "targets": [
                    derive_target("instrument", instrument),
                    derive_target("benchmark", benchmark),
                ],
            },
            "binding_sha256",
        )
    )


def validate_binding(value):
    from .schema import MemoryValidationError, _bounded, hash_component, utc_timestamp

    _bounded(value)

    keys = {
        "schema_version",
        "research_started_at",
        "provider",
        "request_namespace",
        "adapter_id",
        "adapter_code_sha256",
        "resolver_code_sha256",
        "policy_version",
        "policy_artifact_sha256",
        "targets",
        "binding_sha256",
    }
    if not isinstance(value, dict) or set(value) != keys:
        raise MemoryValidationError()
    if (
        type(value["schema_version"]) is not int
        or value["schema_version"] != 1
        or value["provider"] != PROVIDER
        or value["request_namespace"] != NAMESPACE
        or value["adapter_id"] != history_adapter.ADAPTER_ID
        or value["policy_version"] != POLICY_VERSION
        or value["policy_artifact_sha256"] != policy_artifact()["sha256"]
        or any(
            not isinstance(value[key], str) or not _SHA.fullmatch(value[key])
            for key in ("adapter_code_sha256", "resolver_code_sha256", "binding_sha256")
        )
        or not isinstance(value["targets"], list)
        or len(value["targets"]) != 2
    ):
        raise MemoryValidationError()
    utc_timestamp(value["research_started_at"])
    for target, role in zip(value["targets"], ("instrument", "benchmark")):
        if (
            not isinstance(target, dict)
            or set(target) != {"role", "requested_symbol", "request_symbol", "relation"}
            or target != derive_target(role, target.get("requested_symbol"))
        ):
            raise MemoryValidationError()
    if hash_component(value, "binding_sha256") != value["binding_sha256"]:
        raise MemoryValidationError()
    return deepcopy(value)


def unsupported_binding(binding):
    """Unknown code identities remain saved but are not execution authority."""
    if binding["adapter_code_sha256"] != history_adapter.code_sha256():
        return "unsupported_history_adapter"
    if binding["resolver_code_sha256"] != code_sha256():
        return "unsupported_target_resolver"
    return None


def observation_key(source):
    """Role and selector spelling do not create another physical request."""
    from .schema import canonical_json

    return (
        source["provider"],
        source["request_namespace"],
        source["resolved_symbol"],
        canonical_json(source["request_parameters"]),
    )


class _NumberLexeme:
    def __init__(self, text):
        self.text = text


def _fingerprint(value):
    if isinstance(value, _NumberLexeme):
        return ("number", value.text)
    if isinstance(value, dict):
        return ("object", tuple((key, _fingerprint(item)) for key, item in sorted(value.items())))
    if isinstance(value, list):
        return ("array", tuple(_fingerprint(item) for item in value))
    return (type(value).__name__, value)


def validate_shared_observations(sources, *, payload=None):
    """Reference-only equality; arithmetic admission is a separate offline check."""
    from .schema import MemoryValidationError

    raw_sources = (
        json.loads(payload, parse_int=_NumberLexeme, parse_float=_NumberLexeme)["sources"]
        if payload is not None
        else sources
    )

    observed = {}
    for source, raw in zip(sources, raw_sources):
        key = observation_key(source)
        body = _fingerprint(
            {
                key: value
                for key, value in raw.items()
                if key not in ("role", "requested_symbol", "relation")
            }
        )
        if key in observed and observed[key] != body:
            raise MemoryValidationError()
        observed[key] = body


def validate_saved_subjects(decision, contract, outcome, artifacts):
    """Check source/subject references during no-provider storage and inventory reads."""
    from .schema import MemoryValidationError, parse_json

    if outcome is None:
        return
    binding = contract["target_binding"]
    if outcome["facts_sha256"] is not None:
        facts = parse_json(artifacts[outcome["facts_sha256"]]["payload"])
        keys = {
            "schema_version",
            "decision_sha256",
            "contract_sha256",
            "observation_cutoff",
            "sources",
            "limitations",
            "target_binding_sha256",
        }
        if (
            not isinstance(facts, dict)
            or set(facts) != keys
            or type(facts["schema_version"]) is not int
            or facts["schema_version"] != 2
            or facts["decision_sha256"] != decision["decision_sha256"]
            or facts["contract_sha256"] != contract["contract_sha256"]
            or facts["target_binding_sha256"] != binding["binding_sha256"]
            or not isinstance(facts["sources"], list)
            or len(facts["sources"]) != 2
        ):
            raise MemoryValidationError()
        source_keys = {
            "role",
            "provider",
            "requested_symbol",
            "resolved_symbol",
            "request_namespace",
            "relation",
            "request_parameters",
            "observed_at",
            "timezone",
            "currency",
            "publication_at",
            "price_vintage",
            "revision",
            "exchange_calendar_coverage",
            "rows",
            "issue",
        }
        for source, target in zip(facts["sources"], binding["targets"]):
            if (
                not isinstance(source, dict)
                or set(source) != source_keys
                or source["role"] != target["role"]
                or source["provider"] != PROVIDER
                or source["request_namespace"] != NAMESPACE
                or source["requested_symbol"] != target["requested_symbol"]
                or source["resolved_symbol"] != target["request_symbol"]
                or source["relation"] != target["relation"]
            ):
                raise MemoryValidationError()
        validate_shared_observations(
            facts["sources"], payload=artifacts[outcome["facts_sha256"]]["payload"]
        )
    if outcome["calculation_sha256"] is not None:
        calculation = parse_json(artifacts[outcome["calculation_sha256"]]["payload"])
        keys = {
            "schema_version",
            "contract_sha256",
            "target_binding_sha256",
            "reference_subjects",
            "entry_after_date",
            "entry_date",
            "exit_date",
            "holding_period_days",
            "holding_period_unit",
            "complete_instrument_dates",
            "complete_benchmark_dates",
            "common_complete_dates",
            "selected_common_dates",
            "endpoints",
            "raw_return",
            "benchmark_return",
            "return_difference",
            "raw_return_formula",
            "benchmark_return_formula",
            "difference_formula",
            "currency_policy",
            "interpretation",
        }
        if (
            not isinstance(calculation, dict)
            or set(calculation) != keys
            or type(calculation["schema_version"]) is not int
            or calculation["schema_version"] != 2
            or calculation["contract_sha256"] != contract["contract_sha256"]
            or calculation["target_binding_sha256"] != binding["binding_sha256"]
            or calculation["reference_subjects"] != binding["targets"]
            or not isinstance(calculation["endpoints"], list)
            or len(calculation["endpoints"]) != 2
        ):
            raise MemoryValidationError()
        for endpoint, target in zip(calculation["endpoints"], binding["targets"]):
            if (
                not isinstance(endpoint, dict)
                or set(endpoint) != {"role", "resolved_symbol", "entry", "exit"}
                or endpoint["role"] != target["role"]
                or endpoint["resolved_symbol"] != target["request_symbol"]
            ):
                raise MemoryValidationError()
