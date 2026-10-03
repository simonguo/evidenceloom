import logging
import os

import pandas as pd
import yfinance as yf

from tradingagents.dataflows.config import get_config
from tradingagents.dataflows.errors import NoMarketDataError, VendorError, VendorUnavailableError
from tradingagents.dataflows.files import replace_file
from .symbol_utils import normalize_symbol, is_a_share_symbol
from .utils import safe_ticker_component
from .eastmoney import load_ohlcv as load_eastmoney_ohlcv
from stockstats import wrap
from typing import Annotated
from tradingagents.dataflows.yfinance_common import raise_for_empty, yf_retry
from .evidence_utils import observe_ohlcv, scalar
from tradingagents.evidence import observe_source

logger = logging.getLogger(__name__)

# A vendor's latest OHLCV row this many calendar days before the requested date
# is treated as stale. Generous enough to span long holiday weekends, tight
# enough to catch the year-old frames yfinance occasionally returns (#1021).
MAX_OHLCV_STALE_DAYS = 10

# How long a same-day cache that does not yet reach the requested day may be
# reused before it is refetched (#1150). Short enough that an intraday run picks
# up today's close soon after it publishes, long enough that a day with no bar
# at all (weekend, holiday) cannot trigger a download on every call.
OHLCV_CACHE_TTL_SECONDS = 900


def _ensure_date_column(data: pd.DataFrame) -> pd.DataFrame:
    """Normalize the date column to ``Date``.

    Some yfinance builds leave the index unnamed (so ``reset_index()`` yields
    ``index``) or use ``Datetime`` for intraday data. Rename the first
    date-like column so indicators don't silently drop when it isn't ``Date``.
    """
    if "Date" in data.columns:
        return data
    for candidate in ("index", "Datetime", "date"):
        if candidate in data.columns:
            return data.rename(columns={candidate: "Date"})
    return data


def _local_midnight(value) -> pd.Timestamp:
    """A single timestamp as its naive, midnight-normalized local date (or NaT)."""
    if pd.isna(value):
        return pd.NaT
    try:
        ts = pd.Timestamp(value)
    except (ValueError, TypeError):
        return pd.NaT
    if ts.tzinfo is not None:
        ts = ts.tz_localize(None)  # drop tz, keep the local wall-clock date
    return ts.normalize()


def _normalize_dates(dates) -> pd.Series:
    """Parse to naive, midnight-normalized dates so tz-aware or intraday
    timestamps compare correctly against the naive ``curr_date`` cutoff (#1201).

    Normalized per element: 5 years of yfinance bars span daylight-saving
    changes (and cache CSVs round-trip the offsets as strings), so the series can
    carry mixed UTC offsets that ``pd.to_datetime`` cannot unify without
    ``utc=True`` — which would shift non-US (positive-offset) markets to the
    previous day. Keeping each bar's own local date avoids both.
    """
    return pd.to_datetime(pd.Series(dates).map(_local_midnight))


