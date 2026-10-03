"""yfinance-based news data fetching functions."""

import contextlib
import json
from datetime import datetime, timezone

import yfinance as yf
from dateutil.relativedelta import relativedelta

from tradingagents.dataflows.config import get_config
from tradingagents.dataflows.date_window import coverage_gap, in_window
from tradingagents.dataflows.symbol_utils import normalize_symbol
from tradingagents.dataflows.yfinance_common import yf_retry
from tradingagents.evidence import observe_source
from tradingagents.dataflows.evidence_utils import source_attempt

UTC = timezone.utc


def _observe_news(articles, *, search_queries=None):
    dates = [a["pub_date"] for a in articles if a.get("pub_date") is not None]
    days = [d.date() for d in dates]
    dated = dates and all(d.tzinfo is not None for d in dates) and len(dates) == len(articles)
    normalized = {
        "articles": [
            {
                **{k: a[k] for k in ("title", "summary", "publisher", "link")},
                "publication_time": a["pub_date"].isoformat()
                if a.get("pub_date") is not None
                else None,
            }
            for a in articles
        ]
    }
    transformations = [
        "Articles with unknown dates or outside the requested window excluded",
        "Publication time observed; article content revision vintage unverified",
    ]
    if search_queries is not None:
        normalized["search_queries"] = list(search_queries)
        transformations.append(
            "Yahoo Finance search queries used: " + json.dumps(search_queries, ensure_ascii=False)
        )
    observe_source(
        "yfinance",
        url="https://finance.yahoo.com/",
        normalized_data=normalized,
        observed_window={
            "start": min(days).isoformat(),
            "end": max(days).isoformat(),
        }
        if dates
        else None,
        publication_dates=[d.astimezone(UTC).isoformat().replace("+00:00", "Z") for d in dates]
        if dated
        else None,
        historical_availability="unknown",
        transformations=transformations,
    )


def _extract_article_data(article: dict) -> dict:
    """Extract article data from yfinance news format (handles nested 'content' structure)."""
    if "content" in article:
        content = article["content"]
        title = content.get("title", "No title")
        summary = content.get("summary", "")
        provider = content.get("provider", {})
        publisher = provider.get("displayName", "Unknown")

        url_obj = content.get("canonicalUrl") or content.get("clickThroughUrl") or {}
        link = url_obj.get("url", "")

        pub_date_str = content.get("pubDate", "")
        pub_date = None
        if pub_date_str:
            with contextlib.suppress(ValueError, AttributeError):
                pub_date = datetime.fromisoformat(pub_date_str.replace("Z", "+00:00"))

        return {
            "title": title,
            "summary": summary,
            "publisher": publisher,
            "link": link,
            "pub_date": pub_date,
        }
    else:
        # Fallback for flat structure. Parse the epoch publish time so flat
        # articles are date-filterable too (otherwise they bypass the
        # historical window and leak future news, #992/#1007).
        pub_date = None
        ts = article.get("providerPublishTime")
        if ts:
            # Epoch seconds are UTC; parse them as UTC-aware so filtering does
            # not shift with the host timezone (#1126).
            with contextlib.suppress(ValueError, OSError, TypeError):
                pub_date = datetime.fromtimestamp(ts, tz=UTC)
        return {
            "title": article.get("title", "No title"),
            "summary": article.get("summary", ""),
            "publisher": article.get("publisher", "Unknown"),
            "link": article.get("link", ""),
            "pub_date": pub_date,
        }


