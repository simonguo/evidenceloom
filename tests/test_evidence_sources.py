"""Offline source integration: real adapters, precision, dates, and fallback provenance."""

import io
import json
from types import SimpleNamespace
from unittest.mock import Mock

import pandas as pd
import pytest
import requests
from stockstats import wrap

from tradingagents.agents.utils import core_stock_tools, market_data_validation_tools
from tradingagents.dataflows import (
    akshare_fundamentals,
    alpha_vantage_common,
    alpha_vantage_fundamentals,
    alpha_vantage_news,
    china_sentiment,
    date_window,
    eastmoney,
    interface,
    market_data_validator,
    reddit,
    stocktwits,
    y_finance,
    yfinance_news,
)
from tradingagents.dataflows.config import run_config
from tradingagents.dataflows.errors import NoMarketDataError, VendorUnavailableError
from tradingagents.evidence import EvidenceLedger, analyst_evidence

pytestmark = pytest.mark.unit


def _ledger(tmp_path, instrument="600519.SS", date="2024-01-02"):
    return EvidenceLedger(
        instrument, date, {"selected_analysts": ["market", "social", "news"]}, tmp_path
    )


def _normalized(bundle, source):
    artifact = bundle["artifacts"][source["data_sha256"]]
    assert artifact["kind"] == "normalized_data"
    return (
        json.loads(artifact["payload"])
        if isinstance(artifact["payload"], str)
        else artifact["payload"]
    )


def _text(bundle, record):
    return bundle["artifacts"][record["output_sha256"]]["payload"]


def test_real_tencent_primary_keeps_precision_and_has_no_eastmoney_attribution(
    monkeypatch, tmp_path
):
    price = 100.12345678901234
    monkeypatch.setattr(
        eastmoney,
        "_fetch_json_with_curl",
        Mock(
            return_value={
                "data": {
                    "sh600519": {
                        "qfqday": [
                            [
                                "2024-01-02",
                                "99.2222222222222",
                                str(price),
                                "101.333333333333",
                                "98.1111111111111",
                                "123456",
                            ],
                            ["2024-01-03", "888", "999", "1000", "777", "999999"],
                        ]
                    }
                },
            }
        ),
    )
    fallback = Mock(side_effect=AssertionError("Tencent succeeded"))
    monkeypatch.setattr(eastmoney, "_fetch_json", fallback)
    ledger = _ledger(tmp_path)
    with (
        ledger.bind(),
        analyst_evidence("market"),
        run_config({"tool_vendors": {"get_stock_data": "eastmoney"}}),
    ):
        result = core_stock_tools.get_stock_data.func(
            "600519.SS", "2024-01-01", "2024-01-10", "2024-01-02"
        )
    bundle = ledger.bundle()
    record = bundle["records"][0]
    assert result.startswith(f"[E:{record['id']}]")
    assert "Tencent" in result and "100.12" in result and "2024-01-03" not in result
    assert record["parameters"]["end_date"] == "2024-01-02"
    assert [a["provider"] for a in record["attempts"]] == ["tencent"]
    assert {s["provider"] for s in record["sources"]} == {"tencent"}
    assert all(s["historical_availability"] == "unknown" for s in record["sources"])
    parsed = _normalized(bundle, record["sources"][0])
    assert parsed["rows"][0][parsed["columns"].index("Close")] == price
    assert record["sources"][0]["observed_window"] == {"start": "2024-01-02", "end": "2024-01-02"}
    assert _text(bundle, record) == result
    fallback.assert_not_called()


