"""Reddit search fetcher for ticker-specific discussion posts.

Primary path is Reddit's public JSON search endpoint
(``reddit.com/r/{sub}/search.json``), which carries the richest data
(score, comment count, body). Reddit's WAF increasingly returns
``HTTP 403 Blocked`` on that endpoint (issue #862), so when the JSON request
fails we transparently fall back to the public Atom/RSS search feed
(``/search.rss``). The RSS feed is gated less aggressively and serves the
same descriptive User-Agent we already send; the fallback lacks score /
comment counts, so RSS-sourced posts are marked and the formatter omits those
metrics rather than printing fake zeros.

No API key required either way. Returns formatted plaintext blocks ready for
prompt injection and degrades gracefully — returns a placeholder string
rather than raising, so callers never special-case missing data.
"""

from __future__ import annotations

import html
import http.client
import json
import logging
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .date_window import coverage_gap, in_window, is_historical
from .evidence_utils import scalar, source_attempt
from tradingagents.evidence import capture_evidence, observe_source

logger = logging.getLogger(__name__)

_API = "https://www.reddit.com/r/{sub}/search.json?{qs}"
_RSS = "https://www.reddit.com/r/{sub}/search.rss?{qs}"
# A descriptive, identified User-Agent (per Reddit's API etiquette). Reddit
# blocks generic/anonymous tokens like bare "Mozilla/5.0" or "curl/…" but
# serves this one on both endpoints; the RSS feed accepts it even when the
# JSON search endpoint 403s, so no browser-spoofing is needed.
_UA = "tradingagents/0.2 (+https://github.com/TauricResearch/TradingAgents)"
_ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}

# Default subreddits ordered roughly by signal density for ticker-specific
# discussion. wallstreetbets has the most volume but most noise; stocks /
# investing trend more measured. Caller can override.
DEFAULT_SUBREDDITS = ("wallstreetbets", "stocks", "investing")


def _posted_at(post) -> datetime | None:
    try:
        return datetime.fromtimestamp(post.get("created_utc"), tz=timezone.utc)
    except (ValueError, TypeError, OSError):
        return None


def _within_window(posts, start_date, end_date):
    if not (start_date and end_date):
        return posts
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    return [p for p in posts if in_window(_posted_at(p), start, end)]


def _search_qs(ticker: str, limit: int) -> str:
    return urlencode(
        {
            "q": ticker,
            "restrict_sr": "on",
            "sort": "new",
            "t": "week",  # last 7 days
            "limit": limit,
        }
    )


def _iso_to_timestamp(iso_str: Optional[str]) -> Optional[float]:
    """Parse an Atom ``published`` timestamp to a UTC epoch, or None."""
    if not iso_str:
        return None
    try:
        normalized = iso_str[:-1] + "+00:00" if iso_str.endswith("Z") else iso_str
        return datetime.fromisoformat(normalized).timestamp()
    except (ValueError, TypeError):
        return None


def _strip_html(content: str) -> str:
    """Reduce the HTML body Reddit embeds in an Atom entry to plain text."""
    if not content:
        return ""
    # Reddit wraps the real selftext between SC_OFF / SC_ON markers.
    if "<!-- SC_OFF -->" in content and "<!-- SC_ON -->" in content:
        content = content.split("<!-- SC_OFF -->")[1].split("<!-- SC_ON -->")[0]
    text = re.sub(r"<[^>]+>", " ", content)
    return " ".join(html.unescape(text).split())


def _fetch_subreddit_rss(
    ticker: str,
    sub: str,
    limit: int,
    timeout: float,
) -> list[dict]:
    """Fallback path: parse the public Atom search feed for a subreddit.

    Carries no score / comment counts, so those fields are left None and the
    post is tagged ``source="rss"`` for honest display.
    """
    url = _RSS.format(sub=sub, qs=_search_qs(ticker, limit))
    req = Request(url, headers={"User-Agent": _UA})
    started = time.monotonic()
    try:
        with urlopen(req, timeout=timeout) as resp:
            root = ET.fromstring(resp.read())
    except (OSError, http.client.HTTPException, ET.ParseError):
        source_attempt("reddit", "unavailable", (time.monotonic() - started) * 1000)
        logger.warning("Reddit RSS fetch unavailable for r/%s · %s", sub, ticker)
        return None

    posts = []
    for entry in root.findall("atom:entry", _ATOM_NS)[:limit]:
        title_el = entry.find("atom:title", _ATOM_NS)
        published_el = entry.find("atom:published", _ATOM_NS)
        content_el = entry.find("atom:content", _ATOM_NS)
        posts.append(
            {
                "title": (title_el.text if title_el is not None else "") or "",
                "score": None,
                "num_comments": None,
                "created_utc": _iso_to_timestamp(
                    published_el.text if published_el is not None else None
                ),
                "selftext": _strip_html(content_el.text if content_el is not None else ""),
                "source": "rss",
            }
        )
    source_attempt("reddit", "available" if posts else "empty", (time.monotonic() - started) * 1000)
    return posts


