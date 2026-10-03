import json
from datetime import datetime, timedelta

from .alpha_vantage_common import _make_api_request, format_datetime_for_api, API_BASE_URL
from .config import get_config
from .date_window import withhold_undisclosed_trades
from tradingagents.evidence import observe_source
from .evidence_utils import business_fields, source_attempt


def _observed_news(result, start_date, end_date, limit=None, *, requested_topics=None):
    try:
        payload = json.loads(result) if isinstance(result, str) else result
    except (json.JSONDecodeError, TypeError):
        source_attempt("alpha_vantage", "unavailable")
        return "DATA_UNAVAILABLE: Alpha Vantage returned malformed news data."
    if not isinstance(payload, dict) or not isinstance(payload.get("feed"), list):
        source_attempt("alpha_vantage", "unavailable")
        return "DATA_UNAVAILABLE: Alpha Vantage returned unexpected news data."
    start = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)
    rows = []
    dates = []
    for article in payload["feed"]:
        try:
            date = datetime.strptime(article.get("time_published", ""), "%Y%m%dT%H%M%S")
        except (ValueError, TypeError, AttributeError):
            continue
        if start <= date < end:
            rows.append(article)
            dates.append(date)
    if limit is not None:
        rows, dates = rows[:limit], dates[:limit]
    if not rows:
        source_attempt("alpha_vantage", "empty")
    keys = (
        "title",
        "url",
        "time_published",
        "summary",
        "source",
        "source_domain",
        "overall_sentiment_score",
        "overall_sentiment_label",
        "ticker_sentiment",
        "topics",
    )
    normalized = []
    for row in rows:
        selected = business_fields(row, set(keys) - {"ticker_sentiment", "topics"})
        for field, allowed in (
            (
                "ticker_sentiment",
                ("ticker", "relevance_score", "ticker_sentiment_score", "ticker_sentiment_label"),
            ),
            ("topics", ("topic", "relevance_score")),
        ):
            if isinstance(row.get(field), list):
                selected[field] = [
                    business_fields(item, allowed) for item in row[field] if isinstance(item, dict)
                ]
        normalized.append(selected)
    normalized_data = {"articles": normalized}
    transformations = ["Articles with unknown dates or outside requested window excluded"]
    if requested_topics is not None:
        normalized_data["requested_topics"] = list(requested_topics)
        transformations.append("Alpha Vantage topics requested: " + json.dumps(requested_topics))
    observe_source(
        "alpha_vantage",
        url=API_BASE_URL,
        normalized_data=normalized_data,
        observed_window={
            "start": min(dates).strftime("%Y-%m-%d"),
            "end": max(dates).strftime("%Y-%m-%d"),
        }
        if dates
        else None,
        # Provider timestamps have no observed UTC offset. Do not invent one.
        transformations=transformations,
    )
    filtered = {
        k: payload[k]
        for k in ("sentiment_score_definition", "relevance_score_definition", "score_definition")
        if isinstance(payload.get(k), str)
    }
    filtered["feed"] = normalized
    if "items" in payload:
        filtered["items"] = str(len(rows))
    return json.dumps(filtered) if isinstance(result, str) else filtered


def get_news(ticker, start_date, end_date) -> dict[str, str] | str:
    """Returns live and historical market news & sentiment data from premier news outlets worldwide.

    Covers stocks, cryptocurrencies, forex, and topics like fiscal policy, mergers & acquisitions, IPOs.

    Args:
        ticker: Stock symbol for news articles.
        start_date: Start date for news search.
        end_date: End date for news search.

    Returns:
        Dictionary containing news sentiment data or JSON string.
    """

    params = {
        "tickers": ticker,
        "time_from": format_datetime_for_api(start_date),
        "time_to": format_datetime_for_api(end_date, end_of_day=True),
        "limit": str(get_config()["news_article_limit"]),
    }

    return _observed_news(
        _make_api_request("NEWS_SENTIMENT", params),
        start_date,
        end_date,
        get_config()["news_article_limit"],
    )


def get_global_news(
    curr_date, look_back_days: int | None = None, limit: int | None = None
) -> dict[str, str] | str:
    """Returns global market news & sentiment data without ticker-specific filtering.

    Covers broad market topics like financial markets, economy, and more.

    Args:
        curr_date: Current date in yyyy-mm-dd format.
        look_back_days: Number of days to look back (default 7).
        limit: Maximum number of articles (default 50).

    Returns:
        Dictionary containing global news sentiment data or JSON string.
    """
    config = get_config()
    look_back_days = (
        config["global_news_lookback_days"] if look_back_days is None else look_back_days
    )
    limit = config["global_news_article_limit"] if limit is None else limit

    # Calculate start date
    curr_dt = datetime.strptime(curr_date, "%Y-%m-%d")
    start_dt = curr_dt - timedelta(days=look_back_days)
    start_date = start_dt.strftime("%Y-%m-%d")

    params = {
        "topics": "financial_markets,economy_macro,economy_monetary",
        "time_from": format_datetime_for_api(start_date),
        "time_to": format_datetime_for_api(curr_date, end_of_day=True),
        "limit": str(limit),
    }

    return _observed_news(
        _make_api_request("NEWS_SENTIMENT", params),
        start_date,
        curr_date,
        limit,
        requested_topics=params["topics"].split(","),
    )


def get_insider_transactions(symbol: str, curr_date: str | None = None) -> dict[str, str] | str:
    """Returns latest and historical insider transactions by key stakeholders.

    Covers transactions by founders, executives, board members, etc.

    Args:
        symbol: Ticker symbol. Example: "IBM".

    Returns:
        Dictionary containing insider transaction data or JSON string.
    """

    withheld = withhold_undisclosed_trades(curr_date, symbol)
    if withheld:
        observe_source("alpha_vantage", historical_availability="withheld")
        return withheld
    result = _make_api_request("INSIDER_TRANSACTIONS", {"symbol": symbol})
    try:
        payload = json.loads(result) if isinstance(result, str) else result
    except (json.JSONDecodeError, TypeError):
        payload = None
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        source_attempt("alpha_vantage", "unavailable")
        return "DATA_UNAVAILABLE: Alpha Vantage returned unexpected insider data."
    allowed = (
        "transaction_date",
        "ticker",
        "executive",
        "executive_title",
        "security_type",
        "acquisition_or_disposal",
        "shares",
        "share_price",
    )
    rows = [business_fields(item, allowed) for item in payload["data"] if isinstance(item, dict)]
    if not rows:
        source_attempt("alpha_vantage", "empty")
    observe_source("alpha_vantage", url=API_BASE_URL, normalized_data={"transactions": rows})
    cleaned = {"data": rows}
    return json.dumps(cleaned) if isinstance(result, str) else cleaned
