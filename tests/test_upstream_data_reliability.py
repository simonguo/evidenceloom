"""Offline regression checks for selectively imported upstream data safeguards."""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pandas as pd
import pytest
import requests
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from yfinance.exceptions import YFPricesMissingError, YFRateLimitError

from tradingagents.agents.utils import core_stock_tools, fundamental_data_tools
from tradingagents.agents.utils import news_data_tools, market_data_validation_tools
from tradingagents.dataflows import (
    akshare_fundamentals,
    alpha_vantage_common as av,
    alpha_vantage_fundamentals as av_fund,
    alpha_vantage_news as av_news,
    alpha_vantage_stock as av_stock,
    china_sentiment,
    date_window,
    eastmoney,
    interface,
    market_data_validator,
    net,
    reddit,
    stockstats_utils as ohlcv,
    stocktwits,
    y_finance,
    yfinance_common,
    yfinance_news,
)
from tradingagents.dataflows.files import replace_file
from tradingagents.dataflows.symbol_utils import normalize_symbol
from tradingagents.dataflows.config import get_config, run_config, run_config_context
from tradingagents.dataflows.errors import (
    NoMarketDataError,
    VendorNotConfiguredError,
    VendorUnavailableError,
)

pytestmark = pytest.mark.unit


def _raises(error):
    def fail(*args, **kwargs):
        raise error

    return fail


def test_explicit_chain_never_calls_unconfigured_vendor(monkeypatch):
    fallback = Mock(return_value="unexpected data")
    monkeypatch.setitem(
        interface.VENDOR_METHODS,
        "get_stock_data",
        {"yfinance": _raises(NoMarketDataError("AAPL")), "alpha_vantage": fallback},
    )
    with run_config({"tool_vendors": {"get_stock_data": "yfinance"}}):
        result = interface.route_to_vendor("get_stock_data", "AAPL", "2024-01-01", "2024-01-05")
    assert result.startswith("NO_DATA_AVAILABLE")
    fallback.assert_not_called()


def test_invalid_vendor_in_explicit_chain_is_rejected(monkeypatch):
    first = Mock(return_value="data")
    monkeypatch.setitem(interface.VENDOR_METHODS, "get_stock_data", {"yfinance": first})
    with run_config({"tool_vendors": {"get_stock_data": "yfinance,typo"}}):
        with pytest.raises(ValueError, match="typo"):
            interface.route_to_vendor("get_stock_data", "AAPL")
    first.assert_not_called()


@pytest.mark.parametrize(
    "failure",
    [VendorUnavailableError("timeout"), YFRateLimitError(), ValueError("broken response")],
)
def test_failure_and_empty_chain_is_unavailable_not_a_missing_symbol(monkeypatch, failure):
    monkeypatch.setitem(
        interface.VENDOR_METHODS,
        "get_stock_data",
        {"yfinance": _raises(failure), "alpha_vantage": _raises(NoMarketDataError("AAPL"))},
    )
    with run_config({"tool_vendors": {"get_stock_data": "yfinance,alpha_vantage"}}):
        result = interface.route_to_vendor("get_stock_data", "AAPL")
    assert result.startswith("DATA_UNAVAILABLE")
    assert "NO_DATA_AVAILABLE" not in result


def test_missing_optional_key_lets_the_configured_fallback_succeed(monkeypatch):
    monkeypatch.setitem(
        interface.VENDOR_METHODS,
        "get_stock_data",
        {
            "alpha_vantage": _raises(VendorNotConfiguredError("no key")),
            "yfinance": lambda *a: "prices",
        },
    )
    with run_config({"tool_vendors": {"get_stock_data": "alpha_vantage,yfinance"}}):
        assert interface.route_to_vendor("get_stock_data", "AAPL") == "prices"


