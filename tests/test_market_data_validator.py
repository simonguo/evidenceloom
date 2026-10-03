"""Tests for the deterministic market-data verification snapshot (#830/#881)."""

from __future__ import annotations

import pandas as pd
import pytest

import tradingagents.dataflows.market_data_validator as validator


def _sample_ohlcv() -> pd.DataFrame:
    dates = pd.bdate_range("2026-04-01", "2026-05-20", tz="America/New_York")
    closes = [100 + i for i in range(len(dates))]
    return pd.DataFrame(
        {
            "Date": dates,
            "Open": [c - 0.5 for c in closes],
            "High": [c + 1.0 for c in closes],
            "Low": [c - 1.0 for c in closes],
            "Close": closes,
            "Volume": [1_000_000 + i for i in range(len(dates))],
        }
    )


@pytest.mark.unit
class TestVerifiedSnapshot:
    def test_excludes_future_rows(self, monkeypatch):
        data = pd.concat(
            [
                _sample_ohlcv(),
                pd.DataFrame(
                    {
                        "Date": [pd.Timestamp("2026-06-01")],
                        "Open": [999.0],
                        "High": [999.0],
                        "Low": [999.0],
                        "Close": [999.0],
                        "Volume": [999],
                    }
                ),
            ],
            ignore_index=True,
        )
        monkeypatch.setattr(validator, "load_ohlcv", lambda s, d, **kwargs: data)

        snap = validator.build_verified_market_snapshot("COF", "2026-05-13")
        assert "Market data integrity snapshot for COF" in snap
        assert "Requested analysis date: 2026-05-13" in snap
        assert "Latest trading row used: 2026-05-13" in snap
        assert "999.00" not in snap  # future row excluded
        assert "boll_lb" in snap  # indicators present

    def test_uses_previous_trading_day_when_date_is_weekend(self, monkeypatch):
        monkeypatch.setattr(validator, "load_ohlcv", lambda s, d, **kwargs: _sample_ohlcv())
        # 2026-05-16 is a Saturday; latest row should be Fri 2026-05-15
        snap = validator.build_verified_market_snapshot("COF", "2026-05-16")
        assert "Latest trading row used: 2026-05-15" in snap
        assert "Recent observed closes" in snap

    def test_raises_when_no_rows_on_or_before_date(self, monkeypatch):
        monkeypatch.setattr(validator, "load_ohlcv", lambda s, d, **kwargs: _sample_ohlcv())
        with pytest.raises(validator.NoMarketDataError):
            validator.build_verified_market_snapshot("COF", "2020-01-01")

    def test_raises_on_empty_data(self, monkeypatch):
        monkeypatch.setattr(validator, "load_ohlcv", lambda s, d, **kwargs: pd.DataFrame())
        with pytest.raises(validator.NoMarketDataError):
            validator.build_verified_market_snapshot("COF", "2026-05-13")

    def test_look_back_window_capped_at_30(self, monkeypatch):
        monkeypatch.setattr(validator, "load_ohlcv", lambda s, d, **kwargs: _sample_ohlcv())
        snap = validator.build_verified_market_snapshot("COF", "2026-05-20", look_back_days=999)
        # last-N closes table has at most 30 data rows
        close_rows = [ln for ln in snap.splitlines() if ln.startswith("| 2026-")]
        assert 0 < len(close_rows) <= 30


@pytest.mark.unit
class TestTool:
    def test_tool_delegates_to_builder(self, monkeypatch):
        from tradingagents.agents.utils.market_data_validation_tools import (
            get_verified_market_snapshot,
        )

        monkeypatch.setattr(validator, "load_ohlcv", lambda s, d, **kwargs: _sample_ohlcv())
        out = get_verified_market_snapshot.invoke({"symbol": "COF", "curr_date": "2026-05-20"})
        assert "Market data integrity snapshot for COF" in out


