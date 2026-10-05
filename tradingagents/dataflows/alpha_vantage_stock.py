from datetime import datetime
from io import StringIO

import pandas as pd

from .alpha_vantage_common import _make_api_request, _filter_csv_by_date_range
from .errors import NoMarketDataError
from .evidence_utils import frame_data, observed_window
from .alpha_vantage_common import API_BASE_URL
from tradingagents.evidence import observe_source


def get_stock(symbol: str, start_date: str, end_date: str) -> str:
    """
    Returns raw daily OHLCV values, adjusted close values, and historical split/dividend events
    filtered to the specified date range.

    Args:
        symbol: The name of the equity. For example: symbol=IBM
        start_date: Start date in yyyy-mm-dd format
        end_date: End date in yyyy-mm-dd format

    Returns:
        CSV string containing the daily adjusted time series data filtered to the date range.
    """
    # Parse dates to determine the range
    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    today = datetime.now()

    # Choose outputsize based on whether the requested range is within the latest 100 days
    # Compact returns latest 100 data points, so check if start_date is recent enough
    days_from_today_to_start = (today - start_dt).days
    outputsize = "compact" if days_from_today_to_start < 100 else "full"

    params = {
        "symbol": symbol,
        "outputsize": outputsize,
        "datatype": "csv",
    }

    response = _make_api_request("TIME_SERIES_DAILY_ADJUSTED", params)

    filtered = _filter_csv_by_date_range(response, start_date, end_date)
    frame = pd.read_csv(StringIO(filtered)) if filtered.strip() else pd.DataFrame()
    allowed = {
        "timestamp",
        "open",
        "high",
        "low",
        "close",
        "adjusted_close",
        "volume",
        "dividend_amount",
        "split_coefficient",
    }
    frame = frame[[column for column in frame.columns if column in allowed]]
    if frame.empty:
        raise NoMarketDataError(
            symbol, detail=f"no Alpha Vantage rows within {start_date}..{end_date}"
        )
    observe_source(
        "alpha_vantage",
        url=API_BASE_URL,
        normalized_data=frame_data(frame),
        observed_window=observed_window(frame, frame.columns[0]),
        adjustments="Separately supplied adjusted_close column; OHLC fields left as supplied"
        if "adjusted_close" in frame.columns
        else None,
        transformations=("Requested inclusive date window enforced",),
    )
    return frame.to_csv(index=False)