@pytest.mark.parametrize(
    "primary",
    [
        NoMarketDataError("600519"),
        requests.Timeout("private-token https://internal.local/?apikey=private-token"),
    ],
)
def test_real_eastmoney_fallback_tracks_meaningful_failure_and_actual_source(
    monkeypatch, tmp_path, caplog, primary
):
    monkeypatch.setattr(eastmoney, "_fetch_json_with_curl", Mock(side_effect=primary))
    monkeypatch.setattr(
        eastmoney,
        "_fetch_json",
        Mock(
            return_value={
                "data": {
                    "klines": [
                        "2024-01-02,199.1111111111111,200.2222222222222,201.3333333333333,198.4444444444444,2000,0,0,0,0,0",
                    ]
                }
            }
        ),
    )
    ledger = _ledger(tmp_path)
    with (
        ledger.bind(),
        analyst_evidence("market"),
        run_config({"tool_vendors": {"get_stock_data": "eastmoney"}}),
    ):
        result = interface.route_to_vendor(
            "get_stock_data", "600519.SS", "2024-01-01", "2024-01-02"
        )
    record = ledger.bundle()["records"][0]
    assert "Eastmoney" in result and "Tencent" not in result
    assert [(a["provider"], a["status"]) for a in record["attempts"]] == [
        ("tencent", "empty" if isinstance(primary, NoMarketDataError) else "unavailable"),
        ("eastmoney", "available"),
    ]
    assert all(a["elapsed_ms"] >= 0 for a in record["attempts"])
    assert {s["provider"] for s in record["sources"]} == {"eastmoney"}
    assert "private-token" not in json.dumps(ledger.bundle()) + result + caplog.text
    assert "internal.local" not in json.dumps(ledger.bundle()) + result + caplog.text


def test_router_unavailable_never_echoes_exception_or_private_url(monkeypatch, tmp_path, caplog):
    def failure(*args):
        raise VendorUnavailableError(
            "super-secret https://private.example/path?apikey=super-secret"
        )

    monkeypatch.setitem(interface.VENDOR_METHODS, "get_stock_data", {"yfinance": failure})
    ledger = _ledger(tmp_path, "AAPL")
    with (
        ledger.bind(),
        analyst_evidence("market"),
        run_config({"tool_vendors": {"get_stock_data": "yfinance"}}),
    ):
        result = interface.route_to_vendor("get_stock_data", "AAPL", "2024-01-01", "2024-01-02")
    record = ledger.bundle()["records"][0]
    assert record["status"] == "unavailable" and record["attempts"][0]["status"] == "unavailable"
    assert "DATA_UNAVAILABLE" in result
    assert "super-secret" not in result + caplog.text + json.dumps(ledger.bundle())
    assert "private.example" not in result + caplog.text + json.dumps(ledger.bundle())


def test_snapshot_persists_source_rows_and_exact_indicator_values_before_rounding(
    monkeypatch, tmp_path
):
    dates = pd.date_range(end="2024-01-03", periods=230)
    close = [100 + i * 0.123456789012345 for i in range(230)]
    frame = pd.DataFrame(
        {
            "Date": dates,
            "Open": [v - 0.23456789012345 for v in close],
            "High": [v + 0.34567890123456 for v in close],
            "Low": [v - 0.45678901234567 for v in close],
            "Close": close,
            "Volume": [1234567] * 230,
        }
    )
    frame.attrs.update(
        {
            "source": "Tencent",
            "source_url": eastmoney.TENCENT_KLINE_URL,
            "source_timezone": "Asia/Shanghai",
        }
    )
    monkeypatch.setattr(market_data_validator, "load_ohlcv", lambda *args, **kwargs: frame)
    expected = wrap(frame[frame["Date"] <= "2024-01-02"].copy())
    expected["close_10_ema"]
    exact = float(expected.iloc[-1]["close_10_ema"])
    ledger = _ledger(tmp_path)
    with ledger.bind(), analyst_evidence("market"):
        result = market_data_validation_tools.get_verified_market_snapshot.func(
            "600519.SS", "2024-01-20", 500, "2024-01-02"
        )
    bundle = ledger.bundle()
    record = bundle["records"][0]
    assert record["parameters"] == {
        "symbol": "600519.SS",
        "curr_date": "2024-01-02",
        "look_back_days": 30,
    }
    assert "2024-01-03" not in result and f"| close_10_ema | {exact:.2f} |" in result
    local = next(s for s in record["sources"] if s["provider"] == "local_calculation")
    assert _normalized(bundle, local)["indicator_values"]["close_10_ema"] == exact
    assert exact != round(exact, 2)
    prices = next(s for s in record["sources"] if s["provider"] == "tencent")
    assert len(_normalized(bundle, prices)["rows"]) == 229
    assert prices["publication_dates"] is None and prices["historical_availability"] == "unknown"


