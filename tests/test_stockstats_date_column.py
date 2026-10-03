"""Tests for tolerating a non-`Date` index column in stockstats_utils (#890).

Guards against a download frame whose date column is `index` or `Datetime`
instead of `Date`, which would otherwise silently drop every indicator.
"""

from __future__ import annotations

import pandas as pd
import pytest

from tradingagents.dataflows import stockstats_utils as su


def _ohlcv(date_col: str) -> pd.DataFrame:
    """OHLCV frame whose date column is named `date_col`."""
    dates = pd.bdate_range("2026-04-01", periods=10)
    return pd.DataFrame(
        {
            date_col: dates,
            "Open": [100.0 + i for i in range(10)],
            "High": [101.0 + i for i in range(10)],
            "Low": [99.0 + i for i in range(10)],
            "Close": [100.5 + i for i in range(10)],
            "Volume": [1_000_000 + i for i in range(10)],
        }
    )


@pytest.mark.unit
class TestEnsureDateColumn:
    def test_renames_index_column(self):
        out = su._ensure_date_column(_ohlcv("index"))
        assert "Date" in out.columns and "index" not in out.columns

    def test_renames_datetime_and_date_variants(self):
        assert "Date" in su._ensure_date_column(_ohlcv("Datetime")).columns
        assert "Date" in su._ensure_date_column(_ohlcv("date")).columns

    def test_leaves_existing_date_untouched(self):
        df = _ohlcv("Date")
        assert su._ensure_date_column(df) is df  # no-op short-circuit

    def test_no_datelike_column_is_left_alone(self):
        df = pd.DataFrame({"Close": [1, 2, 3]})
        out = su._ensure_date_column(df)
        assert "Date" not in out.columns  # nothing to rename; caller handles


@pytest.mark.unit
class TestCleanDataframeAcrossVersions:
    def test_clean_handles_index_column(self):
        """A frame with `index` instead of `Date` must still clean to a
        usable, date-parsed frame (was KeyError: 'Date')."""
        cleaned = su._clean_dataframe(_ohlcv("index"))
        assert "Date" in cleaned.columns
        assert pd.api.types.is_datetime64_any_dtype(cleaned["Date"])
        assert len(cleaned) == 10

    def test_clean_handles_legacy_date_column(self):
        cleaned = su._clean_dataframe(_ohlcv("Date"))
        assert len(cleaned) == 10

    def test_indicators_compute_after_index_rename(self):
        """stockstats must compute indicators on a frame whose date column
        arrived as `index`, instead of erroring per indicator."""
        from stockstats import wrap

        cleaned = su._clean_dataframe(_ohlcv("index"))
        df = wrap(cleaned)
        df["close_5_sma"]  # triggers calculation
        assert "close_5_sma" in df.columns
        assert df["close_5_sma"].notna().any()


def test_clean_keeps_original_midday_timestamp_timezone_and_offset():
    frame = _ohlcv("Date").head(1).copy()
    frame["Date"] = [pd.Timestamp("2026-04-01T12:45:00", tz="Asia/Hong_Kong")]
    cleaned = su._clean_dataframe(frame)
    assert cleaned.iloc[0]["Date"] == pd.Timestamp("2026-04-01")
    assert cleaned.iloc[0]["SourceTimestamp"] == "2026-04-01T12:45:00+08:00"
    assert cleaned.iloc[0]["SourceTimezone"] == "Asia/Hong_Kong"
    assert cleaned.iloc[0]["SourceUTCOffset"] == "+08:00"
    assert cleaned.iloc[0]["TimezoneOrigin"] == "timestamp"


@pytest.mark.parametrize("existing_source_columns", [False, True])
def test_negative_zero_offset_is_retained_as_unknown_instead_of_observed_utc(
    existing_source_columns,
):
    frame = _ohlcv("Date").head(1).copy()
    original = "2026-04-01T00:00:00-00:00"
    frame["Date"] = [original]
    if existing_source_columns:
        frame["SourceTimestamp"] = original
        frame["SourceTimezone"] = "UTC"
        frame["SourceUTCOffset"] = "+00:00"
        frame["TimezoneOrigin"] = "timestamp"
    cleaned = su._clean_dataframe(frame)
    assert cleaned.iloc[0]["Date"] == pd.Timestamp("2026-04-01")
    assert cleaned.iloc[0]["SourceTimestamp"] == original
    assert cleaned.iloc[0]["SourceTimezone"] is None
    assert cleaned.iloc[0]["SourceUTCOffset"] is None
    assert cleaned.iloc[0]["TimezoneOrigin"] == "unknown"