def test_run_config_is_nested_copied_and_thread_local():
    original = get_config()
    config = {"data_vendors": {"core_stock_apis": "alpha_vantage"}}
    with run_config(config):
        config["data_vendors"]["core_stock_apis"] = "changed"
        assert get_config()["data_vendors"]["core_stock_apis"] == "alpha_vantage"
        with run_config({"data_vendors": {"core_stock_apis": "eastmoney"}}):
            assert get_config()["data_vendors"]["core_stock_apis"] == "eastmoney"
        assert get_config()["data_vendors"]["core_stock_apis"] == "alpha_vantage"
        with ThreadPoolExecutor(max_workers=1) as pool:
            assert pool.submit(lambda: get_config()).result() == original
    assert get_config() == original
    context = run_config_context({"data_vendors": {"core_stock_apis": "yfinance"}})
    assert context.run(get_config)["data_vendors"]["core_stock_apis"] == "yfinance"
    assert get_config() == original


@pytest.mark.parametrize(
    "notice,error",
    [
        ("Invalid API key", av.AlphaVantageNotConfiguredError),
        ("25 requests per day for this API key", av.AlphaVantageRateLimitError),
    ],
)
def test_alpha_vantage_timeout_and_auth_classification(monkeypatch, notice, error):
    response = SimpleNamespace(
        text=json.dumps({"Information": notice}), status_code=200, raise_for_status=lambda: None
    )
    request = Mock(return_value=response)
    monkeypatch.setattr(net.requests, "get", request)
    with pytest.raises(error):
        av._make_api_request("OVERVIEW", {"symbol": "AAPL"})
    assert request.call_args.kwargs["timeout"] == av.REQUEST_TIMEOUT


def test_query_key_is_removed_from_request_error_and_exception_chain(monkeypatch):
    secret = "private-test-key"
    monkeypatch.setattr(
        net.requests,
        "get",
        _raises(requests.HTTPError(f"failed?apikey={secret}", request=Mock(), response=Mock())),
    )
    with pytest.raises(requests.HTTPError) as caught:
        net.get_scrubbed("https://example.test", params={}, timeout=1, secret=secret)
    assert secret not in str(caught.value)
    assert caught.value.request is None and caught.value.response is None
    assert caught.value.__context__ is None


def test_alpha_vantage_bad_date_trim_fails_closed():
    with pytest.raises(ValueError):
        av._filter_csv_by_date_range("timestamp,close\nnot-a-date,99\n", "2024-01-01", "2024-01-05")


@pytest.mark.parametrize(
    "response",
    ["", "timestamp,close\n", "timestamp,close\n2025-01-01,99\n"],
)
def test_alpha_vantage_empty_window_tries_the_configured_fallback(monkeypatch, response):
    monkeypatch.setattr(av_stock, "_make_api_request", lambda *a: response)
    fallback = Mock(return_value="usable fallback prices")
    monkeypatch.setitem(
        interface.VENDOR_METHODS,
        "get_stock_data",
        {"alpha_vantage": av_stock.get_stock, "yfinance": fallback},
    )
    with run_config({"tool_vendors": {"get_stock_data": "alpha_vantage,yfinance"}}):
        result = interface.route_to_vendor("get_stock_data", "AAPL", "2024-01-01", "2024-01-05")
    assert result == "usable fallback prices"
    fallback.assert_called_once_with("AAPL", "2024-01-01", "2024-01-05")


def test_alpha_vantage_nonempty_window_succeeds_without_fallback(monkeypatch):
    monkeypatch.setattr(
        av_stock, "_make_api_request", lambda *a: "timestamp,close\n2024-01-05,99\n2025-01-01,88\n"
    )
    fallback = Mock(side_effect=AssertionError("nonempty primary result should succeed"))
    monkeypatch.setitem(
        interface.VENDOR_METHODS,
        "get_stock_data",
        {"alpha_vantage": av_stock.get_stock, "yfinance": fallback},
    )
    with run_config({"tool_vendors": {"get_stock_data": "alpha_vantage,yfinance"}}):
        result = interface.route_to_vendor("get_stock_data", "AAPL", "2024-01-01", "2024-01-05")
    assert "2024-01-05,99" in result and "2025" not in result
    fallback.assert_not_called()