def _quality_snapshot(
    monkeypatch, frame, *, date="2026-01-15", observed="2026-01-16T12:00:00Z", indicators=None
):
    captured = []
    monkeypatch.setattr(validator, "load_ohlcv", lambda *args, **kwargs: frame.copy())
    monkeypatch.setattr(
        validator,
        "observe_source",
        lambda provider, **kwargs: captured.append(kwargs["normalized_data"]),
    )
    output = validator.build_verified_market_snapshot(
        "FICTIONAL", date, indicators=indicators, observed_at=observed
    )
    quality = next(item for item in captured if item.get("kind") == "market_verification_quality")
    return output, quality, captured


def _daily_frame(count=230, *, zone="America/New_York", last="2026-01-15"):
    dates = pd.date_range(end=last, periods=count, tz=zone)
    closes = [100.12345678901234 + index * 0.123456789012345 for index in range(count)]
    return pd.DataFrame(
        {
            "Date": dates,
            "Open": [value - 0.3 for value in closes],
            "High": [value + 1 for value in closes],
            "Low": [value - 1 for value in closes],
            "Close": closes,
            "Volume": [1234567] * count,
        }
    )


@pytest.mark.unit
class TestDailyScientificIntegrity:
    @pytest.mark.parametrize(
        "zone,observed",
        [
            ("Asia/Shanghai", "2026-01-15T07:30:00Z"),
            ("Asia/Hong_Kong", "2026-01-15T09:30:00Z"),
            ("America/New_York", "2026-01-15T23:00:00Z"),
        ],
    )
    def test_same_day_is_provisional_even_with_nonnull_close_after_close(
        self, monkeypatch, zone, observed
    ):
        output, quality, _ = _quality_snapshot(
            monkeypatch, _daily_frame(zone=zone), observed=observed
        )
        assert quality["completion_status"] == "provisional"
        assert quality["rows"]["provisional"] == 1
        assert quality["rows"]["latest_usable_date"] == "2026-01-14"
        assert "Latest trading row used: 2026-01-14" in output
        assert "not proof of a completed session" in output

    def test_utc_day_must_elapse_even_when_source_local_day_elapsed(self, monkeypatch):
        _, quality, _ = _quality_snapshot(
            monkeypatch, _daily_frame(zone="Asia/Hong_Kong"), observed="2026-01-15T20:00:00Z"
        )
        assert quality["rows"]["latest_usable_date"] == "2026-01-14"
        _, later, _ = _quality_snapshot(
            monkeypatch, _daily_frame(zone="Asia/Hong_Kong"), observed="2026-01-16T00:00:00Z"
        )
        assert later["completion_status"] == "complete_provider_daily_rows"
        assert later["rows"]["latest_usable_date"] == "2026-01-15"

    def test_unknown_timezone_is_observed_not_certified(self, monkeypatch):
        output, quality, captured = _quality_snapshot(monkeypatch, _daily_frame(zone=None))
        assert quality["source_timezone"] is None and quality["timezone_origin"] == "unknown"
        assert quality["completion_status"] == "unknown"
        assert quality["rows"]["usable_complete"] == 0
        assert all(
            item["status"] == "unavailable_input" and item["value"] is None
            for item in quality["indicator_assessments"].values()
        )
        assert "| Close |" in output and "N/A (unavailable_input" in output
        assert captured[0]["indicator_values"]["close_200_sma"] is None

    def test_declared_provider_timezone_is_distinct_from_observed_timestamp(self, monkeypatch):
        frame = _daily_frame(zone=None)
        frame.attrs["source_timezone"] = "Asia/Shanghai"
        _, quality, _ = _quality_snapshot(monkeypatch, frame)
        assert quality["source_timezone"] == "Asia/Shanghai"
        assert quality["timezone_origin"] == "provider_metadata"
        assert quality["completion_status"] == "complete_provider_daily_rows"
        assert quality["price_basis"] == {"status": "unknown", "value": None}
        assert quality["revision_status"] == quality["calendar_coverage_status"] == "unknown"

    def test_intraday_label_is_not_a_completed_daily_bar(self, monkeypatch):
        frame = _daily_frame(count=1)
        frame["Date"] += pd.Timedelta(hours=12)
        _, quality, _ = _quality_snapshot(monkeypatch, frame)
        assert quality["completion_status"] == "provisional"
        assert quality["rows"]["usable_complete"] == 0

    @pytest.mark.parametrize(
        "field,value,reason",
        [
            ("Close", float("inf"), "missing_or_nonfinite_close"),
            ("Open", None, "missing_or_nonfinite_open"),
            ("Close", 0, "nonpositive_price"),
            ("Low", -1, "nonpositive_price"),
            ("Volume", -1, "negative_volume"),
            ("High", 1, "incoherent_ohlc"),
            ("Low", 1000, "incoherent_ohlc"),
        ],
    )
    def test_invalid_prices_never_feed_indicator_calculations(
        self, monkeypatch, field, value, reason
    ):
        frame = _daily_frame()
        frame.loc[frame.index[-1], field] = value
        output, quality, _ = _quality_snapshot(monkeypatch, frame)
        assert quality["integrity_status"] == "invalid"
        assert quality["rows"]["invalid"] == 1 and reason in quality["issues"]
        assert all(
            item["status"] == "unavailable_input" and item["value"] is None
            for item in quality["indicator_assessments"].values()
        )
        assert "| Close | inf |" not in output

    def test_conflicting_duplicate_order_cannot_select_latest_close(self, monkeypatch):
        frame = _daily_frame()
        duplicate = frame.tail(1).copy()
        duplicate["Close"] += 0.1
        outputs = []
        assessments = []
        for rows in [pd.concat([frame, duplicate]), pd.concat([duplicate, frame])]:
            output, quality, _ = _quality_snapshot(monkeypatch, rows)
            outputs.append(output)
            assessments.append(quality)
        assert outputs[0] == outputs[1]
        assert assessments[0] == assessments[1]
        assert assessments[0]["rows"]["conflicting_duplicate_dates"] == ["2026-01-15"]
        assert "| Close | N/A (conflicting provider rows) |" in outputs[0]

    def test_identical_duplicate_is_collapsed_without_changing_calculation(self, monkeypatch):
        frame = _daily_frame()
        _, baseline, _ = _quality_snapshot(monkeypatch, frame)
        _, quality, _ = _quality_snapshot(monkeypatch, pd.concat([frame, frame.tail(1)]))
        assert quality["integrity_status"] == "valid"
        assert quality["rows"]["identical_duplicates_collapsed"] == 1
        assert quality["indicator_assessments"] == baseline["indicator_assessments"]

    def test_two_row_history_cannot_claim_two_hundred_row_sma(self, monkeypatch):
        frame = _daily_frame(count=2)
        output, quality, _ = _quality_snapshot(monkeypatch, frame)
        assessment = quality["indicator_assessments"]["close_200_sma"]
        assert assessment == {
            "status": "insufficient_warmup",
            "required_rows": 200,
            "usable_rows": 2,
            "value": None,
        }
        assert "N/A (insufficient_warmup; requires 200 rows, has 2)" in output

    def test_warmup_boundary_and_full_precision_are_explicit(self, monkeypatch):
        for count, expected in [(199, "insufficient_warmup"), (200, "available")]:
            _, quality, captured = _quality_snapshot(
                monkeypatch, _daily_frame(count=count), indicators=["close_200_sma"]
            )
            assessment = quality["indicator_assessments"]["close_200_sma"]
            assert assessment["status"] == expected
            if count == 200:
                exact = sum(_daily_frame(count=count)["Close"]) / 200
                assert assessment["value"] == pytest.approx(exact, abs=1e-12)
                assert assessment["value"] != round(assessment["value"], 2)
                assert captured[0]["indicator_values"]["close_200_sma"] == assessment["value"]

    def test_dst_original_offsets_survive_normalized_calculation_dates(self, monkeypatch):
        frame = _daily_frame(last="2025-11-04", count=10)
        seen = []
        monkeypatch.setattr(
            validator, "observe_ohlcv", lambda rows, **kwargs: seen.append(rows.copy())
        )
        _, quality, _ = _quality_snapshot(
            monkeypatch, frame, date="2025-11-04", observed="2025-11-06T00:00:00Z"
        )
        assert quality["source_timezone"] == "America/New_York"
        assert set(seen[0]["SourceUTCOffset"]) == {"-04:00", "-05:00"}
        assert seen[0]["SourceTimestamp"].str.endswith("-04:00").any()
        assert seen[0]["SourceTimestamp"].str.endswith("-05:00").any()