def test_historical_download_requests_cutoff_window_and_retains_explicit_basis(
    monkeypatch, tmp_path
):
    from types import SimpleNamespace
    from unittest.mock import Mock

    frame = _ohlcv("Date").set_index("Date")
    frame.index = frame.index.tz_localize("America/New_York")
    history = Mock(return_value=frame)
    monkeypatch.setattr(su.yf, "Ticker", lambda symbol: SimpleNamespace(history=history))
    monkeypatch.setattr(su, "get_config", lambda: {"data_cache_dir": str(tmp_path)})
    output = su.load_ohlcv("FICTIONAL", "2026-04-14", fill_gaps=False)
    assert history.call_args.kwargs == {
        "start": "2021-04-14",
        "end": "2026-04-15",
        "interval": "1d",
        "auto_adjust": True,
        "back_adjust": False,
        "actions": False,
        "repair": False,
        "rounding": False,
        "keepna": True,
        "prepost": False,
    }
    assert output.attrs["price_basis"] == "auto_adjusted_ohlcv"
    assert output.attrs["requested_window"] == {"start": "2021-04-14", "end": "2026-04-14"}
    assert output["SourceTimezone"].eq("America/New_York").all()
    again = su.load_ohlcv("FICTIONAL", "2026-04-14", fill_gaps=False)
    assert history.call_count == 1
    assert again["SourceTimestamp"].tolist() == output["SourceTimestamp"].tolist()
    assert again["SourceTimezone"].tolist() == output["SourceTimezone"].tolist()


def test_old_cache_without_request_or_timezone_metadata_is_refetched(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from unittest.mock import Mock

    _ohlcv("Date").to_csv(tmp_path / "FICTIONAL-YFin-data.csv", index=False)
    frame = _ohlcv("Date").set_index("Date")
    history = Mock(return_value=frame)
    monkeypatch.setattr(su.yf, "Ticker", lambda symbol: SimpleNamespace(history=history))
    monkeypatch.setattr(su, "get_config", lambda: {"data_cache_dir": str(tmp_path)})
    output = su.load_ohlcv("FICTIONAL", "2026-04-14", fill_gaps=False)
    assert history.call_count == 1
    assert output["TimezoneOrigin"].eq("unknown").all()
    assert output["SourceTimezone"].isna().all()


def test_different_cutoff_reuses_bounded_cache_without_leaking_future_rows(monkeypatch, tmp_path):
    from types import SimpleNamespace
    from unittest.mock import Mock

    frame = pd.concat([_ohlcv("Date")] * 23, ignore_index=True)
    frame["Date"] = pd.date_range("2025-08-29", periods=len(frame), tz="America/New_York")
    frame = frame.set_index("Date")
    history = Mock(return_value=frame)
    monkeypatch.setattr(su.yf, "Ticker", lambda symbol: SimpleNamespace(history=history))
    monkeypatch.setattr(su, "get_config", lambda: {"data_cache_dir": str(tmp_path)})
    su.load_ohlcv("FICTIONAL", "2026-04-15", fill_gaps=False)
    previous = su.load_ohlcv("FICTIONAL", "2026-04-14", fill_gaps=False)
    assert history.call_count == 1
    assert previous["Date"].max() == pd.Timestamp("2026-04-14")
    assert previous.attrs["requested_window"] == {"start": "2021-04-15", "end": "2026-04-14"}
    assert previous["HistoryRequestEnd"].eq("2026-04-16").all()
    assert previous["SourceTimestamp"].str.startswith("2026-04-15").sum() == 0


def test_raw_verifier_inputs_keep_missing_close_and_do_not_fill_other_cells(monkeypatch, tmp_path):
    from types import SimpleNamespace

    frame = _ohlcv("Date").set_index("Date")
    frame.loc[frame.index[-1], "Close"] = None
    frame.loc[frame.index[-2], "Open"] = None
    monkeypatch.setattr(
        su.yf, "Ticker", lambda symbol: SimpleNamespace(history=lambda **kwargs: frame)
    )
    monkeypatch.setattr(su, "get_config", lambda: {"data_cache_dir": str(tmp_path)})
    output = su.load_ohlcv("FICTIONAL", "2026-04-14", fill_gaps=False)
    assert len(output) == len(frame)
    assert pd.isna(output.iloc[-1]["Close"])
    assert pd.isna(output.iloc[-2]["Open"])


def test_missing_weekday_row_does_not_invent_a_holiday(monkeypatch):
    frame = _ohlcv("Date").head(1)
    monkeypatch.setattr(su, "load_ohlcv", lambda *args, **kwargs: frame.copy())
    output = su.StockstatsUtils.get_stock_stats("FICTIONAL", "rsi", "2026-04-02")
    assert output == "N/A: No provider row for this date; session/calendar coverage unknown"