@pytest.mark.parametrize("as_string", [True, False])
def test_alpha_vantage_reports_filter_string_payloads_without_mutating_the_input(as_string):
    payload = {
        "annualReports": [
            {"fiscalDateEnding": "2023-12-31"},
            {"fiscalDateEnding": "2025-12-31"},
            {},
        ]
    }
    data = json.dumps(payload) if as_string else payload
    filtered = av_fund._filter_reports_by_date(data, "2024-01-01")
    filtered = json.loads(filtered) if as_string else filtered
    assert filtered["annualReports"] == [{"fiscalDateEnding": "2023-12-31"}]
    assert len(payload["annualReports"]) == 3


@pytest.mark.parametrize("vendor", [y_finance, av_fund])
@pytest.mark.parametrize(
    "method", ["get_fundamentals", "get_balance_sheet", "get_cashflow", "get_income_statement"]
)
def test_historical_live_fundamentals_are_withheld_before_a_request(monkeypatch, vendor, method):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2026-10-03")
    request = Mock(side_effect=AssertionError("historical request should be withheld"))
    if vendor is y_finance:
        monkeypatch.setattr(vendor.yf, "Ticker", request)
    else:
        monkeypatch.setattr(vendor, "_make_api_request", request)
    args = (
        ("AAPL", "2024-01-01")
        if method == "get_fundamentals"
        else ("AAPL", "quarterly", "2024-01-01")
    )
    assert "withheld" in getattr(vendor, method)(*args)
    request.assert_not_called()


@pytest.mark.parametrize("vendor", [y_finance, av_news])
def test_historical_insider_trades_need_a_filing_date(monkeypatch, vendor):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2026-10-03")
    if vendor is y_finance:
        monkeypatch.setattr(vendor.yf, "Ticker", Mock(side_effect=AssertionError("no request")))
    else:
        monkeypatch.setattr(
            vendor, "_make_api_request", Mock(side_effect=AssertionError("no request"))
        )
    assert "withheld" in vendor.get_insider_transactions("AAPL", "2024-01-01")


def test_alpha_vantage_news_includes_the_analysis_day_and_uses_configured_defaults(monkeypatch):
    request = Mock(return_value="news")
    monkeypatch.setattr(av_news, "_make_api_request", request)
    with run_config({"global_news_lookback_days": 3, "global_news_article_limit": 8}):
        av_news.get_global_news("2024-01-10")
    params = request.call_args.args[1]
    assert params["time_to"] == "20240110T2359"
    assert params["time_from"] == "20240107T0000"
    assert params["limit"] == "8"


def _prices():
    return (
        pd.DataFrame(
            {
                "Date": ["2024-01-01", "2024-01-02"],
                "Open": [None, 222.0],
                "High": [101.0, 223.0],
                "Low": [99.0, 199.0],
                "Close": [100.0, 200.0],
                "Volume": [100, 200],
            }
        )
        .set_index("Date")
        .rename_axis("Date")
    )


def _mock_download(monkeypatch, tmp_path, frame):
    frame = frame.copy()
    frame.index = pd.to_datetime(frame.index)
    request = Mock(return_value=frame)
    monkeypatch.setattr(ohlcv.yf, "Ticker", lambda s: SimpleNamespace(history=request))
    monkeypatch.setattr(
        ohlcv.pd.Timestamp, "today", staticmethod(lambda: pd.Timestamp("2024-01-02 12:00"))
    )
    monkeypatch.setattr(ohlcv, "get_config", lambda: {"data_cache_dir": str(tmp_path)})
    return request


def test_future_row_cannot_fill_a_missing_price_before_the_cutoff(monkeypatch, tmp_path):
    _mock_download(monkeypatch, tmp_path, _prices())
    data = ohlcv.load_ohlcv("AAPL", "2024-01-01")
    assert len(data) == 1
    assert pd.isna(data.iloc[0]["Open"])
    assert data.iloc[0]["Close"] == 100.0