def test_quality_is_saved_as_separate_hashed_artifact_with_exact_precision(monkeypatch, tmp_path):
    import json
    from tradingagents.evidence import EvidenceLedger

    frame = _daily_frame()
    frame.attrs.update({"source": "yfinance", "price_basis": "auto_adjusted_ohlcv"})
    monkeypatch.setattr(validator, "load_ohlcv", lambda *args, **kwargs: frame.copy())
    ledger = EvidenceLedger("FICTIONAL", "2026-01-15", {}, tmp_path)
    checkpoint = ledger.bundle()
    with ledger.bind():
        text = ledger.capture(
            "get_verified_market_snapshot",
            {"symbol": "FICTIONAL", "curr_date": "2026-01-15"},
            lambda: validator.build_verified_market_snapshot(
                "FICTIONAL", "2026-01-15", observed_at="2026-01-16T12:00:00Z"
            ),
        )
    bundle = ledger.bundle()
    record = bundle["records"][0]
    saved = [
        bundle["artifacts"][source["data_sha256"]]
        for source in record["sources"]
        if source["data_sha256"]
    ]
    payloads = [json.loads(artifact["payload"]) for artifact in saved]
    quality = next(
        value for value in payloads if value.get("kind") == "market_verification_quality"
    )
    precise = next(value for value in payloads if "indicator_values" in value)
    assert record["status"] == "available"
    assert quality["integrity_status"] == "valid"
    assert quality["completion_status"] == "complete_provider_daily_rows"
    exact = quality["indicator_assessments"]["close_10_ema"]["value"]
    assert exact == precise["indicator_values"]["close_10_ema"]
    assert exact != round(exact, 2)
    assert all(isinstance(artifact["payload"], str) for artifact in saved)
    # Resume from the graph checkpoint saved before this call. Its successful
    # durable source capture must replay when the failed node runs again.
    restored = EvidenceLedger.restore(checkpoint, tmp_path)
    with restored.bind():
        replay = restored.capture(
            "get_verified_market_snapshot",
            {"symbol": "FICTIONAL", "curr_date": "2026-01-15"},
            lambda: (_ for _ in ()).throw(
                AssertionError("saved capture must replay without source access")
            ),
        )
    assert replay == text
    assert restored.bundle()["artifacts"] == bundle["artifacts"]


