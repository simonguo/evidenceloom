"""Exact UTF-8 spans and conservative whole ASCII number selection."""

from __future__ import annotations

import re
import unicodedata

_TOKEN = re.compile(r"[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_SCALE = re.compile(
    r"(?:[%‰‱％٪千万亿萬億兆]|(?:[kmbt]|bps?|million|billion|trillion)(?![A-Za-z0-9_]))",
    re.I | re.ASCII,
)
_MINUS = frozenset("-+−﹣－＋﹢±")
_TOKEN_BYTES = re.compile(_TOKEN.pattern.encode("ascii"))


class _SectionSpans:
    """Private operation-local bytes and boundaries; no retained long prefixes."""

    def __init__(self, section):
        self.raw = section.encode("utf-8")
        self._parts = {}
        self._tokens = None

    def parts(self, span):
        if not isinstance(span, dict) or set(span) != {"start_byte", "end_byte", "text"}:
            raise ValueError("Invalid saved numeric review")
        start, end, text = span["start_byte"], span["end_byte"], span["text"]
        if type(start) is not int or type(end) is not int or not isinstance(text, str):
            raise ValueError("Invalid saved numeric review")
        if not 0 <= start < end <= len(self.raw):
            raise ValueError("Invalid saved numeric review")
        key = start, end
        if key not in self._parts:
            try:
                prefix = self.raw[:start].decode("utf-8")
                selected = self.raw[start:end].decode("utf-8")
                suffix = self.raw[end:].decode("utf-8")
            except UnicodeError:
                raise ValueError("Invalid saved numeric review") from None
            self._parts[key] = (
                selected,
                prefix[-2:],
                suffix[:2],
                _SCALE.match(suffix.lstrip(" \t")) is not None,
            )
        parts = self._parts[key]
        if parts[0] != text:
            raise ValueError("Invalid saved numeric review")
        return parts

    def numeric(self, span):
        _, prefix, suffix, scaled = self.parts(span)
        if self._tokens is None:
            # The grammar contains only ASCII literals: byte matching has the
            # same tokens as text matching, with exact frozen UTF-8 offsets.
            self._tokens = {(m.start(), m.end()) for m in _TOKEN_BYTES.finditer(self.raw)}
        if (span["start_byte"], span["end_byte"]) not in self._tokens:
            return False
        return _supported_neighbors(prefix, suffix) and not scaled

    def context(self, span):
        _, prefix, suffix, _ = self.parts(span)
        return _supported_context_neighbors(prefix, suffix)


def span_text(section: str, span: dict) -> tuple[str, str, str]:
    """Return exact text/prefix/suffix; invalid boundaries are structural errors."""
    if not isinstance(span, dict) or set(span) != {"start_byte", "end_byte", "text"}:
        raise ValueError("Invalid saved numeric review")
    start, end, text = span["start_byte"], span["end_byte"], span["text"]
    if type(start) is not int or type(end) is not int or not isinstance(text, str):
        raise ValueError("Invalid saved numeric review")
    try:
        raw = section.encode("utf-8")
        if not 0 <= start < end <= len(raw):
            raise ValueError
        prefix, selected, suffix = (
            raw[:start].decode("utf-8"),
            raw[start:end].decode("utf-8"),
            raw[end:].decode("utf-8"),
        )
        if selected != text:
            raise ValueError
        return selected, prefix, suffix
    except (ValueError, UnicodeError):
        raise ValueError("Invalid saved numeric review") from None


def supported_numeric_span(section: str, span: dict) -> bool:
    """Partial numbers, grouped/localized and scale suffixes are unsupported."""
    text, prefix, suffix = span_text(section, span)
    # Search the original text so signs and exponent continuations cannot be
    # dropped from the chosen span. Ordinary 'Close125.02' remains supported.
    start = len(prefix)
    if not any(
        m.start() == start and m.end() == start + len(text) for m in _TOKEN.finditer(section)
    ):
        return False
    return _supported_neighbors(prefix, suffix) and _SCALE.match(suffix.lstrip(" \t")) is None


def _supported_neighbors(prefix, suffix):
    before, after = prefix[-1:], suffix[:1]
    if before and (before in _MINUS or before == "_" or unicodedata.category(before)[0] == "N"):
        return False
    if before in {".", "٫", "．"}:
        return False  # selecting 5 from a leading-decimal .5 is partial
    if after and (after in {"_", "e", "E"} or unicodedata.category(after)[0] == "N"):
        return False
    if (
        before in {".", ",", "٫", "٬", "．", "，"}
        and len(prefix) > 1
        and unicodedata.category(prefix[-2])[0] == "N"
    ):
        return False
    if (
        after in {".", ",", "٫", "٬", "．", "，"}
        and len(suffix) > 1
        and unicodedata.category(suffix[1])[0] == "N"
    ):
        return False
    # NBSP/narrow/thin-space group separators cannot be treated as a boundary.
    if (
        before in {"\u00a0", "\u202f", "\u2009"}
        and len(prefix) > 1
        and unicodedata.category(prefix[-2])[0] == "N"
    ):
        return False
    if (
        after in {"\u00a0", "\u202f", "\u2009"}
        and len(suffix) > 1
        and unicodedata.category(suffix[1])[0] == "N"
    ):
        return False
    return True


def supported_context_span(section: str, span: dict) -> bool:
    """A literal context selection cannot be a substring of an ASCII token.

    This does not establish what the surrounding prose asserts. Ordinary CJK
    labels adjacent to an exact ticker/date/unit literal remain permissible.
    """
    _, prefix, suffix = span_text(section, span)
    return _supported_context_neighbors(prefix, suffix)


def _supported_context_neighbors(prefix, suffix):

    def part(char):
        return bool(char) and (char == "_" or char.isascii() and char.isalnum())

    return not part(prefix[-1:]) and not part(suffix[:1])