def get_news_yfinance(
    ticker: str,
    start_date: str,
    end_date: str,
) -> str:
    """
    Retrieve news for a specific stock ticker using yfinance.

    Args:
        ticker: Stock ticker symbol (e.g., "AAPL")
        start_date: Start date in yyyy-mm-dd format
        end_date: End date in yyyy-mm-dd format

    Returns:
        Formatted string containing news articles
    """
    article_limit = get_config()["news_article_limit"]
    # Query Yahoo with the canonical symbol, like every other yfinance path —
    # a raw broker/forex/crypto alias (XAUUSD, BTCUSD) otherwise silently
    # returns no news. Keep the user's ticker in the report header.
    canonical = normalize_symbol(ticker)
    resolved = "" if canonical == ticker else f" (resolved to {canonical})"
    news = yf_retry(lambda: yf.Ticker(canonical).get_news(count=article_limit)) or []

    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date, "%Y-%m-%d")

    news_str = ""
    filtered_count = 0
    selected = []

    for article in news:
        data = _extract_article_data(article)

        # Keep only articles within the requested window (look-ahead safe).
        if not in_window(data["pub_date"], start_dt, end_dt):
            continue
        selected.append(data)

        news_str += f"### {data['title']} (source: {data['publisher']})\n"
        if data["summary"]:
            news_str += f"{data['summary']}\n"
        if data["link"]:
            news_str += f"Link: {data['link']}\n"
        news_str += "\n"
        filtered_count += 1
        if filtered_count >= article_limit:
            break

    _observe_news(selected)
    if filtered_count == 0:
        gap = coverage_gap(
            (_extract_article_data(a)["pub_date"] for a in news),
            start_date,
            end_date,
            "Yahoo Finance news",
            f"news for {ticker}{resolved}",
        )
        source_attempt("yfinance", "unavailable" if gap else "empty")
        return gap or f"No news found for {ticker}{resolved} between {start_date} and {end_date}"

    return f"## {ticker}{resolved} News, from {start_date} to {end_date}:\n\n{news_str}"


def get_global_news_yfinance(
    curr_date: str,
    look_back_days: int | None = None,
    limit: int | None = None,
) -> str:
    """
    Retrieve global/macro economic news using yfinance Search.

    Args:
        curr_date: Current date in yyyy-mm-dd format
        look_back_days: Number of days to look back. ``None`` falls back to
            ``global_news_lookback_days`` from the active config.
        limit: Maximum number of articles to return. ``None`` falls back to
            ``global_news_article_limit`` from the active config.

    Returns:
        Formatted string containing global news articles
    """
    config = get_config()
    if look_back_days is None:
        look_back_days = config["global_news_lookback_days"]
    if limit is None:
        limit = config["global_news_article_limit"]
    search_queries = config["global_news_queries"]

    curr_dt = datetime.strptime(curr_date, "%Y-%m-%d")
    start_dt = curr_dt - relativedelta(days=look_back_days)
    start_date = start_dt.strftime("%Y-%m-%d")

    in_window_news = []
    seen_titles = set()
    attempted_queries = []

    for query in search_queries:
        attempted_queries.append(query)
        found = yf_retry(
            lambda q=query: (
                yf.Search(
                    query=q,
                    news_count=limit,
                    enable_fuzzy_query=True,
                ).news
            )
        )

        for article in found or []:
            # Window first: the limit counts what the run may read, so an
            # out-of-window article must not spend the budget or cut the
            # remaining searches short (#1356). Flat articles are filtered
            # on the same rule, so none can leak future news (#1007).
            data = _extract_article_data(article)
            if not in_window(data["pub_date"], start_dt, curr_dt):
                continue
            if data["title"] and data["title"] not in seen_titles:
                seen_titles.add(data["title"])
                in_window_news.append(data)

        if len(in_window_news) >= limit:
            break

    news_str = ""
    _observe_news(in_window_news[:limit], search_queries=attempted_queries)
    for data in in_window_news[:limit]:
        news_str += f"### {data['title']} (source: {data['publisher']})\n"
        if data["summary"]:
            news_str += f"{data['summary']}\n"
        if data["link"]:
            news_str += f"Link: {data['link']}\n"
        news_str += "\n"

    # Nothing fell inside the window -> say so rather than return an
    # empty-bodied report (#993).
    if not news_str:
        # Results merge several fuzzy searches, so their timestamps prove no
        # continuous coverage; judge the window against the present only.
        gap = coverage_gap((), start_date, curr_date, "Yahoo Finance global news", "market news")
        source_attempt("yfinance", "unavailable" if gap else "empty")
        return gap or f"No global news found between {start_date} and {curr_date}"

    return f"## Global Market News, from {start_date} to {curr_date}:\n\n{news_str}"