def preserve_source_dates(data: pd.DataFrame) -> pd.DataFrame:
    """Keep received timestamps and timezone evidence beside the working date.

    A naive timestamp is never assigned a timezone from its ticker. Old CSVs
    with explicit offsets retain those offsets, even when the original IANA
    zone name was not saved. Existing source columns survive cache replay.
    """
    result = _ensure_date_column(data).copy()
    if "Date" not in result:
        return result
    metadata = []
    declared = result.attrs.get("source_timezone")
    declared_origin = result.attrs.get("timezone_origin", "provider_metadata")
    if declared_origin not in {"provider_metadata", "symbol_market_convention", "unknown"}:
        declared_origin = "unknown"
    for value in result["Date"]:
        try:
            if isinstance(value, str) and value.rstrip().endswith("-00:00"):
                # RFC3339 negative zero means the offset is unknown. Parsing
                # it as UTC would invent a source clock that was not observed.
                metadata.append((value, None, None, "unknown"))
                continue
            stamp = pd.Timestamp(value)
            if pd.isna(stamp):
                raise ValueError
            zone = str(stamp.tzinfo) if stamp.tzinfo is not None else declared
            origin = (
                "timestamp"
                if stamp.tzinfo is not None
                else (declared_origin if declared else "unknown")
            )
            offset = stamp.strftime("%z") if stamp.tzinfo is not None else None
            if offset and len(offset) == 5:
                offset = offset[:3] + ":" + offset[3:]
            metadata.append((stamp.isoformat(), zone, offset, origin))
        except (TypeError, ValueError, OverflowError):
            metadata.append((None, None, None, "unknown"))
    for index, name in enumerate(
        ("SourceTimestamp", "SourceTimezone", "SourceUTCOffset", "TimezoneOrigin")
    ):
        if name not in result:
            result[name] = [row[index] for row in metadata]
    unknown_offsets = result["SourceTimestamp"].map(
        lambda value: isinstance(value, str) and value.rstrip().endswith("-00:00")
    )
    result.loc[unknown_offsets, ["SourceTimezone", "SourceUTCOffset"]] = None
    result.loc[unknown_offsets, "TimezoneOrigin"] = "unknown"
    return result


def _clean_dataframe(data: pd.DataFrame) -> pd.DataFrame:
    """Normalize a stock DataFrame for stockstats: parse/normalize dates and
    coerce prices to numeric (NaN where invalid). Dropping incomplete rows and
    filling gaps is left to ``_fill_price_gaps`` so the caller can first inspect
    the latest in-range bar (#1201)."""
    data = _ensure_date_column(data)
    if "Date" not in data or "Close" not in data:
        raise VendorUnavailableError("OHLCV response has no usable date or close column")
    data = preserve_source_dates(data)
    data["Date"] = _normalize_dates(data["Date"])
    data.attrs["invalid_timestamp_rows"] = int(data["Date"].isna().sum())
    data = data.dropna(subset=["Date"]).copy()

    price_cols = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in data.columns]
    data[price_cols] = data[price_cols].apply(pd.to_numeric, errors="coerce")
    return data


def _fill_price_gaps(data: pd.DataFrame) -> pd.DataFrame:
    """Drop rows with no close and forward/back-fill remaining price gaps so
    indicators compute on a continuous series."""
    price_cols = [c for c in ["Open", "High", "Low", "Close", "Volume"] if c in data.columns]
    # copy() so a filtered (sliced) input is written to safely, not via a view.
    data = data.dropna(subset=["Close"]).copy()
    data[price_cols] = data[price_cols].ffill().bfill()
    return data


def _coerce_ohlcv_dates(data: pd.DataFrame) -> pd.Series:
    """Return parsed dates from an OHLCV frame, whether Date is a column or the index."""
    if "Date" in data.columns:
        return _normalize_dates(data["Date"]).dropna()
    # yfinance keeps the dates in the index (a DatetimeIndex, sometimes unnamed).
    if isinstance(data.index, pd.DatetimeIndex):
        return _normalize_dates(data.index).dropna()
    # Fallback: expose the index and look for any date-like column.
    df = data.reset_index()
    for col in ("Date", "Datetime", "date", "index"):
        if col in df.columns:
            parsed = _normalize_dates(df[col]).dropna()
            if not parsed.empty:
                return parsed
    return pd.Series(dtype="datetime64[ns]")


