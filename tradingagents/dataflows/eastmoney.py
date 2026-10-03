from __future__ import annotations

from datetime import datetime
from io import StringIO
import json
import subprocess
import time
from typing import Annotated
from urllib.parse import urlencode

import pandas as pd
import requests

from .symbol_utils import NoMarketDataError
from .evidence_utils import frame_data, observed_window, observe_ohlcv, source_attempt
from tradingagents.evidence import observe_source


EASTMONEY_KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
TENCENT_KLINE_URL = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"


def _get_without_env_proxy(url: str, **kwargs) -> requests.Response:
    session = requests.Session()
    session.trust_env = False
    return session.get(url, **kwargs)


def _fetch_json(url: str, params: dict) -> dict:
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://quote.eastmoney.com/",
    }
    try:
        response = _get_without_env_proxy(url, params=params, headers=headers, timeout=15)
        response.raise_for_status()
        return response.json()
    except Exception:
        full_url = f"{url}?{urlencode(params)}"
        completed = subprocess.run(
            [
                "curl",
                "-sS",
                "--connect-timeout",
                "10",
                "--max-time",
                "20",
                "-H",
                f"User-Agent: {headers['User-Agent']}",
                "-H",
                f"Referer: {headers['Referer']}",
                full_url,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(completed.stdout)


def _fetch_json_with_curl(url: str, params: dict) -> dict:
    full_url = f"{url}?{urlencode(params)}"
    completed = subprocess.run(
        [
            "curl",
            "-sS",
            "-L",
            "--connect-timeout",
            "10",
            "--max-time",
            "20",
            full_url,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def _normalize_a_share_symbol(symbol: str) -> tuple[str, str]:
    raw = symbol.strip().upper()
    code = raw
    market = None

    if raw.startswith("SH") and len(raw) == 8:
        code = raw[2:]
        market = "1"
    elif raw.startswith("SZ") and len(raw) == 8:
        code = raw[2:]
        market = "0"
    elif raw.endswith(".SS") or raw.endswith(".SH"):
        code = raw[:6]
        market = "1"
    elif raw.endswith(".SZ"):
        code = raw[:6]
        market = "0"
    elif len(raw) == 6 and raw.isdigit():
        code = raw

    if not (len(code) == 6 and code.isdigit()):
        raise NoMarketDataError(symbol, raw, "not an A-share symbol")

    if market is None:
        market = "1" if code.startswith(("5", "6", "9")) else "0"

    return code, f"{market}.{code}"


def _fetch_kline(symbol: str, start_date: str, end_date: str) -> tuple[str, pd.DataFrame]:
    """Return the successful provider's rows, retaining its identity in attrs.

    This module is the A-share routing adapter; it may serve Tencent even when
    the configured adapter is named Eastmoney. Do not infer the actual source
    from that configuration or the module name.
    """
    code, secid = _normalize_a_share_symbol(symbol)
    started = time.monotonic()
    try:
        data = _fetch_tencent_kline(code, secid, start_date, end_date)
        source_attempt("tencent", "available", (time.monotonic() - started) * 1000)
        return code, _with_source(data, "Tencent", TENCENT_KLINE_URL)
    except NoMarketDataError:
        source_attempt("tencent", "empty", (time.monotonic() - started) * 1000)
    except Exception:
        source_attempt("tencent", "unavailable", (time.monotonic() - started) * 1000)

    started = time.monotonic()
    try:
        data = _fetch_eastmoney_kline(symbol, code, secid, start_date, end_date)
        source_attempt("eastmoney", "available", (time.monotonic() - started) * 1000)
        return code, data
    except NoMarketDataError:
        source_attempt("eastmoney", "empty", (time.monotonic() - started) * 1000)
        raise
    except Exception:
        source_attempt("eastmoney", "unavailable", (time.monotonic() - started) * 1000)
        raise


def _fetch_eastmoney_kline(symbol, code, secid, start_date, end_date):

    params = {
        "secid": secid,
        "klt": "101",
        "fqt": "1",
        "beg": start_date.replace("-", ""),
        "end": end_date.replace("-", ""),
        "fields1": "f1,f2,f3,f4,f5,f6",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    }
    payload = _fetch_json(EASTMONEY_KLINE_URL, params)
    rows = (payload.get("data") or {}).get("klines") or []
    if not rows:
        raise NoMarketDataError(symbol, code, f"no rows between {start_date} and {end_date}")

    df = pd.read_csv(
        StringIO("\n".join(rows)),
        names=[
            "Date",
            "Open",
            "Close",
            "High",
            "Low",
            "Volume",
            "Amount",
            "Amplitude",
            "Pct_change",
            "Change",
            "Turnover",
        ],
    )
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    for column in ["Open", "High", "Low", "Close", "Volume"]:
        df[column] = pd.to_numeric(df[column], errors="coerce")
    df = df.dropna(subset=["Date", "Close"])
    if df.empty:
        raise NoMarketDataError(
            symbol, code, f"no valid OHLCV rows between {start_date} and {end_date}"
        )

    data = df[["Date", "Open", "High", "Low", "Close", "Volume"]]
    used = data[
        (data["Date"] >= pd.Timestamp(start_date)) & (data["Date"] <= pd.Timestamp(end_date))
    ]
    if used.empty:
        raise NoMarketDataError(
            symbol, code, f"no Eastmoney rows between {start_date} and {end_date}"
        )
    observe_source(
        "eastmoney",
        url=EASTMONEY_KLINE_URL,
        normalized_data=frame_data(used),
        observed_window=observed_window(used),
        adjustments="Forward adjusted (fqt=1)",
        transformations=(
            "Daily OHLCV fields parsed to numeric values",
            "Requested date window enforced",
        ),
    )
    return _with_source(data, "Eastmoney", EASTMONEY_KLINE_URL)


def _with_source(data: pd.DataFrame, source: str, source_url: str) -> pd.DataFrame:
    """Attach provider metadata without changing caller-owned frames or return types."""
    result = data.copy()
    result.attrs.update({"source": source, "source_url": source_url})
    return result


def _fetch_tencent_kline(code: str, secid: str, start_date: str, end_date: str) -> pd.DataFrame:
    market = "sh" if secid.startswith("1.") else "sz"
    symbol = f"{market}{code}"
    params = {
        "param": f"{symbol},day,{start_date},{end_date},640,qfq",
    }
    payload = _fetch_json_with_curl(TENCENT_KLINE_URL, params)
    stock_payload = (payload.get("data") or {}).get(symbol) or {}
    adjusted = bool(stock_payload.get("qfqday"))
    rows = stock_payload.get("qfqday") or stock_payload.get("day") or []
    if not rows:
        raise NoMarketDataError(
            code, symbol, f"no Tencent rows between {start_date} and {end_date}"
        )

    rows = [row[:6] for row in rows if len(row) >= 6]
    df = pd.DataFrame(rows, columns=["Date", "Open", "Close", "High", "Low", "Volume"])
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    for column in ["Open", "High", "Low", "Close", "Volume"]:
        df[column] = pd.to_numeric(df[column], errors="coerce")
    df = df.dropna(subset=["Date", "Close"])
    if df.empty:
        raise NoMarketDataError(
            code, symbol, f"no valid Tencent OHLCV rows between {start_date} and {end_date}"
        )
    data = df[["Date", "Open", "High", "Low", "Close", "Volume"]]
    used = data[
        (data["Date"] >= pd.Timestamp(start_date)) & (data["Date"] <= pd.Timestamp(end_date))
    ]
    if used.empty:
        raise NoMarketDataError(
            code, symbol, f"no Tencent rows between {start_date} and {end_date}"
        )
    observe_source(
        "tencent",
        url=TENCENT_KLINE_URL,
        normalized_data=frame_data(used),
        observed_window=observed_window(used),
        adjustments="Forward adjusted (qfqday)" if adjusted else "Unadjusted (day)",
        transformations=(
            "Daily OHLCV fields parsed to numeric values",
            "Requested date window enforced",
        ),
    )
    return data


def get_stock_data(
    symbol: Annotated[str, "A-share ticker symbol"],
    start_date: Annotated[str, "Start date in yyyy-mm-dd format"],
    end_date: Annotated[str, "End date in yyyy-mm-dd format"],
) -> str:
    datetime.strptime(start_date, "%Y-%m-%d")
    datetime.strptime(end_date, "%Y-%m-%d")

    code, data = _fetch_kline(symbol, start_date, end_date)
    data = data[
        (data["Date"] >= pd.Timestamp(start_date)) & (data["Date"] <= pd.Timestamp(end_date))
    ]
    if data.empty:
        raise NoMarketDataError(symbol, code, f"no prices between {start_date} and {end_date}")
    observe_ohlcv(data, transformations=("Display prices rounded to two decimals",))
    rounded = data.copy()
    for column in ["Open", "High", "Low", "Close"]:
        rounded[column] = rounded[column].round(2)

    csv_string = rounded.to_csv(index=False)
    source = data.attrs.get("source", "Unknown provider")
    header = f"# Stock data for {code} ({source}, from {symbol}) from {start_date} to {end_date}\n"
    header += f"# Total records: {len(rounded)}\n"
    header += "\n"
    return header + csv_string


def load_ohlcv(symbol: str, curr_date: str) -> pd.DataFrame:
    curr_date_dt = pd.to_datetime(curr_date)
    start_date = (curr_date_dt - pd.DateOffset(years=5)).strftime("%Y-%m-%d")
    _, data = _fetch_kline(symbol, start_date, curr_date)
    return data[data["Date"] <= curr_date_dt]