def test_yahoo_news_uses_real_utc_publications_and_discards_future_unknown_dates(
    monkeypatch, tmp_path
):
    articles = [
        {
            "content": {
                "title": title,
                "summary": "source summary",
                "pubDate": date,
                "provider": {"displayName": "Publisher"},
                "canonicalUrl": {"url": "https://example.com/story?tracking=abc"},
            }
        }
        for title, date in [
            ("eligible", "2024-01-02T13:45:12Z"),
            ("future", "2024-01-03T00:00:01Z"),
            ("undated", ""),
        ]
    ]
    monkeypatch.setattr(
        yfinance_news.yf,
        "Ticker",
        lambda symbol: SimpleNamespace(get_news=lambda **kwargs: articles),
    )
    ledger = _ledger(tmp_path, "AAPL")
    with (
        ledger.bind(),
        analyst_evidence("news"),
        run_config({"tool_vendors": {"get_news": "yfinance"}}),
    ):
        result = interface.route_to_vendor("get_news", "AAPL", "2024-01-01", "2024-01-02")
    record = ledger.bundle()["records"][0]
    assert "eligible" in result and "future" not in result and "undated" not in result
    assert record["sources"][0]["publication_dates"] == ["2024-01-02T13:45:12Z"]
    assert record["sources"][0]["historical_availability"] == "unknown"


def test_alpha_news_offsetless_dates_remain_unknown_and_future_data_is_excluded(
    monkeypatch, tmp_path
):
    payload = {
        "feed": [
            {"title": title, "summary": "normalized source", "time_published": date}
            for title, date in [
                ("eligible", "20240102T123456"),
                ("future", "20240103T000001"),
                ("undated", ""),
            ]
        ],
        "items": "3",
    }
    monkeypatch.setattr(alpha_vantage_news, "_make_api_request", lambda *args: json.dumps(payload))
    ledger = _ledger(tmp_path, "AAPL")
    with (
        ledger.bind(),
        analyst_evidence("news"),
        run_config({"tool_vendors": {"get_news": "alpha_vantage"}}),
    ):
        result = interface.route_to_vendor("get_news", "AAPL", "2024-01-01", "2024-01-02")
    source = ledger.bundle()["records"][0]["sources"][0]
    assert "eligible" in result and "future" not in result and "undated" not in result
    assert source["publication_dates"] is None and source["historical_availability"] == "unknown"


def test_direct_stocktwits_capture_has_exact_counts_and_unknown_edit_vintage(monkeypatch, tmp_path):
    data = {
        "messages": [
            {
                "created_at": "2024-01-02T12:00:00Z",
                "body": "A &amp; B",
                "user": {"username": "researcher"},
                "entities": {"sentiment": {"basic": sentiment}},
            }
            for sentiment in ["Bullish", "Bearish", None]
        ]
    }
    monkeypatch.setattr(
        stocktwits, "urlopen", lambda *args, **kwargs: io.BytesIO(json.dumps(data).encode())
    )
    ledger = _ledger(tmp_path, "AAPL")
    with ledger.bind(), analyst_evidence("social"):
        result = stocktwits.fetch_stocktwits_messages(
            "AAPL", limit=3, start_date="2024-01-01", end_date="2024-01-02"
        )
    bundle = ledger.bundle()
    record = bundle["records"][0]
    source = record["sources"][0]
    assert (
        record["tool"] == "fetch_stocktwits_messages" and record["parameters"]["ticker"] == "AAPL"
    )
    assert record["analyst"] == "social" and "33%" in result and "A & B" in result
    assert _normalized(bundle, source)["percentages"]["bullish"] == 100 / 3
    assert source["historical_availability"] == "unknown" and source["publication_dates"]


