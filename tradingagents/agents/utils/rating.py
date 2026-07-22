"""Shared 5-tier rating vocabulary and a deterministic heuristic parser.

The same five-tier scale (Buy, Overweight, Hold, Underweight, Sell) is used by:
- The Research Manager (investment plan recommendation)
- The Portfolio Manager (final position decision)
- The signal processor (rating extracted for downstream consumers)
- The memory log (rating tag stored alongside each decision entry)

Centralising it here avoids drift between those call sites.
"""

from __future__ import annotations

import re
from typing import Tuple


# Canonical, ordered 5-tier scale (most bullish to most bearish).
RATINGS_5_TIER: Tuple[str, ...] = (
    "Buy",
    "Overweight",
    "Hold",
    "Underweight",
    "Sell",
)

# Free-text fallbacks may localise the label and punctuation even though the
# canonical rating remains English. Capture the full value so Chinese-only
# ratings can be normalised as well.
_RATING_LABEL_RE = re.compile(
    r"(?:rating|评级|建议|最终(?:交易)?决策|交易决策|决策|action|signal)"
    r"[\s*]*[：:\-][\s*]*(.+)",
    re.IGNORECASE,
)

_RATING_PATTERNS: Tuple[Tuple[str, Tuple[re.Pattern[str], ...]], ...] = (
    ("Buy", (re.compile(r"(?<![A-Za-z])buy(?![A-Za-z])", re.IGNORECASE), re.compile(r"买入|看多"))),
    (
        "Overweight",
        (
            re.compile(r"(?<![A-Za-z])overweight(?![A-Za-z])", re.IGNORECASE),
            re.compile(r"超配|增持|加仓"),
        ),
    ),
    (
        "Hold",
        (
            re.compile(r"(?<![A-Za-z])hold(?![A-Za-z])", re.IGNORECASE),
            re.compile(r"持有|观望|中性"),
        ),
    ),
    (
        "Underweight",
        (
            re.compile(r"(?<![A-Za-z])underweight(?![A-Za-z])", re.IGNORECASE),
            re.compile(r"低配|减持"),
        ),
    ),
    (
        "Sell",
        (
            re.compile(r"(?<![A-Za-z])sell(?![A-Za-z])", re.IGNORECASE),
            re.compile(r"卖出|清仓|看空"),
        ),
    ),
)


def parse_rating(text: str, default: str = "Hold") -> str:
    """Heuristically extract a 5-tier rating from prose text.

    Two-pass strategy:
    1. Look for an explicit "Rating: X" label (tolerant of markdown bold).
    2. Fall back to the first 5-tier rating word found anywhere in the text.

    Returns a Title-cased rating string, or ``default`` if no rating word appears.
    """
    for line in text.splitlines():
        match = _RATING_LABEL_RE.search(line)
        if match:
            rating = _find_first_rating(match.group(1))
            if rating:
                return rating

    rating = _find_first_rating(text)
    if rating:
        return rating

    return default


def _find_first_rating(text: str) -> str:
    earliest: tuple[int, str] | None = None
    for rating, patterns in _RATING_PATTERNS:
        for pattern in patterns:
            match = pattern.search(text)
            if match and (earliest is None or match.start() < earliest[0]):
                earliest = (match.start(), rating)
    return earliest[1] if earliest else ""
