"""Capture exactly the sanitized inputs delivered to models, before delivery.

The canonical envelope contains integers and strings only. Normalized numerical
data lives in a canonical JSON *string*: floating values retain their roundtrip
precision without cross-language JSON number formatting changing a hash.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from datetime import date, datetime, timezone
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
from threading import RLock
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID, uuid4

from .persistence import atomic_save_bundle

PROVIDERS = frozenset(
    {
        "yfinance",
        "eastmoney",
        "tencent",
        "alpha_vantage",
        "akshare",
        "stocktwits",
        "reddit",
        "local_calculation",
        "unknown",
    }
)
ANALYSTS = frozenset({"market", "social", "news", "fundamentals", "identity"})
TOOLS = frozenset(
    {
        "get_stock_data",
        "get_indicators",
        "get_fundamentals",
        "get_balance_sheet",
        "get_cashflow",
        "get_income_statement",
        "get_news",
        "get_global_news",
        "get_insider_transactions",
        "get_market_data_snapshot",
        "get_verified_market_snapshot",
        "fetch_stocktwits_messages",
        "fetch_reddit_posts",
        "fetch_china_sentiment_sources",
        "resolve_instrument_context",
    }
)
PARAMETERS = frozenset(
    {
        "ticker",
        "symbol",
        "instrument",
        "trade_date",
        "curr_date",
        "start_date",
        "end_date",
        "indicator",
        "look_back_days",
        "lookback_days",
        "limit",
        "limit_per_sub",
        "subreddits",
        "freq",
        "interval",
        "time_period",
        "series_type",
        "queries",
    }
)
MANIFEST_KEYS = frozenset(
    {
        "core_version",
        "upstream_revision",
        "app_version",
        "llm_provider",
        "quick_think_llm",
        "deep_think_llm",
        "analysts",
        "max_debate_rounds",
        "max_risk_discuss_rounds",
        "max_tool_rounds",
        "analyst_concurrency_limit",
        "output_language",
        "temperature",
        "max_tokens",
        "data_vendors",
        "tool_vendors",
        "trade_date",
        "asset_type",
        "holding_period_days",
        "benchmark_ticker",
        "code_revision",
        "code_dirty",
        "code_sha256",
        "prompt_templates_sha256",
        "memory_input_sha256",
        "instrument_identity_context_sha256",
        "model_context_sha256",
    }
)
REPORT_KEYS = frozenset(
    {
        "market_report",
        "sentiment_report",
        "news_report",
        "fundamentals_report",
        "investment_plan",
        "trader_investment_plan",
        "final_trade_decision",
        "investment_debate_state.bull_history",
        "investment_debate_state.bear_history",
        "investment_debate_state.judge_decision",
        "risk_debate_state.aggressive_history",
        "risk_debate_state.conservative_history",
        "risk_debate_state.neutral_history",
        "risk_debate_state.judge_decision",
    }
)
STATUSES = frozenset({"available", "partial", "empty", "unavailable", "withheld"})
ATTEMPT_STATUSES = (STATUSES - {"partial"}) | {"not_configured"}
MAX_BYTES = 64 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
_HEX = re.compile(r"^[0-9a-f]{64}$")
_ID = re.compile(r"^ev-[0-9a-f]{32}$")
_CITATION = re.compile(r"\[E:([^\]\[]*)\]|\[E:")
_URL = re.compile(r"https?://[^\s<>\"\)\]\}]+", re.IGNORECASE)
_KEY = re.compile(r"(?i)\b(?:sk|hy|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}")
_BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+")
_LABELLED_SECRET = re.compile(
    r"(?i)(\b(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\b[\"']?\s*[=:]\s*[\"']?)"
    r"(?:Bearer\s+)?[^\s,;\"'}]+"
)
_PRIVATE_PATH = re.compile(
    r"(?:/(?:Users|home|tmp|private|var/folders)/[^\s<>\"']+|[A-Za-z]:\\[^\s<>\"']+)"
)
_SECRET_FIELDS = frozenset(
    {
        "api_key",
        "apikey",
        "access_token",
        "authorization",
        "password",
        "secret",
        "headers",
        "cookies",
        "raw_response",
        "backend_url",
    }
)
_ledger_context = ContextVar("research_evidence_ledger", default=None)
_analyst_context = ContextVar("research_evidence_analyst", default="identity")
_capture_context = ContextVar("research_evidence_capture", default=None)


class EvidencePersistenceError(ValueError):
    """A source must not reach a model when its evidence cannot be saved."""


class EvidenceSourceError(RuntimeError):
    """An unhandled source failure without the upstream response or endpoint."""


def _collect_secrets(secrets=()):
    return tuple(secrets) + tuple(
        v
        for k, v in os.environ.items()
        if any(x in k.lower() for x in ("api_key", "access_token", "password", "secret"))
        or k.upper().endswith("_TOKEN")
    )


def sanitize_diagnostic(value, *, secrets=()):
    """Keep useful validation messages without paths, endpoint queries or keys."""
    return _safe_text(value, _collect_secrets(secrets))


def _canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    )


def _sha(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _date(value):
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        raise ValueError("Invalid evidence date")
    return value


def _timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value
    ):
        raise ValueError("Invalid evidence timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset().total_seconds() != 0:
        raise ValueError("Invalid evidence timestamp")
    return parsed


def _public_url(value):
    if not isinstance(value, str):
        return None
    try:
        parts = urlsplit(value)
        host = (parts.hostname or "").lower()
        if parts.scheme not in {"http", "https"} or not host or "." not in host:
            return None
        if (
            host.endswith((".local", ".internal", ".localhost", ".invalid", ".test"))
            or host == "localhost"
        ):
            return None
        try:
            ipaddress.ip_address(host)
            return None
        except ValueError:
            if re.fullmatch(r"[\d.]+", host):
                return None
        port = parts.port
        if port is not None:
            return None
        netloc = f"[{host}]" if ":" in host else host
        if port is not None:
            netloc += f":{port}"
        path = _KEY.sub("[redacted]", parts.path)
        return urlunsplit((parts.scheme, netloc, path, "", ""))
    except (ValueError, UnicodeError):
        return None


def _safe_text(value, secrets=()):
    text = str(value).encode("utf-8", errors="replace").decode("utf-8")
    # Remove URL credentials/query parameters before redacting labelled keys,
    # otherwise a replacement marker can leave stray characters in a URL.
    text = _URL.sub(lambda m: _public_url(m.group()) or "[private URL withheld]", text)
    for secret in secrets:
        if isinstance(secret, str) and len(secret) >= 4:
            text = text.replace(secret, "[redacted]")
    text = _KEY.sub("[redacted]", text)
    text = _BEARER.sub("Bearer [redacted]", text)
    text = _LABELLED_SECRET.sub(r"\1[redacted]", text)
    return _PRIVATE_PATH.sub("[local path withheld]", text)


def _normalize(value, secrets=(), *, numbers_as_strings=False, depth=0):
    if depth > 32:
        raise ValueError("Evidence input exceeds nesting limit")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return _safe_text(value, secrets)
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            return str(value)
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        return repr(value) if numbers_as_strings else value
    if isinstance(value, (list, tuple)):
        return [
            _normalize(v, secrets, numbers_as_strings=numbers_as_strings, depth=depth + 1)
            for v in value
        ]
    if isinstance(value, dict):
        return {
            _safe_text(k, secrets): _normalize(
                v, secrets, numbers_as_strings=numbers_as_strings, depth=depth + 1
            )
            for k, v in value.items()
            if isinstance(k, str) and k.lower() not in _SECRET_FIELDS
        }
    raise ValueError("Evidence inputs must be normalized JSON values")


def _only_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise ValueError("Invalid evidence fields")


def _envelope_json(value, *, depth=0):
    if depth > 32:
        raise ValueError("Invalid evidence nesting")
    if value is None or isinstance(value, bool):
        return
    if isinstance(value, str):
        if len(value.encode("utf-8")) > 8_000_000:
            raise ValueError("Evidence text exceeds size limit")
        if _safe_text(value) != value:
            raise ValueError("Unsafe evidence content")
        return
    if isinstance(value, int) and abs(value) <= MAX_SAFE_INTEGER:
        return
    if isinstance(value, list):
        for item in value:
            _envelope_json(item, depth=depth + 1)
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if (
                not isinstance(key, str)
                or key.lower() in _SECRET_FIELDS
                or key in {"__proto__", "constructor", "prototype"}
                or _safe_text(key) != key
            ):
                raise ValueError("Unsafe evidence fields")
            _envelope_json(item, depth=depth + 1)
        return
    raise ValueError("Invalid evidence JSON type")


def _rehash(bundle):
    bundle["bundle_sha256"] = _sha({k: v for k, v in bundle.items() if k != "bundle_sha256"})
    return bundle


def _has_observed_data(artifacts):
    for artifact in artifacts.values():
        data = json.loads(artifact["payload"])
        if isinstance(data, dict):
            collections = [
                data[k]
                for k in (
                    "rows",
                    "articles",
                    "transactions",
                    "posts",
                    "messages",
                    "values",
                    "fields",
                )
                if k in data
            ]
            if collections:
                if any(collections):
                    return True
                continue
        if data:
            return True
    return False


def validate_evidence_bundle(value):
    """Reject corrupted, contradictory or unsafe bundles; never silently repair."""
    try:
        _validate(value)
        return deepcopy(value)
    except (
        ValueError,
        TypeError,
        KeyError,
        OverflowError,
        RecursionError,
        UnicodeError,
        AttributeError,
    ):
        raise ValueError("Invalid or corrupted research evidence bundle") from None


def _validate(bundle):
    _only_keys(
        bundle,
        {
            "schema_version",
            "run_id",
            "instrument",
            "analysis_date",
            "research_as_of",
            "as_of_policy",
            "market_timezone",
            "created_at",
            "manifest",
            "manifest_sha256",
            "records",
            "artifacts",
            "citation_audit",
            "bundle_sha256",
        },
    )
    if type(bundle["schema_version"]) is not int or bundle["schema_version"] != 1:
        raise ValueError("Invalid evidence schema")
    if str(UUID(bundle["run_id"])) != bundle["run_id"]:
        raise ValueError("Invalid evidence run")
    if not isinstance(bundle["instrument"], str) or not 0 < len(bundle["instrument"]) <= 128:
        raise ValueError("Invalid evidence instrument")
    _date(bundle["analysis_date"])
    cutoff = _timestamp(bundle["research_as_of"])
    if bundle["research_as_of"] != bundle["analysis_date"] + "T23:59:59.999999Z":
        raise ValueError("Invalid research cutoff")
    _timestamp(bundle["created_at"])
    if bundle["as_of_policy"] != "analysis_date_end_utc":
        raise ValueError("Invalid evidence cutoff policy")
    if bundle["market_timezone"] is not None and not isinstance(bundle["market_timezone"], str):
        raise ValueError("Invalid market timezone")
    manifest = bundle["manifest"]
    if not isinstance(manifest, dict) or not set(manifest).issubset(MANIFEST_KEYS):
        raise ValueError("Invalid evidence manifest")
    for key, allowed in (
        (
            "data_vendors",
            {"core_stock_apis", "technical_indicators", "fundamental_data", "news_data"},
        ),
        ("tool_vendors", TOOLS),
    ):
        if key in manifest and (
            not isinstance(manifest[key], dict)
            or not set(manifest[key]).issubset(allowed)
            or not all(isinstance(v, str) for v in manifest[key].values())
        ):
            raise ValueError("Invalid evidence vendor configuration")
    if _sha(manifest) != bundle["manifest_sha256"]:
        raise ValueError("Evidence manifest hash mismatch")
    for key, val in manifest.items():
        if key.endswith("_sha256") and (not isinstance(val, str) or not _HEX.fullmatch(val)):
            raise ValueError("Invalid evidence context digest")
    if not isinstance(bundle["records"], list) or len(bundle["records"]) > 4096:
        raise ValueError("Invalid evidence records")
    artifacts = bundle["artifacts"]
    if not isinstance(artifacts, dict) or len(artifacts) > 16384:
        raise ValueError("Invalid evidence artifacts")
    for digest, artifact in artifacts.items():
        _only_keys(artifact, {"kind", "payload"})
        if not _HEX.fullmatch(digest) or _sha(artifact) != digest:
            raise ValueError("Evidence artifact hash mismatch")
        if artifact["kind"] not in {"tool_text", "normalized_data"} or not isinstance(
            artifact["payload"], str
        ):
            raise ValueError("Invalid evidence artifact")
        if artifact["kind"] == "normalized_data":
            # Reject raw envelopes/credentials even inside the JSON string.
            normalized = json.loads(artifact["payload"])
            if _normalize(normalized) != normalized:
                raise ValueError("Unsafe normalized evidence")
    ids, references = set(), set()
    for record in bundle["records"]:
        _only_keys(
            record,
            {
                "id",
                "analyst",
                "tool",
                "instrument",
                "parameters",
                "status",
                "fetched_at",
                "output_sha256",
                "sources",
                "attempts",
            },
        )
        evidence_id = record["id"]
        if not isinstance(evidence_id, str) or not _ID.fullmatch(evidence_id) or evidence_id in ids:
            raise ValueError("Invalid evidence identity")
        ids.add(evidence_id)
        if (
            record["analyst"] not in ANALYSTS
            or record["tool"] not in TOOLS
            or record["instrument"] != bundle["instrument"]
        ):
            raise ValueError("Invalid evidence ownership")
        if not isinstance(record["parameters"], dict) or not set(record["parameters"]).issubset(
            PARAMETERS
        ):
            raise ValueError("Invalid evidence parameters")
        if record["status"] not in STATUSES:
            raise ValueError("Invalid evidence status")
        _timestamp(record["fetched_at"])
        output = artifacts[record["output_sha256"]]
        references.add(record["output_sha256"])
        if output["kind"] != "tool_text" or not output["payload"].startswith(
            f"[E:{evidence_id}]\n"
        ):
            raise ValueError("Evidence input does not match its identity")
        if not isinstance(record["sources"], list) or len(record["sources"]) > 1024:
            raise ValueError("Invalid evidence sources")
        for source in record["sources"]:
            _only_keys(
                source,
                {
                    "provider",
                    "url",
                    "observed_window",
                    "publication_dates",
                    "historical_availability",
                    "units",
                    "adjustments",
                    "transformations",
                    "data_sha256",
                },
            )
            if source["provider"] not in PROVIDERS or source["historical_availability"] not in {
                "unknown",
                "within_as_of",
                "withheld",
            }:
                raise ValueError("Invalid evidence provider")
            if source["url"] is not None and _public_url(source["url"]) != source["url"]:
                raise ValueError("Unsafe evidence URL")
            for key in ("units", "adjustments"):
                if source[key] is not None and not isinstance(source[key], str):
                    raise ValueError("Invalid evidence metadata")
            if not isinstance(source["transformations"], list) or not all(
                isinstance(x, str) for x in source["transformations"]
            ):
                raise ValueError("Invalid evidence transformations")
            future = False
            if source["observed_window"] is not None:
                window = source["observed_window"]
                _only_keys(window, {"start", "end"})
                if _date(window["start"]) > _date(window["end"]):
                    raise ValueError("Invalid observed evidence window")
                future = window["end"] > bundle["analysis_date"]
            dates = source["publication_dates"]
            if dates is not None:
                if not isinstance(dates, list) or len(dates) > 10000:
                    raise ValueError("Invalid publication dates")
                future = future or any(_timestamp(d) > cutoff for d in dates)
            if future and (
                source["historical_availability"] != "withheld" or record["status"] != "withheld"
            ):
                raise ValueError("Future evidence must be withheld")
            digest = source["data_sha256"]
            if digest is not None:
                if artifacts[digest]["kind"] != "normalized_data":
                    raise ValueError("Invalid normalized evidence reference")
                references.add(digest)
        if not isinstance(record["attempts"], list) or len(record["attempts"]) > 1024:
            raise ValueError("Invalid evidence attempts")
        for attempt in record["attempts"]:
            _only_keys(attempt, {"provider", "status", "elapsed_ms"})
            if (
                attempt["provider"] not in PROVIDERS
                or attempt["status"] not in ATTEMPT_STATUSES
                or type(attempt["elapsed_ms"]) is not int
                or not 0 <= attempt["elapsed_ms"] <= MAX_SAFE_INTEGER
            ):
                raise ValueError("Invalid evidence attempt")
    if references != set(artifacts):
        raise ValueError("Unreferenced evidence artifact")
    audit = bundle["citation_audit"]
    if not isinstance(audit, dict) or not set(audit).issubset(REPORT_KEYS):
        raise ValueError("Invalid citation report")
    for entry in audit.values():
        _only_keys(entry, {"referenced_ids", "unresolved_ids", "status"})
        refs, missing = entry["referenced_ids"], entry["unresolved_ids"]
        if (
            not isinstance(refs, list)
            or len(refs) > 10000
            or len(set(refs)) != len(refs)
            or not all(
                isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", x) for x in refs
            )
        ):
            raise ValueError("Invalid citation identities")
        if missing != [x for x in refs if x not in ids]:
            raise ValueError("Invalid citation resolution")
        expected = "unresolved" if missing else "resolved" if refs else "none"
        if entry["status"] != expected:
            raise ValueError("Invalid citation status")
    _envelope_json(bundle)
    if len(_canonical(bundle).encode("utf-8")) > MAX_BYTES:
        raise ValueError("Evidence bundle exceeds size limit")
    if _sha({k: v for k, v in bundle.items() if k != "bundle_sha256"}) != bundle["bundle_sha256"]:
        raise ValueError("Evidence bundle hash mismatch")


def audit_citations(bundle, reports):
    result = validate_evidence_bundle(bundle)
    ids = {r["id"] for r in result["records"]}
    for key, text in reports.items():
        if text is None:
            text = ""
        if key not in REPORT_KEYS or not isinstance(text, str):
            continue
        refs = list(
            dict.fromkeys(
                x if re.fullmatch(r"[A-Za-z0-9_-]{1,100}", x) else "invalid-citation"
                for x in _CITATION.findall(text)
            )
        )
        missing = [x for x in refs if x not in ids]
        result["citation_audit"][key] = {
            "referenced_ids": refs,
            "unresolved_ids": missing,
            "status": "unresolved" if missing else "resolved" if refs else "none",
        }
    return validate_evidence_bundle(_rehash(result))


def merge_evidence_bundles(previous, update):
    if not previous:
        return validate_evidence_bundle(update) if update else {}
    if not update:
        return validate_evidence_bundle(previous)
    result, other = validate_evidence_bundle(previous), validate_evidence_bundle(update)
    for key in set(result) - {"records", "artifacts", "citation_audit", "bundle_sha256"}:
        if result[key] != other[key]:
            raise ValueError("Research evidence belongs to a different frozen run")
    records = {r["id"]: r for r in result["records"]}
    for record in other["records"]:
        old = records.get(record["id"])
        if old is not None and old != record:
            raise ValueError("Conflicting immutable research evidence record")
        if old is None:
            records[record["id"]] = record
    result["records"] = list(records.values())
    for digest, artifact in other["artifacts"].items():
        if digest in result["artifacts"] and result["artifacts"][digest] != artifact:
            raise ValueError("Conflicting immutable research evidence artifact")
        result["artifacts"][digest] = artifact
    result["citation_audit"].update(other["citation_audit"])
    # A previously unresolved reference can resolve after private branches join.
    ids = set(records)
    for entry in result["citation_audit"].values():
        entry["unresolved_ids"] = [x for x in entry["referenced_ids"] if x not in ids]
        entry["status"] = (
            "unresolved"
            if entry["unresolved_ids"]
            else "resolved"
            if entry["referenced_ids"]
            else "none"
        )
    return validate_evidence_bundle(_rehash(result))


def current_ledger():
    return _ledger_context.get()


@contextmanager
def analyst_evidence(name):
    if name not in ANALYSTS:
        raise ValueError("Unknown evidence analyst")
    token = _analyst_context.set(name)
    try:
        yield
    finally:
        _analyst_context.reset(token)


class EvidenceLedger:
    def __init__(
        self, instrument, analysis_date, manifest, storage_dir, *, market_timezone=None, secrets=()
    ):
        self._lock = RLock()
        self._storage_dir = Path(storage_dir)
        self._secrets = _collect_secrets(secrets)
        self._replay = {}
        self._bundle = _rehash(
            {
                "schema_version": 1,
                "run_id": str(uuid4()),
                "instrument": _safe_text(instrument, self._secrets),
                "analysis_date": _date(analysis_date),
                "research_as_of": analysis_date + "T23:59:59.999999Z",
                "as_of_policy": "analysis_date_end_utc",
                "market_timezone": market_timezone,
                "created_at": _utc_now(),
                "manifest": _normalize(
                    {k: v for k, v in manifest.items() if k in MANIFEST_KEYS},
                    self._secrets,
                    numbers_as_strings=True,
                ),
                "manifest_sha256": "",
                "records": [],
                "artifacts": {},
                "citation_audit": {},
            }
        )
        self._bundle["manifest_sha256"] = _sha(self._bundle["manifest"])
        _rehash(self._bundle)
        self._bundle = self._persist(self._bundle)

    @classmethod
    def restore(cls, bundle, storage_dir, *, secrets=()):
        checkpoint = validate_evidence_bundle(bundle)
        committed_ids = {record["id"] for record in checkpoint["records"]}
        ledger = cls.__new__(cls)
        ledger._lock, ledger._storage_dir, ledger._secrets = (
            RLock(),
            Path(storage_dir),
            _collect_secrets(secrets),
        )
        path = ledger._storage_dir / checkpoint["run_id"] / "bundle.json"
        try:
            if path.exists():
                if path.stat().st_size > MAX_BYTES:
                    raise ValueError("Invalid or corrupted research evidence bundle")
                checkpoint = merge_evidence_bundles(
                    checkpoint, json.loads(path.read_text(encoding="utf-8"))
                )
        except OSError:
            raise EvidencePersistenceError("Research evidence could not be restored") from None
        checkpoint = ledger._persist(checkpoint)
        ledger._bundle, ledger._replay = checkpoint, {}
        for record in checkpoint["records"]:
            if record["id"] not in committed_ids:
                ledger._replay.setdefault(
                    ledger._call_key(record["analyst"], record["tool"], record["parameters"]), []
                ).append(record["id"])
        return ledger

    @staticmethod
    def _call_key(analyst, tool, parameters):
        return (analyst, tool, _canonical(parameters))

    @contextmanager
    def bind(self):
        token = _ledger_context.set(self)
        try:
            yield self
        finally:
            _ledger_context.reset(token)

    def _persist(self, value):
        try:
            return atomic_save_bundle(
                self._storage_dir,
                value,
                validate_evidence_bundle,
                merge_evidence_bundles,
                _canonical,
            )
        except OSError:
            raise EvidencePersistenceError(
                "Research evidence could not be saved; analysis stopped before using this source"
            ) from None

    def bundle(self, analyst=None, reports=None):
        with self._lock:
            if reports is not None:
                candidate = audit_citations(self._bundle, reports)
                self._bundle = self._persist(candidate)
            result = deepcopy(self._bundle)
            if analyst is not None:
                if analyst not in ANALYSTS:
                    raise ValueError("Unknown evidence analyst")
                result["records"] = [r for r in result["records"] if r["analyst"] == analyst]
                used = {r["output_sha256"] for r in result["records"]}
                used.update(
                    s["data_sha256"]
                    for r in result["records"]
                    for s in r["sources"]
                    if s["data_sha256"]
                )
                result["artifacts"] = {k: v for k, v in result["artifacts"].items() if k in used}
                result["citation_audit"] = {}
                _rehash(result)
            return validate_evidence_bundle(result)

    def capture(self, tool, parameters, operation):
        if tool not in TOOLS:
            raise ValueError("Unknown evidence tool")
        parameters = _normalize(
            {k: v for k, v in parameters.items() if k in PARAMETERS},
            self._secrets,
            numbers_as_strings=True,
        )
        analyst = _analyst_context.get()
        key = self._call_key(analyst, tool, parameters)
        with self._lock:
            replay = self._replay.get(key)
            if replay:
                evidence_id = replay.pop(0)
                record = next(r for r in self._bundle["records"] if r["id"] == evidence_id)
                return self._bundle["artifacts"][record["output_sha256"]]["payload"]
        capture = {"sources": [], "attempts": [], "artifacts": {}, "future": False}
        token = _capture_context.set(capture)
        error = None
        try:
            raw = operation()
        except Exception as exc:
            raw, error = "DATA_UNAVAILABLE: source operation failed; no values were supplied.", exc
        finally:
            _capture_context.reset(token)
        text = _safe_text(raw, self._secrets)
        if capture["future"] or (
            capture["sources"]
            and all(s["historical_availability"] == "withheld" for s in capture["sources"])
        ):
            reason = (
                "observed source dates exceed the research cutoff"
                if capture["future"]
                else "historical source availability is not established for this research cutoff"
            )
            text = f"HISTORICAL_WITHHELD: {reason}; no values were supplied."
            capture["artifacts"] = {}
            for source in capture["sources"]:
                source["data_sha256"] = None
                source["historical_availability"] = "withheld"
        lower = text.lower()
        usable = _has_observed_data(capture["artifacts"])
        unavailable_notice = (
            "data_unavailable" in lower
            or "no_data_available" in lower
            or lower.startswith("error")
            or re.search(r"<[^>]*(?:unavailable|not configured)", lower) is not None
        )
        empty_notice = (
            not text.strip()
            or "no news found" in lower
            or "no insider transactions" in lower
            or re.search(r"(?:^|<)no [^>\n]*(?:messages|posts|articles)", lower) is not None
            or (capture["attempts"] and capture["attempts"][-1]["status"] == "empty")
        )
        if (
            capture["future"]
            or "historical_withheld" in lower
            or (
                capture["sources"]
                and all(s["historical_availability"] == "withheld" for s in capture["sources"])
            )
        ):
            status = "withheld"
        elif error is not None or (unavailable_notice and not usable):
            status = "unavailable"
        elif empty_notice and not usable:
            status = "empty"
        elif (
            unavailable_notice
            or empty_notice
            or any(a["status"] in {"unavailable", "empty", "withheld"} for a in capture["attempts"])
        ):
            status = "partial"
        else:
            status = "available"
        evidence_id = "ev-" + uuid4().hex
        text = f"[E:{evidence_id}]\n{text}"
        artifact = {"kind": "tool_text", "payload": text}
        digest = _sha(artifact)
        capture["artifacts"][digest] = artifact
        record = {
            "id": evidence_id,
            "analyst": analyst,
            "tool": tool,
            "instrument": self._bundle["instrument"],
            "parameters": parameters,
            "status": status,
            "fetched_at": _utc_now(),
            "output_sha256": digest,
            "sources": capture["sources"],
            "attempts": capture["attempts"],
        }
        with self._lock:
            candidate = deepcopy(self._bundle)
            candidate["records"].append(record)
            candidate["artifacts"].update(capture["artifacts"])
            _rehash(candidate)
            self._bundle = self._persist(candidate)
        if error is not None:
            if isinstance(error, EvidencePersistenceError):
                raise error from None
            raise EvidenceSourceError(
                "Research source retrieval failed; no source values were supplied"
            ) from None
        return text


def capture_evidence(tool, parameters, operation):
    ledger = current_ledger()
    return operation() if ledger is None else ledger.capture(tool, parameters, operation)


def observe_attempt(provider, status, elapsed_ms=0):
    capture = _capture_context.get()
    if capture is None:
        return
    if provider not in PROVIDERS or status not in ATTEMPT_STATUSES:
        raise ValueError("Invalid evidence provider attempt")
    capture["attempts"].append(
        {"provider": provider, "status": status, "elapsed_ms": max(0, int(elapsed_ms))}
    )


def observe_source(
    provider,
    *,
    url=None,
    normalized_data=None,
    observed_window=None,
    publication_dates=None,
    historical_availability="unknown",
    units=None,
    adjustments=None,
    transformations=(),
):
    capture, ledger = _capture_context.get(), current_ledger()
    if capture is None or ledger is None:
        return
    if provider not in PROVIDERS or historical_availability not in {
        "unknown",
        "within_as_of",
        "withheld",
    }:
        raise ValueError("Invalid evidence provider metadata")
    window = deepcopy(observed_window)
    dates = deepcopy(publication_dates)
    future = False
    if window is not None:
        _only_keys(window, {"start", "end"})
        _date(window["start"])
        _date(window["end"])
        future = window["end"] > ledger._bundle["analysis_date"]
    if dates is not None:
        future = future or any(
            _timestamp(d) > _timestamp(ledger._bundle["research_as_of"]) for d in dates
        )
    if future:
        historical_availability = "withheld"
        capture["future"] = True
    digest = None
    if normalized_data is not None and not future and historical_availability != "withheld":
        artifact = {
            "kind": "normalized_data",
            "payload": _canonical(_normalize(normalized_data, ledger._secrets)),
        }
        digest = _sha(artifact)
        capture["artifacts"][digest] = artifact
    capture["sources"].append(
        {
            "provider": provider,
            "url": _public_url(_safe_text(url, ledger._secrets)) if url else None,
            "observed_window": window,
            "publication_dates": dates,
            "historical_availability": historical_availability,
            "units": _safe_text(units, ledger._secrets) if units is not None else None,
            "adjustments": _safe_text(adjustments, ledger._secrets)
            if adjustments is not None
            else None,
            "transformations": [_safe_text(x, ledger._secrets) for x in transformations],
            "data_sha256": digest,
        }
    )