def test_raw_snapshot_reports_missing_prices_without_forward_filling(monkeypatch, tmp_path):
    frame = _prices()
    frame.loc["2024-01-01", "Open"] = 99.0
    frame.loc["2024-01-02", "Open"] = None
    _mock_download(monkeypatch, tmp_path, frame)
    snapshot = market_data_validator.build_verified_market_snapshot(
        "AAPL", "2024-01-02", indicators=("rsi",)
    )
    assert "| Open | N/A |" in snapshot
    assert "| Close | 200.00 |" in snapshot


def test_price_window_includes_end_date_but_excludes_extra_vendor_rows(monkeypatch):
    frame = _prices()
    frame.index = pd.to_datetime(frame.index)
    history = Mock(return_value=frame)
    monkeypatch.setattr(y_finance.yf, "Ticker", lambda s: SimpleNamespace(history=history))
    result = y_finance.get_YFin_data_online("AAPL", "2024-01-01", "2024-01-01")
    assert history.call_args.kwargs["end"] == "2024-01-02"
    assert "2024-01-01,100" not in result  # Open is missing, not fabricated from a future row.
    assert "222.0" not in result and "200.0" not in result
    assert "# Total records: 1" in result


def test_latest_year_old_prices_are_rejected():
    with pytest.raises(NoMarketDataError, match="stale"):
        ohlcv._assert_ohlcv_not_stale(_prices(), "2026-01-01", "AAPL")


def test_cached_timezone_offsets_keep_each_markets_local_date():
    data = pd.DataFrame(
        {"Date": ["2024-01-01 00:00:00+08:00", "2024-07-01 00:00:00-04:00"], "Close": [1, 2]}
    )
    cleaned = ohlcv._clean_dataframe(data)
    assert cleaned["Date"].tolist() == [pd.Timestamp("2024-01-01"), pd.Timestamp("2024-07-01")]


def test_same_day_partial_cache_refetches_after_ttl(monkeypatch, tmp_path):
    history = _mock_download(monkeypatch, tmp_path, _prices())
    path = tmp_path / "AAPL-YFin-data.csv"
    _prices().reset_index().to_csv(path, index=False)
    stamp = pd.Timestamp("2024-01-02 10:00").to_pydatetime().timestamp()
    os.utime(path, (stamp, stamp))
    ohlcv.load_ohlcv("AAPL", "2024-01-02")
    assert history.call_count == 1
    assert history.call_args.kwargs["end"] == "2024-01-03"
    assert [p.name for p in tmp_path.iterdir()] == [path.name]


def test_yahoo_request_errors_remain_unavailable_and_empty_answers_remain_empty(monkeypatch):
    with pytest.raises(VendorUnavailableError):
        yfinance_common.yf_retry(_raises(TimeoutError("outage")))
    empty = YFPricesMissingError("FAKE", debug_info="empty chart")
    assert yfinance_common.yf_retry(_raises(empty)) is None
    monkeypatch.setattr(yfinance_common, "vendor_reachable", lambda *a: False)
    with pytest.raises(VendorUnavailableError):
        yfinance_common.raise_for_empty("AAPL", "AAPL", "rows")


def _article(title, published):
    return {"content": {"title": title, "pubDate": published}}


def test_news_normalizes_utc_and_excludes_future_and_undated_articles(monkeypatch):
    articles = [
        _article("included", "2024-01-02T00:30:00+01:00"),
        _article("future", "2024-01-02T00:00:00Z"),
        {"title": "undated"},
    ]
    monkeypatch.setattr(
        yfinance_news.yf, "Ticker", lambda s: SimpleNamespace(get_news=lambda **kw: articles)
    )
    result = yfinance_news.get_news_yfinance("AAPL", "2024-01-01", "2024-01-01")
    assert "included" in result and "future" not in result and "undated" not in result


def test_old_news_window_outside_feed_coverage_is_not_reported_as_silence(monkeypatch):
    monkeypatch.setattr(
        yfinance_news.yf, "Ticker", lambda s: SimpleNamespace(get_news=lambda **kw: [])
    )
    result = yfinance_news.get_news_yfinance("AAPL", "2024-01-01", "2024-01-07")
    assert "unavailable" in result and "not an absence" in result