def _assert_ohlcv_not_stale(
    data: pd.DataFrame,
    curr_date: str,
    symbol: str,
    canonical: str | None = None,
    *,
    max_stale_days: int = MAX_OHLCV_STALE_DAYS,
) -> None:
    """Reject OHLCV whose latest row is far older than curr_date.

    Raises NoMarketDataError (with a stale-specific detail) so the router treats
    it like any other "no usable data from this vendor" — try the next vendor,
    then emit one clear unavailable signal. Empty frames are left to the
    caller's existing no-data handling; this guards only the dangerous case of
    present-but-stale rows (a vendor returning a year-old frame that would
    otherwise feed wrong prices to the agent, #1021).
    """
    if data is None or data.empty:
        return
    requested = pd.to_datetime(curr_date, errors="coerce")
    if pd.isna(requested):
        return
    requested = requested.normalize()
    dates = _coerce_ohlcv_dates(data)
    if dates.empty:
        return
    latest = dates.max().normalize()
    stale_days = (requested - latest).days
    if stale_days > max_stale_days:
        raise NoMarketDataError(
            symbol,
            canonical,
            f"latest row is {latest.date()}, {stale_days} days before the "
            f"requested {requested.date()} (stale) — refusing to use it",
        )


def _cache_is_fresh(data_file, as_of_dt, now) -> bool:
    """Whether the symbol's cached download can serve this request.

    The file holds the download made on the day it was written, so it serves
    only that day. A current-day request also refetches once the file is older
    than the TTL: Yahoo publishes a partial daily candle during market hours,
    whose ``Close`` is not the closing price, and row inspection cannot tell it
    from a final one (#1150).
    """
    written = pd.Timestamp.fromtimestamp(os.path.getmtime(data_file))
    if written.date() != now.date():
        return False
    return (
        as_of_dt.date() < now.date() or (now - written).total_seconds() <= OHLCV_CACHE_TTL_SECONDS
    )


def _cache_window(data, start_str, end_str):
    """Return the recorded provider request, without claiming calendar coverage.

    Indicator windows call this loader for several past dates. Reuse may rely
    on 200 distinct received dates before that cutoff; the verifier still
    checks integrity, completion and each indicator's actual warm-up.
    """
    if not {"HistoryRequestStart", "HistoryRequestEnd"}.issubset(data.columns):
        return None
    starts, ends = (
        data["HistoryRequestStart"].dropna().unique(),
        data["HistoryRequestEnd"].dropna().unique(),
    )
    if len(starts) != 1 or len(ends) != 1:
        return None
    try:
        start, end = pd.Timestamp(starts[0]), pd.Timestamp(ends[0])
        requested_start, requested_end = pd.Timestamp(start_str), pd.Timestamp(end_str)
        if start.tzinfo is not None or end.tzinfo is not None or end < requested_end:
            return None
        dates = _coerce_ohlcv_dates(data)
        preceding = dates[(dates < requested_end) & (dates >= start)]
        if start <= requested_start or preceding.nunique() >= 200:
            return {"start": start.strftime("%Y-%m-%d"), "end": end.strftime("%Y-%m-%d")}
    except (ValueError, TypeError, OverflowError):
        pass
    return None


