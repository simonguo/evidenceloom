"""Tests that empty vendor results never become fabricated data.

Covers two systematic fixes:
  - load_ohlcv must not cache an empty download (cache poisoning), and must
    raise NoMarketDataError instead of returning an empty frame.
  - route_to_vendor must convert NoMarketDataError into a single explicit
    "NO_DATA_AVAILABLE" sentinel after all vendors are exhausted.
"""

import os
import unittest
from unittest import mock

import pandas as pd
import pytest

from tradingagents.dataflows import stockstats_utils, interface, eastmoney
from tradingagents.dataflows.config import set_config
from tradingagents.dataflows.symbol_utils import NoMarketDataError
from yfinance.exceptions import YFRateLimitError


@pytest.mark.unit
class TestLoadOhlcvNoPoison(unittest.TestCase):
    def setUp(self):
        self._tmp = os.path.join(os.path.dirname(__file__), "_tmp_cache")
        os.makedirs(self._tmp, exist_ok=True)
        set_config({"data_cache_dir": self._tmp})

    def tearDown(self):
        for f in os.listdir(self._tmp):
            os.remove(os.path.join(self._tmp, f))
        os.rmdir(self._tmp)

    def test_empty_download_raises_and_does_not_cache(self):
        empty = pd.DataFrame()
        with mock.patch.object(stockstats_utils.yf, "download", return_value=empty):
            with self.assertRaises(NoMarketDataError):
                stockstats_utils.load_ohlcv("FAKE", "2026-01-01")
        # Nothing should have been written to the cache.
        self.assertEqual(os.listdir(self._tmp), [])

        # A second call must re-attempt the fetch (no poisoned cache served).
        with mock.patch.object(stockstats_utils.yf, "download", return_value=empty) as dl2:
            with self.assertRaises(NoMarketDataError):
                stockstats_utils.load_ohlcv("FAKE", "2026-01-01")
            self.assertTrue(dl2.called)


@pytest.mark.unit
class TestRouteToVendorSentinel(unittest.TestCase):
    def test_no_data_from_all_vendors_returns_sentinel(self):
        def raises_no_data(symbol, *a, **k):
            raise NoMarketDataError(symbol, "GC=F", "no rows")

        patched = {"yfinance": raises_no_data, "alpha_vantage": raises_no_data}
        with mock.patch.dict(interface.VENDOR_METHODS, {"get_stock_data": patched}, clear=False):
            result = interface.route_to_vendor(
                "get_stock_data", "XAUUSD+", "2026-01-01", "2026-01-10"
            )
        self.assertIn("NO_DATA_AVAILABLE", result)
        self.assertIn("XAUUSD+", result)
        self.assertIn("GC=F", result)
        self.assertIn("Do not estimate", result)


@pytest.mark.unit
class TestAShareDataFallback(unittest.TestCase):
    def test_non_a_share_fundamentals_skip_akshare(self):
        def raises_not_a_share(symbol, *a, **k):
            raise NoMarketDataError(
                symbol,
                symbol,
                "AkShare fundamentals adapter only supports mainland China A-share symbols.",
            )

        def returns_yahoo(symbol, *a, **k):
            return f"yfinance fundamentals for {symbol}"

        patched = {"akshare": raises_not_a_share, "yfinance": returns_yahoo}
        with mock.patch.dict(interface.VENDOR_METHODS, {"get_fundamentals": patched}, clear=False):
            result = interface.route_to_vendor("get_fundamentals", "AAPL", "2026-06-22")

        self.assertEqual(result, "yfinance fundamentals for AAPL")

    def test_tencent_kline_parses_extra_fields(self):
        payload = {
            "data": {
                "sh688503": {
                    "qfqday": [
                        [
                            "2026-06-12",
                            "94.98",
                            "89.81",
                            "96.24",
                            "89.00",
                            "21826942",
                            {"note": "extra"},
                        ]
                    ]
                }
            }
        }
        with mock.patch.object(eastmoney, "_fetch_json_with_curl", return_value=payload):
            data = eastmoney.load_ohlcv("688503.SS", "2026-06-12")

        self.assertEqual(len(data), 1)
        self.assertEqual(data.iloc[0]["Date"].strftime("%Y-%m-%d"), "2026-06-12")
        self.assertEqual(data.iloc[0]["Close"], 89.81)

    def test_a_share_indicators_skip_yfinance_download(self):
        payload = {
            "data": {
                "sh688503": {
                    "qfqday": [
                        ["2026-06-08", "83.00", "80.69", "86.43", "79.00", "13452580"],
                        ["2026-06-09", "82.32", "86.30", "86.88", "81.04", "10527021"],
                        ["2026-06-10", "85.00", "86.80", "89.09", "85.00", "12243679"],
                        ["2026-06-11", "86.69", "93.21", "96.69", "86.30", "21599246"],
                        ["2026-06-12", "94.98", "89.81", "96.24", "89.00", "21826942"],
                    ]
                }
            }
        }
        with mock.patch.object(eastmoney, "_fetch_json_with_curl", return_value=payload):
            with mock.patch.object(stockstats_utils.yf, "download") as yahoo_download:
                result = stockstats_utils.StockstatsUtils.get_stock_stats(
                    "688503.SS", "rsi", "2026-06-12"
                )

        yahoo_download.assert_not_called()
        self.assertNotEqual(str(result), "")

    def test_unconfigured_fallback_does_not_mask_no_data(self):
        # When the primary vendor reports no data and the fallback is simply
        # unavailable (e.g. missing API key -> raises), the no-data sentinel
        # must win rather than the fallback's incidental error crashing out.
        def raises_no_data(symbol, *a, **k):
            raise NoMarketDataError(symbol, symbol, "no rows")

        def raises_unavailable(symbol, *a, **k):
            raise ValueError("ALPHA_VANTAGE_API_KEY environment variable is not set.")

        patched = {"yfinance": raises_no_data, "alpha_vantage": raises_unavailable}
        with mock.patch.dict(interface.VENDOR_METHODS, {"get_stock_data": patched}, clear=False):
            result = interface.route_to_vendor("get_stock_data", "FAKE", "2026-01-01", "2026-01-10")
        self.assertIn("NO_DATA_AVAILABLE", result)

    def test_rate_limited_vendors_return_sentinel(self):
        def raises_yahoo_rate_limit(symbol, *a, **k):
            raise YFRateLimitError()

        def raises_alpha_rate_limit(symbol, *a, **k):
            raise interface.AlphaVantageRateLimitError("rate limit")

        patched = {
            "yfinance": raises_yahoo_rate_limit,
            "alpha_vantage": raises_alpha_rate_limit,
        }
        with mock.patch.dict(interface.VENDOR_METHODS, {"get_stock_data": patched}, clear=False):
            result = interface.route_to_vendor("get_stock_data", "SPY", "2026-01-01", "2026-01-10")
        self.assertIn("DATA_UNAVAILABLE", result)
        self.assertIn("rate limited", result)
        self.assertIn("Do not estimate", result)


if __name__ == "__main__":
    unittest.main()