def _fetch_subreddit(
    ticker: str,
    sub: str,
    limit: int,
    timeout: float,
) -> list[dict]:
    url = _API.format(sub=sub, qs=_search_qs(ticker, limit))
    req = Request(url, headers={"User-Agent": _UA, "Accept": "application/json"})
    started = time.monotonic()
    try:
        with urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read())
        children = (payload.get("data") or {}).get("children") or []
        source_attempt(
            "reddit", "available" if children else "empty", (time.monotonic() - started) * 1000
        )
        return [c.get("data", {}) for c in children if isinstance(c, dict)]
    except (OSError, http.client.HTTPException, json.JSONDecodeError):
        source_attempt("reddit", "unavailable", (time.monotonic() - started) * 1000)
        logger.warning(
            "Reddit JSON fetch unavailable for r/%s · %s; trying RSS feed.",
            sub,
            ticker,
        )
        return _fetch_subreddit_rss(ticker, sub, limit, timeout)


def fetch_reddit_posts(
    ticker: str,
    subreddits: Iterable[str] = DEFAULT_SUBREDDITS,
    limit_per_sub: int = 5,
    timeout: float = 10.0,
    inter_request_delay: float = 0.4,
    start_date: str | None = None,
    end_date: str | None = None,
) -> str:
    """Fetch date-filtered Reddit discussion, including public RSS fallback."""
    subreddits = tuple(subreddits)
    return capture_evidence(
        "fetch_reddit_posts",
        {
            "ticker": ticker,
            "subreddits": list(subreddits),
            "limit_per_sub": limit_per_sub,
            "start_date": start_date,
            "end_date": end_date,
        },
        lambda: _fetch_reddit_posts(
            ticker, subreddits, limit_per_sub, timeout, inter_request_delay, start_date, end_date
        ),
    )


def _fetch_reddit_posts(
    ticker, subreddits, limit_per_sub, timeout, inter_request_delay, start_date, end_date
) -> str:
    """Fetch recent Reddit posts mentioning ``ticker`` across finance
    subreddits and return them as a formatted plaintext block.

    ``inter_request_delay`` keeps us under Reddit's public rate limit
    (~10 req/min per IP) even if the caller queries many subreddits.
    """
    subreddits = tuple(subreddits)
    historical = is_historical(end_date)
    blocks = []
    for i, sub in enumerate(subreddits):
        if i > 0:
            time.sleep(inter_request_delay)
        fetched = _fetch_subreddit(ticker, sub, limit_per_sub, timeout)
        if fetched is None:
            blocks.append(f"r/{sub}: <Reddit unavailable; discussion could not be retrieved>")
            continue
        posts = _within_window(fetched, start_date, end_date)
        if not posts:
            gap = None
            if start_date and end_date:
                dates = [_posted_at(p) for p in fetched]
                if len(fetched) < limit_per_sub:
                    dates.append(datetime.now(timezone.utc) - timedelta(days=7))
                gap = coverage_gap(
                    dates, start_date, end_date, "Reddit", f"posts about {ticker.upper()}"
                )
            period = (
                f"within {start_date}..{end_date}"
                if start_date and end_date
                else "in the past 7 days"
            )
            blocks.append(
                f"r/{sub}: " + (gap or f"<no posts found mentioning {ticker.upper()} {period}>")
            )
            continue

        via_rss = any(p.get("source") == "rss" for p in posts)
        header = f"r/{sub} — {len(posts)} recent posts mentioning {ticker.upper()}"
        if historical:
            header += " (historical window; current scores/comments withheld):"
        else:
            header += " (via RSS feed; scores/comments unavailable):" if via_rss else ":"
        lines = [header]
        normalized = []
        for p in posts:
            title = (p.get("title") or "").replace("\n", " ").strip()
            score = p.get("score")
            comments = p.get("num_comments")
            created = p.get("created_utc")
            created_str = time.strftime("%Y-%m-%d", time.gmtime(created)) if created else "?"
            # Engagement is a current snapshot even when a post was published
            # within a historical window. It has no historical vintage.
            meta = created_str
            if not historical and score is not None and comments is not None:
                meta += f" · {score:>4}↑ · {comments:>3}c"
            selftext = (p.get("selftext") or "").replace("\n", " ").strip()
            if len(selftext) > 240:
                selftext = selftext[:240] + "…"
            lines.append(
                f"  [{meta}] {title}" + (f"\n    body excerpt: {selftext}" if selftext else "")
            )
            normalized.append(
                {
                    "title": title,
                    "body_excerpt": selftext,
                    "created_utc": scalar(created),
                    "score": None if historical else scalar(score),
                    "num_comments": None if historical else scalar(comments),
                    "retrieval_format": "rss" if p.get("source") == "rss" else "json",
                }
            )
        dates = [_posted_at(p) for p in posts]
        valid = [d for d in dates if d is not None]
        observe_source(
            "reddit",
            url=f"https://www.reddit.com/r/{sub}/search.rss"
            if via_rss
            else f"https://www.reddit.com/r/{sub}/search.json",
            normalized_data={"subreddit": sub, "posts": normalized},
            observed_window={
                "start": min(valid).strftime("%Y-%m-%d"),
                "end": max(valid).strftime("%Y-%m-%d"),
            }
            if valid
            else None,
            publication_dates=[d.isoformat().replace("+00:00", "Z") for d in valid]
            if len(valid) == len(posts)
            else None,
            # Content can be edited; publication timestamps alone cannot establish its historical version.
            transformations=(
                "Posts filtered to requested publication window",
                "Historical engagement metrics withheld"
                if historical
                else "Current engagement metrics displayed",
                "Body excerpts truncated for display",
                "RSS feed parsed" if via_rss else "Public JSON post fields selected",
            ),
        )
        blocks.append("\n".join(lines))

    return "\n\n".join(blocks)