def load_ohlcv(symbol: str, curr_date: str, fill_gaps: bool = True) -> pd.DataFrame:
    """Fetch OHLCV data with caching, filtered to prevent look-ahead bias.

    Requests five years ending at the analysis cutoff, including its daily
    row. Bounded cache reuse retains its actual provider request window.
    Original timestamps/offsets remain beside the normalized working dates;
    date filtering does not establish publication or adjustment vintage.

    ``fill_gaps`` carries prices forward over gaps so indicators compute on a
    continuous series. Pass ``False`` to read the values as the vendor reported
    them, leaving a cell that was never reported empty.
    """
    # Resolve broker/forex symbols (XAUUSD+ -> GC=F) to Yahoo's convention,
    # then reject values that would escape the cache directory when
    # interpolated into the cache filename (e.g. ``../../tmp/x``).
    canonical = normalize_symbol(symbol)
    # Bare six-digit mainland codes include ETFs (e.g. 510300 and 159915),
    # beyond the stock prefixes used by the fundamentals coverage guard.
    mainland_code = isinstance(canonical, str) and len(canonical) == 6 and canonical.isdigit()
    if mainland_code or is_a_share_symbol(canonical):
        try:
            data = load_eastmoney_ohlcv(canonical, curr_date)
        except VendorError:
            raise
        except Exception as exc:
            raise VendorUnavailableError(
                f"A-share OHLCV request failed: {type(exc).__name__}"
            ) from exc
        data = _clean_dataframe(data)
        data = data[data["Date"] <= pd.Timestamp(curr_date).normalize()]
        data = _fill_price_gaps(data) if fill_gaps else data.copy()
        data.attrs["requested_window"] = {
            "start": (pd.Timestamp(curr_date) - pd.DateOffset(years=5)).strftime("%Y-%m-%d"),
            "end": curr_date,
        }
        _assert_ohlcv_not_stale(data, curr_date, symbol, canonical)
        if data.empty:
            raise NoMarketDataError(symbol, canonical, "no A-share prices in the requested window")
        observe_ohlcv(
            data,
            transformations=(
                "Dates normalized preserving local dates",
                "Rows after analysis date excluded",
                "Missing price cells forward then backward filled"
                if fill_gaps
                else "Reported missing cells retained for integrity assessment",
            ),
        )
        return data
    safe_symbol = safe_ticker_component(canonical)

    config = get_config()
    as_of_dt = pd.to_datetime(curr_date).normalize()

    # One cache file per symbol, with its actual request window stored in rows.
    now = pd.Timestamp.today()
    start_date = as_of_dt - pd.DateOffset(years=5)
    start_str = start_date.strftime("%Y-%m-%d")
    # Yahoo end is exclusive. Inclusion is not proof that this daily bar closed.
    end_str = (as_of_dt + pd.Timedelta(days=1)).strftime("%Y-%m-%d")

    os.makedirs(config["data_cache_dir"], exist_ok=True)
    data_file = os.path.join(
        config["data_cache_dir"],
        f"{safe_symbol}-YFin-data.csv",
    )

    # A cached file may be empty if a prior fetch failed (unknown symbol,
    # transient rate limit). Treat an empty/columnless cache as a miss and
    # re-fetch rather than serving the poisoned file forever.
    data = None
    cached_input = False
    provider_window = {"start": start_str, "end": end_str}
    if os.path.exists(data_file):
        try:
            cached = pd.read_csv(data_file, on_bad_lines="skip", encoding="utf-8")
        except (pd.errors.EmptyDataError, pd.errors.ParserError, OSError):
            cached = pd.DataFrame()
        cached_window = _cache_window(cached, start_str, end_str)
        if (
            not cached.empty
            and "Close" in cached.columns
            and _cache_is_fresh(data_file, as_of_dt, now)
            and cached_window is not None
        ):
            data = cached
            cached_input = True
            provider_window = cached_window

    if data is None:
        # yf.download catches every error, a rate limit included, and returns
        # an empty frame. Ticker.history raises the rate limit, so it is retried.
        downloaded = yf_retry(
            lambda: yf.Ticker(canonical).history(
                start=start_str,
                end=end_str,
                interval="1d",
                auto_adjust=True,
                back_adjust=False,
                actions=False,
                repair=False,
                rounding=False,
                keepna=True,
                prepost=False,
            )
        )
        if downloaded is None:
            raise_for_empty(symbol, canonical, "price rows")
        downloaded = _ensure_date_column(downloaded.reset_index())
        # Only cache real data — never persist an empty frame.
        if downloaded.empty or "Close" not in downloaded.columns:
            raise_for_empty(symbol, canonical, "price rows")
        downloaded = preserve_source_dates(downloaded)
        downloaded["HistoryRequestStart"] = start_str
        downloaded["HistoryRequestEnd"] = end_str
        downloaded["PriceBasis"] = "auto_adjusted_ohlcv"
        replace_file(data_file, lambda temp: downloaded.to_csv(temp, index=False, encoding="utf-8"))
        data = downloaded

    data.attrs.update({"source": "yfinance", "source_url": "https://finance.yahoo.com/"})
    data.attrs["requested_window"] = {"start": provider_window["start"], "end": curr_date}
    if "PriceBasis" in data and data["PriceBasis"].eq("auto_adjusted_ohlcv").all():
        data.attrs["price_basis"] = "auto_adjusted_ohlcv"
        data.attrs["adjustments"] = "auto_adjust=True requested; actions=False"

    data = _clean_dataframe(data)

    # Filter to curr_date to prevent look-ahead bias in backtesting.
    data = data[(data["Date"] >= start_date) & (data["Date"] <= as_of_dt)]
    if data.empty:
        raise NoMarketDataError(symbol, canonical, f"no OHLCV rows on or before {curr_date}")

    # A closeless newest bar is an unsettled session, not a symbol without data.
    # _fill_price_gaps below drops it, here and mid-series alike, so the frame
    # ends at the last settled bar; only a range with no close anywhere is no
    # data (#1201, #1289).
    if not data.empty and pd.isna(data["Close"].iloc[-1]):
        settled = data["Close"].notna().to_numpy().nonzero()[0]
        if settled.size == 0:
            raise NoMarketDataError(symbol, canonical, "no bar in range has a closing price")
        logger.warning(
            "%s: %d trailing bar(s) through %s have no closing price; using %s "
            "as the latest close.",
            canonical,
            len(data) - settled[-1] - 1,
            data["Date"].iloc[-1].date(),
            data["Date"].iloc[settled[-1]].date(),
        )

    # Indicators need a continuous series, so gaps are carried forward. A caller
    # that reports the numbers themselves asks for the frame as it was reported:
    # a filled cell is the previous session's price under this session's date.
    data = _fill_price_gaps(data) if fill_gaps else data.copy()

    # Reject a stale frame (latest row far older than curr_date) rather than
    # feeding year-old prices into indicators (#1021).
    _assert_ohlcv_not_stale(data, curr_date, symbol, canonical)

    transformations = [
        "Dates normalized preserving local dates",
        "Rows after analysis date excluded",
    ]
    if cached_input:
        transformations.append(
            "Loaded normalized local OHLCV cache; original retrieval time and adjustment vintage unknown"
        )
    transformations.append(
        "Missing price cells forward then backward filled"
        if fill_gaps
        else "Reported missing cells retained for integrity assessment"
    )
    observe_ohlcv(data, transformations=transformations)

    return data


