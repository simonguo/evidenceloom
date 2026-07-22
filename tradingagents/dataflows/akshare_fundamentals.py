from __future__ import annotations

from datetime import datetime
from typing import Annotated

import pandas as pd

from .symbol_utils import NoMarketDataError, is_a_share_symbol, normalize_symbol


def _import_akshare():
    try:
        import akshare as ak  # type: ignore
    except ImportError as exc:
        raise NoMarketDataError(
            "A-share",
            "A-share",
            "AkShare is not installed. Install project dependencies or run `pip install akshare`.",
        ) from exc
    return ak


def _a_share_code(ticker: str) -> str:
    canonical = normalize_symbol(ticker)
    if not is_a_share_symbol(canonical):
        raise NoMarketDataError(
            ticker,
            canonical,
            "AkShare fundamentals adapter only supports mainland China A-share symbols.",
        )
    return canonical.upper().split(".", 1)[0]


def _eastmoney_symbol(code: str) -> str:
    if code.startswith(("6", "9")):
        return f"SH{code}"
    if code.startswith(("0", "2", "3")):
        return f"SZ{code}"
    return f"BJ{code}"


def _sina_symbol(code: str) -> str:
    if code.startswith(("6", "9")):
        return f"sh{code}"
    if code.startswith(("0", "2", "3")):
        return f"sz{code}"
    return f"bj{code}"


def _is_empty_frame(data: object) -> bool:
    return not isinstance(data, pd.DataFrame) or data.empty


def _trim_frame(data: pd.DataFrame, curr_date: str | None = None, rows: int = 12) -> pd.DataFrame:
    frame = data.copy()
    if curr_date:
        for column in ("报告期", "报告日期", "日期", "REPORT_DATE", "SECURITY_CODE"):
            if column in frame.columns:
                dates = pd.to_datetime(frame[column], errors="coerce")
                cutoff = pd.to_datetime(curr_date, errors="coerce")
                if pd.notna(cutoff):
                    frame = frame[dates.isna() | (dates <= cutoff)]
                break
    return frame.head(rows)


def _to_markdown_or_csv(data: pd.DataFrame) -> str:
    try:
        return data.to_markdown(index=False)
    except Exception:
        return data.to_csv(index=False)


def _format_frame(
    title: str, ticker: str, source: str, data: pd.DataFrame, curr_date: str | None = None
) -> str:
    if _is_empty_frame(data):
        raise NoMarketDataError(ticker, ticker, f"AkShare returned no rows for {title}")
    frame = _trim_frame(data, curr_date)
    header = f"# {title} for {ticker}\n"
    header += f"# Source: AkShare / {source}\n"
    header += f"# Data retrieved on: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
    return header + _to_markdown_or_csv(frame)


def get_fundamentals(
    ticker: Annotated[str, "ticker symbol of the company"],
    curr_date: Annotated[str, "current date"] = None,
) -> str:
    code = _a_share_code(ticker)
    ak = _import_akshare()
    sections: list[str] = []

    if hasattr(ak, "stock_financial_abstract"):
        data = ak.stock_financial_abstract(symbol=code)
        if not _is_empty_frame(data):
            sections.append(
                _format_frame(
                    "A-share financial abstract", code, "stock_financial_abstract", data, curr_date
                )
            )

    if hasattr(ak, "stock_financial_analysis_indicator"):
        start_year = (curr_date or str(datetime.now().year))[:4]
        data = ak.stock_financial_analysis_indicator(symbol=code, start_year=start_year)
        if not _is_empty_frame(data):
            sections.append(
                _format_frame(
                    "A-share financial indicators",
                    code,
                    "stock_financial_analysis_indicator",
                    data,
                    curr_date,
                )
            )

    if not sections:
        raise NoMarketDataError(ticker, code, "AkShare returned no fundamental summary rows")

    return "\n\n".join(sections)


def _get_eastmoney_report(
    ticker: str, curr_date: str | None, title: str, source: str, function_name: str
) -> str:
    code = _a_share_code(ticker)
    symbol = _eastmoney_symbol(code)
    ak = _import_akshare()
    func = getattr(ak, function_name, None)
    if func is None:
        raise NoMarketDataError(ticker, symbol, f"AkShare function {function_name} is unavailable")
    data = func(symbol=symbol)
    return _format_frame(title, symbol, source, data, curr_date)


def _get_sina_report(ticker: str, curr_date: str | None, title: str, report_name: str) -> str:
    code = _a_share_code(ticker)
    symbol = _sina_symbol(code)
    ak = _import_akshare()
    func = getattr(ak, "stock_financial_report_sina", None)
    if func is None:
        raise NoMarketDataError(
            ticker, symbol, "AkShare function stock_financial_report_sina is unavailable"
        )
    data = func(stock=symbol, symbol=report_name)
    return _format_frame(title, symbol, "stock_financial_report_sina", data, curr_date)


def get_balance_sheet(
    ticker: Annotated[str, "ticker symbol of the company"],
    freq: Annotated[str, "frequency of data: 'annual' or 'quarterly'"] = "quarterly",
    curr_date: Annotated[str, "current date in YYYY-MM-DD format"] = None,
) -> str:
    try:
        return _get_eastmoney_report(
            ticker,
            curr_date,
            "A-share balance sheet",
            "stock_balance_sheet_by_report_em",
            "stock_balance_sheet_by_report_em",
        )
    except NoMarketDataError:
        return _get_sina_report(ticker, curr_date, "A-share balance sheet", "资产负债表")


def get_cashflow(
    ticker: Annotated[str, "ticker symbol of the company"],
    freq: Annotated[str, "frequency of data: 'annual' or 'quarterly'"] = "quarterly",
    curr_date: Annotated[str, "current date in YYYY-MM-DD format"] = None,
) -> str:
    try:
        return _get_eastmoney_report(
            ticker,
            curr_date,
            "A-share cash flow statement",
            "stock_cash_flow_sheet_by_report_em",
            "stock_cash_flow_sheet_by_report_em",
        )
    except NoMarketDataError:
        return _get_sina_report(ticker, curr_date, "A-share cash flow statement", "现金流量表")


def get_income_statement(
    ticker: Annotated[str, "ticker symbol of the company"],
    freq: Annotated[str, "frequency of data: 'annual' or 'quarterly'"] = "quarterly",
    curr_date: Annotated[str, "current date in YYYY-MM-DD format"] = None,
) -> str:
    try:
        return _get_eastmoney_report(
            ticker,
            curr_date,
            "A-share income statement",
            "stock_profit_sheet_by_report_em",
            "stock_profit_sheet_by_report_em",
        )
    except NoMarketDataError:
        return _get_sina_report(ticker, curr_date, "A-share income statement", "利润表")