def test_invalid_timezone_metadata_cannot_certify_daily_completion(monkeypatch):
    frame = _daily_frame(zone=None)
    frame.attrs["source_timezone"] = "Not_A_Real_Timezone"
    _, quality, _ = _quality_snapshot(monkeypatch, frame)
    assert quality["source_timezone"] is None and quality["timezone_origin"] == "unknown"
    assert quality["completion_status"] == "unknown"
    assert quality["rows"]["usable_complete"] == 0


def test_completion_observation_clock_uses_original_zone_after_dst_change(monkeypatch):
    frame = _daily_frame(last="2025-11-02", count=1)
    # The source bar's midnight uses EDT, while the observation is after the
    # move to EST. At 04:30 UTC the original market still has November 2.
    _, quality, _ = _quality_snapshot(
        monkeypatch, frame, date="2025-11-02", observed="2025-11-03T04:30:00Z"
    )
    assert quality["completion_status"] == "provisional"
    assert quality["rows"]["usable_complete"] == 0
    _, elapsed, _ = _quality_snapshot(
        monkeypatch, frame, date="2025-11-02", observed="2025-11-03T05:30:00Z"
    )
    assert elapsed["completion_status"] == "complete_provider_daily_rows"


def test_market_timezone_convention_is_not_observed_provider_completion(monkeypatch):
    frame = _daily_frame(zone=None)
    frame.attrs.update(
        {"source_timezone": "Asia/Shanghai", "timezone_origin": "symbol_market_convention"}
    )
    _, quality, _ = _quality_snapshot(monkeypatch, frame)
    assert quality["source_timezone"] == "Asia/Shanghai"
    assert quality["timezone_origin"] == "symbol_market_convention"
    assert quality["completion_status"] == "unknown"
    assert quality["rows"]["usable_complete"] == 0