def test_out_of_window_global_news_does_not_spend_article_budget(monkeypatch):
    search = Mock(
        side_effect=[
            SimpleNamespace(news=[_article("future", "2030-01-01T00:00:00Z")]),
            SimpleNamespace(news=[_article("eligible", "2024-01-01T12:00:00Z")]),
        ]
    )
    monkeypatch.setattr(yfinance_news.yf, "Search", search)
    with run_config({"global_news_queries": ["first", "second"]}):
        result = yfinance_news.get_global_news_yfinance("2024-01-01", 7, 1)
    assert search.call_count == 2 and "eligible" in result and "future" not in result


def test_stocktwits_and_reddit_exclude_future_and_undated_historical_posts():
    messages = [
        {"body": "old", "created_at": "2024-01-01T12:00:00Z"},
        {"body": "future", "created_at": "2026-01-01T12:00:00Z"},
        {"body": "undated"},
    ]
    assert stocktwits._within_window(messages, "2024-01-01", "2024-01-01") == messages[:1]
    posts = [
        {"title": "old", "created_utc": datetime(2024, 1, 1, tzinfo=timezone.utc).timestamp()},
        {"title": "future", "created_utc": datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()},
        {"title": "undated"},
    ]
    assert reddit._within_window(posts, "2024-01-01", "2024-01-01") == posts[:1]


def test_failed_reddit_fetch_is_unavailable_not_no_posts(monkeypatch):
    monkeypatch.setattr(reddit, "_fetch_subreddit", lambda *a: None)
    assert "unavailable" in reddit.fetch_reddit_posts("AAPL", subreddits=("stocks",))


@pytest.mark.parametrize("end_date,historical", [("2024-01-01", True), ("2024-01-02", False)])
def test_reddit_live_engagement_has_no_historical_vintage(monkeypatch, end_date, historical):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2024-01-02")
    posts = [
        {
            "title": "Eligible discussion",
            "selftext": "Thesis context",
            "created_utc": datetime(2024, 1, 1, 12, tzinfo=timezone.utc).timestamp(),
            "score": 987654,
            "num_comments": 876543,
        }
    ]
    monkeypatch.setattr(reddit, "_fetch_subreddit", lambda *a: posts)
    result = reddit.fetch_reddit_posts(
        "AAPL", subreddits=("stocks",), start_date="2024-01-01", end_date=end_date
    )
    assert "Eligible discussion" in result and "Thesis context" in result
    if historical:
        assert "current scores/comments withheld" in result
        assert "987654" not in result and "876543" not in result and "↑" not in result
    else:
        assert "987654↑" in result and "876543c" in result


@pytest.mark.parametrize(
    "tool",
    [
        core_stock_tools.get_stock_data,
        fundamental_data_tools.get_balance_sheet,
        news_data_tools.get_news,
        market_data_validation_tools.get_verified_market_snapshot,
    ],
)
def test_model_cannot_supply_the_run_symbol_or_date(tool):
    properties = tool.tool_call_schema.model_json_schema()["properties"]
    assert (
        "ticker" not in properties and "symbol" not in properties and "trade_date" not in properties
    )


def test_toolnode_injects_run_instrument_and_clamps_model_date(monkeypatch):
    route = Mock(return_value="data")
    monkeypatch.setattr(core_stock_tools, "route_to_vendor", route)

    class State(MessagesState):
        company_of_interest: str
        trade_date: str

    graph = StateGraph(State)
    graph.add_node("tools", ToolNode([core_stock_tools.get_stock_data]))
    graph.add_edge(START, "tools")
    graph.add_edge("tools", END)
    graph.compile().invoke(
        {
            "company_of_interest": "AAPL",
            "trade_date": "2024-01-05",
            "messages": [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "get_stock_data",
                            "id": "stock",
                            "args": {
                                "symbol": "WRONG",
                                "start_date": "2026-01-01",
                                "end_date": "2026-01-05",
                            },
                        }
                    ],
                )
            ],
        }
    )
    route.assert_called_once_with("get_stock_data", "AAPL", "2024-01-01", "2024-01-05")