def test_reddit_real_rss_fallback_captures_selected_post_and_transport_format(
    monkeypatch, tmp_path, caplog
):
    feed = b"""<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>eligible</title><published>2024-01-02T12:00:00Z</published><content>body excerpt</content></entry></feed>"""
    requests_seen = []

    def open_request(request, **kwargs):
        requests_seen.append(request.full_url)
        if "search.json" in request.full_url:
            raise OSError("secret https://private.local/?token=secret")
        return io.BytesIO(feed)

    monkeypatch.setattr(reddit, "urlopen", open_request)
    ledger = _ledger(tmp_path, "AAPL")
    with ledger.bind(), analyst_evidence("social"):
        result = reddit.fetch_reddit_posts(
            "AAPL", subreddits=("stocks",), start_date="2024-01-01", end_date="2024-01-02"
        )
    bundle = ledger.bundle()
    record = bundle["records"][0]
    assert "eligible" in result and len(requests_seen) == 2
    assert [a["status"] for a in record["attempts"]] == ["unavailable", "available"]
    source = record["sources"][0]
    assert source["url"] == "https://www.reddit.com/r/stocks/search.rss"
    assert _normalized(bundle, source)["posts"][0]["retrieval_format"] == "rss"
    assert source["historical_availability"] == "unknown"
    assert "private.local" not in caplog.text + result + json.dumps(bundle)


