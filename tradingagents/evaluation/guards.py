"""Small, bounded validation primitives for offline frozen research evaluation."""

from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime
import hashlib
import math
import re
from uuid import UUID

from tradingagents.evidence import sanitize_diagnostic
from tradingagents.memory.schema import canonical_json, hash_component, make_component

MAX_BYTES = 64 * 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024
MAX_ITEMS = 1000
SHA = re.compile(r"[a-f0-9]{64}\Z")
EVIDENCE_ID = re.compile(r"ev-[a-f0-9]{32}\Z")
FORBIDDEN_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "access_token",
        "authorization",
        "password",
        "secret",
        "headers",
        "cookies",
        "__proto__",
        "constructor",
        "prototype",
    }
)


class FrozenEvaluationError(ValueError):
    """A stable diagnostic that does not expose input, paths or configuration."""

    def __init__(self):
        super().__init__("Invalid or conflicting frozen research evaluation")


class FrozenEvaluationIOError(ValueError):
    def __init__(self):
        super().__init__("Frozen research evaluation could not be read or saved")


def fail():
    raise FrozenEvaluationError()


def checked(operation):
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
        OSError,
    ):
        raise FrozenEvaluationError() from None


def shape(value, keys, *, optional=()):
    if (
        not isinstance(value, dict)
        or not set(keys).issubset(value)
        or set(value) - set(keys) - set(optional)
    ):
        fail()


def text(value, *, nonempty=False, limit=MAX_TEXT_BYTES, sanitized=True):
    if not isinstance(value, str) or (nonempty and not value) or len(value.encode("utf-8")) > limit:
        fail()
    if sanitized and sanitize_diagnostic(value) != value:
        fail()
    return value


def identifier(value):
    return text(value, nonempty=True, limit=256)


def sha(value, *, nullable=False):
    if nullable and value is None:
        return
    if not isinstance(value, str) or not SHA.fullmatch(value):
        fail()


def uuid(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        fail()


def day(value):
    if not isinstance(value, str) or date.fromisoformat(value).isoformat() != value:
        fail()
    return value


def timestamp(value):
    text(value, nonempty=True, limit=64)
    if not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})",
        value,
    ):
        fail()
    # Python 3.10 accepts only three or six fractional digits. Normalize only
    # the parsing copy so the saved timestamp and its component hash stay exact.
    parse_value = re.sub(
        r"\.([0-9]{1,6})(?=Z|[+-])", lambda match: "." + match[1].ljust(6, "0"), value
    )
    parsed = datetime.fromisoformat(parse_value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        fail()
    return parsed


def integer(value, *, low=0, high=2**53 - 1):
    if type(value) is not int or not low <= value <= high:
        fail()
    return value


def bounded(value):
    """Check parsed JSON, retaining nulls, floats, raw text and field order."""

    def visit(item, depth=0):
        if depth > 64:
            fail()
        if item is None or type(item) is bool:
            return
        if type(item) is int:
            if abs(item) > 2**53 - 1:
                fail()
            return
        if type(item) is float:
            if not math.isfinite(item):
                fail()
            return
        if isinstance(item, str):
            text(item, limit=MAX_BYTES, sanitized=False)
            return
        if isinstance(item, list):
            for child in item:
                visit(child, depth + 1)
            return
        if isinstance(item, dict):
            for key, child in item.items():
                text(key, limit=1024)
                if key.lower() in FORBIDDEN_KEYS:
                    fail()
                visit(child, depth + 1)
            return
        fail()

    visit(value)
    if len(canonical_json(value).encode("utf-8")) > MAX_BYTES:
        fail()
    return deepcopy(value)


def component(value, own_hash):
    sha(value[own_hash])
    if hash_component(value, own_hash) != value[own_hash]:
        fail()


def section_sha(section):
    return hashlib.sha256(section.encode("utf-8")).hexdigest()


__all__ = ["FrozenEvaluationError", "FrozenEvaluationIOError", "make_component"]