def test_statement_tool_omitted_date_uses_run_date(monkeypatch):
    route = Mock(return_value="data")
    monkeypatch.setattr(fundamental_data_tools, "route_to_vendor", route)
    fundamental_data_tools.get_balance_sheet.func("AAPL", trade_date="2024-01-05")
    route.assert_called_once_with("get_balance_sheet", "AAPL", "quarterly", "2024-01-05")


def test_chinese_news_filters_unknown_and_future_publication_dates(monkeypatch):
    rows = [
        {"title": "old", "date": "2024-01-01"},
        {"title": "future", "date": "2026-01-01"},
        {"title": "undated", "date": ""},
    ]
    monkeypatch.setattr(
        china_sentiment, "_get_json", lambda *a: {"result": {"cmsArticleWebOld": rows}}
    )
    result = china_sentiment._fetch_eastmoney_articles(["AAPL"], "2024-01-01", "2024-01-01", 10)
    assert [item["title"] for item in result] == ["old"]


def test_akshare_without_a_publication_date_withholds_historical_figures(monkeypatch):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2026-10-03")
    frame = pd.DataFrame({"报告期": ["2023-12-31"], "收入": [999]})
    result = akshare_fundamentals._format_frame("Income", "600519", "test", frame, "2024-01-01")
    assert "withheld" in result and "999" not in result


def test_akshare_known_publication_dates_exclude_later_and_undated_filings(monkeypatch):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2026-10-03")
    frame = pd.DataFrame(
        {
            "报告期": ["2023-12-31"] * 3,
            "公告日期": ["2024-01-01", "2024-01-02", None],
            "收入": [111, 222, 333],
        }
    )
    result = akshare_fundamentals._format_frame("Income", "600519", "test", frame, "2024-01-01")
    assert "111" in result and "222" not in result and "333" not in result


def test_chinese_historical_posts_exclude_later_posts_and_live_engagement(monkeypatch):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2026-10-03")
    monkeypatch.setattr(china_sentiment, "_fetch_company_name", lambda *a: "Test")
    monkeypatch.setattr(china_sentiment, "_fetch_akshare_stock_news", lambda *a, **kw: [])
    monkeypatch.setattr(china_sentiment, "_fetch_eastmoney_articles", lambda *a, **kw: [])
    hot = Mock(side_effect=AssertionError("live heat is unavailable historically"))
    monkeypatch.setattr(china_sentiment, "_fetch_eastmoney_hot_keywords", hot)
    monkeypatch.setattr(
        china_sentiment,
        "_fetch_eastmoney_guba_posts",
        lambda *a, **kw: [
            {"date": "2024-01-01 12:00:00", "title": "eligible", "read_count": 987654},
            {"date": "2024-01-02", "title": "future"},
            {"date": "", "title": "undated"},
        ],
    )
    result = china_sentiment.fetch_china_sentiment_sources("600519.SS", "2024-01-01", "2024-01-01")
    assert "eligible" in result
    assert "future" not in result and "undated" not in result and "987654" not in result
    hot.assert_not_called()


@pytest.mark.parametrize("end_date,historical", [("2024-01-01", True), ("2024-01-02", False)])
def test_chinese_historical_lookup_cannot_use_a_live_company_name(
    monkeypatch, end_date, historical
):
    monkeypatch.setattr(date_window, "get_current_date", lambda: "2024-01-02")
    company_name = Mock(return_value="ST今日新名称")
    articles = Mock(return_value=[])
    monkeypatch.setattr(china_sentiment, "_fetch_company_name", company_name)
    monkeypatch.setattr(china_sentiment, "_fetch_akshare_stock_news", lambda *a, **kw: [])
    monkeypatch.setattr(china_sentiment, "_fetch_eastmoney_articles", articles)
    monkeypatch.setattr(china_sentiment, "_fetch_eastmoney_hot_keywords", lambda *a, **kw: [])
    monkeypatch.setattr(china_sentiment, "_fetch_eastmoney_guba_posts", lambda *a, **kw: [])
    result = china_sentiment.fetch_china_sentiment_sources("600519.SS", "2024-01-01", end_date)
    if historical:
        company_name.assert_not_called()
        assert all(call.args[0] == ["600519"] for call in articles.call_args_list)
        assert "ST今日新名称" not in result and "600519（600519）" in result
    else:
        company_name.assert_called_once_with("600519")
        assert all("ST今日新名称" in call.args[0] for call in articles.call_args_list)
        assert "ST今日新名称" in result