def test_china_direct_capture_excludes_historical_engagement_and_unknown_timezone(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(china_sentiment, "_fetch_akshare_stock_news", lambda *args, **kwargs: [])
    monkeypatch.setattr(china_sentiment, "_fetch_eastmoney_articles", lambda *args, **kwargs: [])
    monkeypatch.setattr(
        china_sentiment,
        "_fetch_eastmoney_guba_posts",
        lambda *args, **kwargs: [
            {
                "date": "2024-01-02 12:34:56",
                "title": "eligible",
                "read_count": 987654321,
                "comment_count": 4321,
            },
            {"date": "2024-01-03", "title": "future"},
        ],
    )
    ledger = _ledger(tmp_path)
    with ledger.bind(), analyst_evidence("social"):
        result = china_sentiment.fetch_china_sentiment_sources(
            "600519.SS", "2024-01-01", "2024-01-02"
        )
    bundle = ledger.bundle()
    record = bundle["records"][0]
    assert record["tool"] == "fetch_china_sentiment_sources" and "eligible" in result
    assert "future" not in result and "987654321" not in result
    source = record["sources"][0]
    post = _normalized(bundle, source)["posts"][0]
    assert "read_count" not in post and "comment_count" not in post
    assert source["publication_dates"] is None and source["historical_availability"] == "unknown"


def test_alpha_response_notice_never_exposes_service_body(monkeypatch):
    monkeypatch.setenv("ALPHA_VANTAGE_API_KEY", "secret-key")
    monkeypatch.setattr(
        alpha_vantage_common,
        "get_scrubbed",
        lambda *args, **kwargs: SimpleNamespace(
            text=json.dumps(
                {"Information": "rate limit; https://private.local/?apikey=secret-key secret-body"}
            )
        ),
    )
    with pytest.raises(alpha_vantage_common.AlphaVantageRateLimitError) as caught:
        alpha_vantage_common._make_api_request("OVERVIEW", {"symbol": "AAPL"})
    assert str(caught.value) == "Alpha Vantage rate limit exceeded"


def test_historical_profile_is_withheld_with_unknown_publication_time(monkeypatch, tmp_path):
    monkeypatch.setattr(
        y_finance.yf,
        "Ticker",
        Mock(side_effect=AssertionError("historical profile must not fetch")),
    )
    ledger = _ledger(tmp_path, "AAPL")
    with (
        ledger.bind(),
        analyst_evidence("fundamentals"),
        run_config({"tool_vendors": {"get_fundamentals": "yfinance"}}),
    ):
        result = interface.route_to_vendor("get_fundamentals", "AAPL", "2024-01-02")
    record = ledger.bundle()["records"][0]
    assert record["status"] == "withheld" and "withheld" in result.lower()
    assert "observed source dates exceed" not in result.lower()
    assert record["attempts"][0]["status"] == "withheld"
    assert record["sources"][0]["historical_availability"] == "withheld"
    assert record["sources"][0]["publication_dates"] is None


def test_news_effective_limits_and_search_queries_are_recorded_and_enforced(monkeypatch, tmp_path):
    articles = [
        {"title": f"article {i}", "providerPublishTime": 1704196800, "publisher": "Publisher"}
        for i in range(4)
    ]
    monkeypatch.setattr(
        yfinance_news.yf,
        "Ticker",
        lambda symbol: SimpleNamespace(get_news=lambda **kwargs: articles),
    )
    monkeypatch.setattr(yfinance_news.yf, "Search", lambda **kwargs: SimpleNamespace(news=articles))
    ledger = _ledger(tmp_path, "AAPL")
    with (
        ledger.bind(),
        analyst_evidence("news"),
        run_config(
            {
                "news_article_limit": 2,
                "global_news_article_limit": 3,
                "global_news_lookback_days": 4,
                "global_news_queries": ["market query", "rates query"],
                "tool_vendors": {"get_news": "yfinance", "get_global_news": "yfinance"},
            }
        ),
    ):
        ticker_news = interface.route_to_vendor("get_news", "AAPL", "2024-01-01", "2024-01-02")
        global_news = interface.route_to_vendor("get_global_news", "2024-01-02", None, None)
    bundle = ledger.bundle()
    first, second = bundle["records"]
    assert first["parameters"]["limit"] == 2 and "article 2" not in ticker_news
    assert "queries" not in second["parameters"]
    assert _normalized(bundle, second["sources"][0])["search_queries"] == ["market query"]
    assert (
        'Yahoo Finance search queries used: ["market query"]'
        in second["sources"][0]["transformations"]
    )
    assert second["parameters"]["limit"] == 3 and second["parameters"]["look_back_days"] == 4
    assert "article 2" in global_news and "article 3" not in global_news


@pytest.mark.parametrize("alpha_unavailable", [False, True])
def test_global_news_captures_only_actual_provider_queries_or_topics(
    monkeypatch, tmp_path, alpha_unavailable
):
    api = (
        Mock(side_effect=VendorUnavailableError("unavailable"))
        if alpha_unavailable
        else Mock(
            return_value=json.dumps(
                {
                    "items": "1",
                    "feed": [
                        {
                            "title": "Alpha article",
                            "summary": "observed article",
                            "time_published": "20240102T120000",
                        }
                    ],
                }
            )
        )
    )
    monkeypatch.setattr(alpha_vantage_news, "_make_api_request", api)
    search_requests = []

    def search(**kwargs):
        search_requests.append(kwargs["query"])
        return SimpleNamespace(
            news=[
                {
                    "title": kwargs["query"] + " article",
                    "publisher": "Publisher",
                    "providerPublishTime": 1704196800,
                }
            ]
        )

    monkeypatch.setattr(yfinance_news.yf, "Search", search)
    ledger = _ledger(tmp_path, "AAPL")
    with (
        ledger.bind(),
        analyst_evidence("news"),
        run_config(
            {
                "tool_vendors": {"get_global_news": "alpha_vantage,yfinance"},
                "global_news_article_limit": 2,
                "global_news_lookback_days": 3,
                "global_news_queries": ["macro query", "rates query"],
            }
        ),
    ):
        result = interface.route_to_vendor("get_global_news", "2024-01-02", None, None)
    bundle = ledger.bundle()
    record = bundle["records"][0]
    assert "queries" not in record["parameters"]
    assert record["parameters"]["limit"] == 2 and record["parameters"]["look_back_days"] == 3
    assert api.call_args.args[1]["topics"] == "financial_markets,economy_macro,economy_monetary"
    source = record["sources"][0]
    normalized = _normalized(bundle, source)
    if alpha_unavailable:
        assert source["provider"] == "yfinance" and "macro query article" in result
        assert normalized["search_queries"] == search_requests == ["macro query", "rates query"]
        assert "requested_topics" not in normalized
    else:
        assert source["provider"] == "alpha_vantage" and "Alpha article" in result
        assert search_requests == [] and "search_queries" not in normalized
        assert normalized["requested_topics"] == [
            "financial_markets",
            "economy_macro",
            "economy_monetary",
        ]
        assert "macro query" not in json.dumps(record) + json.dumps(normalized)
        assert any(
            value.startswith("Alpha Vantage topics requested: ")
            for value in source["transformations"]
        )


def test_alpha_news_keeps_business_fields_and_excludes_opaque_envelopes(monkeypatch):
    payload = {
        "items": "1",
        "headers": {"authorization": "opaque-token"},
        "debug": "opaque-body",
        "feed": [
            {
                "title": "approved",
                "time_published": "20240102T120000",
                "summary": "approved summary",
                "response_headers": {"secret": "opaque-token"},
                "debug": "opaque-body",
                "ticker_sentiment": [
                    {
                        "ticker": "AAPL",
                        "ticker_sentiment_score": "0.123456789123",
                        "headers": {"secret": "opaque-token"},
                    }
                ],
            }
        ],
    }
    monkeypatch.setattr(alpha_vantage_news, "_make_api_request", lambda *args: json.dumps(payload))
    result = alpha_vantage_news.get_news("AAPL", "2024-01-01", "2024-01-02")
    assert "approved summary" in result and "0.123456789123" in result
    assert "opaque-token" not in result and "opaque-body" not in result and "headers" not in result


@pytest.mark.parametrize("response", ["invalid private body", {"unexpected": "private body"}])
def test_malformed_alpha_news_fails_closed_without_returning_raw_body(monkeypatch, response):
    monkeypatch.setattr(alpha_vantage_news, "_make_api_request", lambda *args: response)
    result = alpha_vantage_news.get_news("AAPL", "2024-01-01", "2024-01-02")
    assert result.startswith("DATA_UNAVAILABLE:") and "private body" not in result


def test_alpha_statements_enforce_frequency_and_only_supply_financial_fields(monkeypatch, tmp_path):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2024-01-02")
    payload = {
        "symbol": "AAPL",
        "headers": {"secret": "opaque-token"},
        "annualReports": [
            {
                "fiscalDateEnding": "2023-12-31",
                "reportedCurrency": "USD",
                "totalAssets": "123456789.123456789",
                "debug": "opaque-body",
            }
        ],
        "quarterlyReports": [{"fiscalDateEnding": "2023-09-30", "totalAssets": "999"}],
    }
    monkeypatch.setattr(
        alpha_vantage_fundamentals, "_make_api_request", lambda *args: json.dumps(payload)
    )
    ledger = _ledger(tmp_path, "AAPL")
    with (
        ledger.bind(),
        analyst_evidence("fundamentals"),
        run_config({"tool_vendors": {"get_balance_sheet": "alpha_vantage"}}),
    ):
        result = interface.route_to_vendor("get_balance_sheet", "AAPL", "annual", "2024-01-02")
    record = ledger.bundle()["records"][0]
    assert record["parameters"]["freq"] == "annual" and "123456789.123456789" in result
    assert "quarterlyReports" not in result and "opaque" not in result
    assert record["sources"][0]["historical_availability"] == "unknown"
    assert record["sources"][0]["publication_dates"] is None


def test_akshare_annual_request_uses_observed_annual_periods(monkeypatch):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2024-01-02")
    frame = pd.DataFrame(
        {"REPORT_DATE": ["2023-12-31", "2023-09-30"], "totalAssets": [123.456789, 987.654321]}
    )
    monkeypatch.setattr(
        akshare_fundamentals,
        "_import_akshare",
        lambda: SimpleNamespace(stock_balance_sheet_by_report_em=lambda **kwargs: frame),
    )
    result = akshare_fundamentals.get_balance_sheet("600519.SS", "annual", "2024-01-02")
    assert "2023-12-31" in result and "2023-09-30" not in result
