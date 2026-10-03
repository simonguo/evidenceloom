"""Read the Portfolio Manager's own labelled rating without inferring a trade."""

from __future__ import annotations

import re
import unicodedata
from typing import Mapping, Any, Tuple

RATINGS_5_TIER: Tuple[str, ...] = ("Buy", "Overweight", "Hold", "Underweight", "Sell")
RATING_REVIEW = "REVIEW"
_RATINGS = {rating.lower(): rating for rating in (*RATINGS_5_TIER, RATING_REVIEW)}
_CHINESE_RATINGS = {
    "买入": "Buy",
    "看多": "Buy",
    "超配": "Overweight",
    "增持": "Overweight",
    "加仓": "Overweight",
    "持有": "Hold",
    "观望": "Hold",
    "中性": "Hold",
    "低配": "Underweight",
    "减持": "Underweight",
    "卖出": "Sell",
    "清仓": "Sell",
    "看空": "Sell",
    "待复核": RATING_REVIEW,
}
# A rating must introduce its own line, not quote a rating in a thesis, table,
# blockquote or scale. Accept the numbered labels written by older models.
_RATING_LINE_RE = re.compile(
    r"^\s*(?:\d+[.)]\s+)?[*_#\s]*(?:(?:final|our)\s+rating|rating|"
    r"(?:最终|建议|组合)?评级|最终(?:交易)?决策|交易决策|决策|建议)"
    r"[*_\s]*[:\-\u2010-\u2015][*_\s]*(.+)$",
    re.IGNORECASE,
)
_VALUE_RE = re.compile(r"^(Buy|Overweight|Hold|Underweight|Sell|REVIEW)\b", re.IGNORECASE)
_ENGLISH_RATING_RE = re.compile(r"\b(Buy|Overweight|Hold|Underweight|Sell|REVIEW)\b", re.IGNORECASE)
_EXPLANATION_RE = re.compile(r"\s+[\-\u2013\u2014]\s+|[:：;；.。]")


def normalize_rating(value: Any) -> str | None:
    """Normalize an already explicit rating, accepting the review sentinel."""
    if not isinstance(value, str):
        return None
    return _RATINGS.get(value.strip().lower())


def extract_rating(text: str) -> str | None:
    """Read the first explicit decision label; a prose rating word is no call."""
    if not isinstance(text, str) or not text:
        return None
    for line in unicodedata.normalize("NFKC", text).splitlines():
        match = _RATING_LINE_RE.match(line)
        if match is None:
            continue
        value = match.group(1).strip()
        # A label listing alternatives is not a call. Translated aliases of
        # the same rating are fine; explanations after a separator are prose.
        clause = _EXPLANATION_RE.split(value, maxsplit=1)[0]
        ratings = {
            normalize_rating(found.group(1)) for found in _ENGLISH_RATING_RE.finditer(clause)
        }
        ratings.update(rating for chinese, rating in _CHINESE_RATINGS.items() if chinese in clause)
        if len(ratings) > 1:
            return None
        english = _VALUE_RE.match(value)
        if english:
            return normalize_rating(english.group(1))
        for chinese, rating in _CHINESE_RATINGS.items():
            if value.startswith(chinese):
                return rating
    return None


def parse_rating(text: str, default: str = RATING_REVIEW) -> str:
    """Return a labelled rating, or REVIEW when the decision cannot be read."""
    return extract_rating(text) or default


def run_rating(final_state: Mapping[str, Any]) -> str:
    """Prefer the typed Portfolio Manager rating; support older saved states."""
    rating = normalize_rating(final_state.get("final_rating"))
    return rating or parse_rating(final_state.get("final_trade_decision", ""))
