"""A-share adapter labels the provider that supplied rows, including fallback."""

from unittest.mock import Mock

import pandas as pd
import pytest
import requests

from tradingagents.dataflows import eastmoney
from tradingagents.dataflows.errors import NoMarketDataError

pytestmark = pytest.mark.unit

TENCENT_PAYLOAD = {
    "data": {
        "sh600519": {
            "qfqday": [
                ["2024-01-01", "99", "100", "101", "98", "1000"],
                ["2024-01-02", "100", "102", "103", "99", "1100"],
            ]
        }
    }
}
EASTMONEY_PAYLOAD = {"data": {"klines": ["2024-01-01,199,200,201,198,2000,0,0,0,0,0"]}}


def test_tencent_success_is_not_labelled_eastmoney_and_does_not_request_fallback(monkeypatch):
    primary = Mock(return_value=TENCENT_PAYLOAD)
    fallback = Mock(side_effect=AssertionError("successful Tencent rows should not fall back"))
    monkeypatch.setattr(eastmoney, "_fetch_json_with_curl", primary)
    monkeypatch.setattr(eastmoney, "_fetch_json", fallback)

    result = eastmoney.get_stock_data("600519.SS", "2024-01-01", "2024-01-01")

    assert "(Tencent, from 600519.SS)" in result and "Eastmoney" not in result
    assert "# Total records: 1" in result and "2024-01-02" not in result
    assert ",100," in result
    primary.assert_called_once_with(
        eastmoney.TENCENT_KLINE_URL, {"param": "sh600519,day,2024-01-01,2024-01-01,640,qfq"}
    )
    fallback.assert_not_called()


@pytest.mark.parametrize(
    "primary_response",
    [
        {},  # provider answered but returned no symbol rows
        {"data": {"sh600519": {"qfqday": [["invalid", "99", "bad", "101", "98", "1000"]]}}},
        requests.Timeout("Tencent transport unavailable"),
        ValueError("malformed Tencent response"),
    ],
)
def test_eastmoney_fallback_labels_its_own_rows_after_unusable_tencent_data(
    monkeypatch, primary_response
):
    primary = Mock(
        **(
            {"side_effect": primary_response}
            if isinstance(primary_response, Exception)
            else {"return_value": primary_response}
        )
    )
    fallback = Mock(return_value=EASTMONEY_PAYLOAD)
    monkeypatch.setattr(eastmoney, "_fetch_json_with_curl", primary)
    monkeypatch.setattr(eastmoney, "_fetch_json", fallback)

    result = eastmoney.get_stock_data("600519.SS", "2024-01-01", "2024-01-01")

    assert "(Eastmoney, from 600519.SS)" in result and "Tencent" not in result
    assert ",200," in result and ",100," not in result
    primary.assert_called_once()
    fallback.assert_called_once()
    assert fallback.call_args.args[0] == eastmoney.EASTMONEY_KLINE_URL
    assert fallback.call_args.args[1]["secid"] == "1.600519"


@pytest.mark.parametrize("provider", ["Tencent", "Eastmoney"])
def test_direct_frames_and_ohlcv_keep_the_successful_provider_metadata(monkeypatch, provider):
    monkeypatch.setattr(
        eastmoney,
        "_fetch_json_with_curl",
        Mock(return_value=TENCENT_PAYLOAD if provider == "Tencent" else {}),
    )
    monkeypatch.setattr(eastmoney, "_fetch_json", Mock(return_value=EASTMONEY_PAYLOAD))

    code, frame = eastmoney._fetch_kline("600519.SS", "2024-01-01", "2024-01-01")
    snapshot_rows = eastmoney.load_ohlcv("600519.SS", "2024-01-01")

    endpoint = (
        eastmoney.TENCENT_KLINE_URL if provider == "Tencent" else eastmoney.EASTMONEY_KLINE_URL
    )
    assert code == "600519" and isinstance(frame, pd.DataFrame)
    assert frame.attrs == {"source": provider, "source_url": endpoint}
    assert snapshot_rows.attrs == frame.attrs
    assert snapshot_rows["Date"].max() == pd.Timestamp("2024-01-01")


@pytest.mark.parametrize(
    "fallback_failure", [requests.Timeout("Eastmoney unavailable"), NoMarketDataError("600519")]
)
def test_both_providers_failing_propagates_failure_without_fabricating_a_source(
    monkeypatch, fallback_failure
):
    primary = Mock(side_effect=requests.Timeout("Tencent unavailable"))
    fallback = Mock(side_effect=fallback_failure)
    monkeypatch.setattr(eastmoney, "_fetch_json_with_curl", primary)
    monkeypatch.setattr(eastmoney, "_fetch_json", fallback)

    with pytest.raises(type(fallback_failure)) as caught:
        eastmoney.get_stock_data("600519.SS", "2024-01-01", "2024-01-01")

    assert caught.value is fallback_failure
    primary.assert_called_once()
    fallback.assert_called_once()


def test_no_providers_covering_the_window_returns_no_data_not_a_report(monkeypatch):
    monkeypatch.setattr(eastmoney, "_fetch_json_with_curl", Mock(return_value={}))
    monkeypatch.setattr(eastmoney, "_fetch_json", Mock(return_value={"data": {"klines": []}}))
    with pytest.raises(NoMarketDataError):
        eastmoney.get_stock_data("600519.SS", "2024-01-01", "2024-01-01")


def test_missing_source_metadata_is_explicitly_unknown_not_guessed(monkeypatch):
    frame = pd.DataFrame(
        {
            "Date": pd.to_datetime(["2024-01-01"]),
            "Open": [99],
            "High": [101],
            "Low": [98],
            "Close": [100],
            "Volume": [1000],
        }
    )
    monkeypatch.setattr(eastmoney, "_fetch_kline", lambda *args: ("600519", frame))
    result = eastmoney.get_stock_data("600519.SS", "2024-01-01", "2024-01-01")
    assert "Unknown provider" in result and "Eastmoney" not in result and "Tencent" not in result


def test_source_tagging_does_not_mutate_a_shared_provider_frame(monkeypatch):
    frame = pd.DataFrame({"Close": [100]})
    frame.attrs["existing"] = "metadata"
    monkeypatch.setattr(eastmoney, "_fetch_tencent_kline", lambda *args: frame)
    _, result = eastmoney._fetch_kline("600519.SS", "2024-01-01", "2024-01-01")
    assert frame.attrs == {"existing": "metadata"}
    assert result is not frame and result.attrs["source"] == "Tencent"


def test_invalid_instrument_is_rejected_before_any_provider_request(monkeypatch):
    primary, fallback = Mock(), Mock()
    monkeypatch.setattr(eastmoney, "_fetch_json_with_curl", primary)
    monkeypatch.setattr(eastmoney, "_fetch_json", fallback)
    with pytest.raises(NoMarketDataError):
        eastmoney.get_stock_data("AAPL", "2024-01-01", "2024-01-01")
    primary.assert_not_called()
    fallback.assert_not_called()