def filter_financials_by_date(data: pd.DataFrame, curr_date: str) -> pd.DataFrame:
    """Limit fiscal periods, without establishing when their figures became public.

    Kept for existing imports; the providers withhold historical statements
    whose filing dates they cannot establish.
    """
    if not curr_date or data.empty:
        return data
    cutoff = pd.Timestamp(curr_date)
    mask = pd.to_datetime(data.columns, errors="coerce") <= cutoff
    return data.loc[:, mask]


class StockstatsUtils:
    @staticmethod
    def get_stock_stats(
        symbol: Annotated[str, "ticker symbol for the company"],
        indicator: Annotated[
            str, "quantitative indicators based off of the stock data for the company"
        ],
        curr_date: Annotated[str, "curr date for retrieving stock price data, YYYY-mm-dd"],
    ):
        data = load_ohlcv(symbol, curr_date)
        df = wrap(data)
        df["Date"] = df["Date"].dt.strftime("%Y-%m-%d")
        curr_date_str = pd.to_datetime(curr_date).strftime("%Y-%m-%d")

        df[indicator]  # trigger stockstats to calculate the indicator
        matching_rows = df[df["Date"].str.startswith(curr_date_str)]

        if not matching_rows.empty:
            indicator_value = matching_rows[indicator].values[0]
            observe_source(
                "local_calculation",
                normalized_data={
                    "indicator": indicator,
                    "date": curr_date_str,
                    "value": scalar(indicator_value),
                },
                observed_window={"start": curr_date_str, "end": curr_date_str},
                transformations=("Technical indicator calculated with stockstats",),
            )
            return indicator_value
        else:
            return "N/A: No provider row for this date; session/calendar coverage unknown"