def test_a_failed_atomic_cache_write_retains_the_old_file_and_cleans_its_temp(tmp_path):
    path = tmp_path / "cache.csv"
    path.write_text("old complete cache", encoding="utf-8")

    def interrupted(temp):
        with open(temp, "w", encoding="utf-8") as handle:
            handle.write("partial cache")
        raise OSError("disk error")

    with pytest.raises(OSError):
        replace_file(path, interrupted)
    assert path.read_text(encoding="utf-8") == "old complete cache"
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize(
    "symbol,expected",
    [
        ("600519.SH", "600519.SS"),
        ("SH600519", "600519.SS"),
        ("SZ000001", "000001.SZ"),
        ("700.HK", "0700.HK"),
    ],
)
def test_exchange_aliases_remain_compatible_with_chinese_data_providers(symbol, expected):
    assert normalize_symbol(symbol) == expected


def test_raw_yahoo_prices_with_a_market_timezone_pass_the_staleness_check(monkeypatch):
    frame = _prices()
    frame.index = pd.to_datetime(frame.index).tz_localize("America/New_York")
    monkeypatch.setattr(
        y_finance.yf, "Ticker", lambda *a: SimpleNamespace(history=lambda **kw: frame)
    )
    assert "# Total records: 2" in y_finance.get_YFin_data_online(
        "AAPL", "2024-01-01", "2024-01-02"
    )


def test_chinese_price_vendor_extra_rows_cannot_cross_the_requested_window(monkeypatch):
    frame = _prices().reset_index()
    frame["Date"] = pd.to_datetime(frame["Date"])
    monkeypatch.setattr(eastmoney, "_fetch_kline", lambda *a: ("600519", frame))
    result = eastmoney.get_stock_data("600519.SS", "2024-01-01", "2024-01-01")
    assert "# Total records: 1" in result and "2024-01-02" not in result


def test_a_share_snapshot_outage_is_returned_as_a_vendor_sentinel(monkeypatch):
    monkeypatch.setattr(ohlcv, "load_eastmoney_ohlcv", _raises(TimeoutError("outage")))
    result = market_data_validation_tools.get_verified_market_snapshot.func(
        "600519.SS", "2024-01-01"
    )
    assert result.startswith("DATA_UNAVAILABLE")


@pytest.mark.parametrize("symbol", ["510300", "159915"])
def test_bare_mainland_etfs_keep_eastmoney_prices_and_verified_snapshots(monkeypatch, symbol):
    eastmoney_request = Mock(return_value=_prices().reset_index())
    yahoo_request = Mock(side_effect=AssertionError("bare mainland ETFs must use Eastmoney"))
    monkeypatch.setattr(ohlcv, "load_eastmoney_ohlcv", eastmoney_request)
    monkeypatch.setattr(ohlcv, "yf_retry", yahoo_request)
    prices = ohlcv.load_ohlcv(symbol, "2024-01-02")
    snapshot = market_data_validator.build_verified_market_snapshot(
        symbol, "2024-01-02", indicators=("rsi",)
    )
    assert prices.iloc[-1]["Close"] == 200.0 and "| Close | 200.00 |" in snapshot
    assert eastmoney_request.call_count == 2
    eastmoney_request.assert_called_with(symbol, "2024-01-02")
    yahoo_request.assert_not_called()


@pytest.mark.parametrize(
    "debug", ["(Yahoo status_code = 503)", '(Yahoo error = "Service unavailable")']
)
def test_old_yfinance_failures_are_not_treated_as_empty_charts(debug):
    with pytest.raises(VendorUnavailableError):
        yfinance_common.yf_retry(_raises(YFPricesMissingError("AAPL", debug_info=debug)))
