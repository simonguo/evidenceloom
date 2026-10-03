import json
from copy import deepcopy

from .alpha_vantage_common import _make_api_request
from .date_window import withhold_live_profile, withhold_undated_statements
from .errors import VendorUnavailableError


def _filter_reports_by_date(result, curr_date: str):
    """Filter fiscal periods in either JSON-string or dict payloads.

    This helper only limits the periods; it does not establish filing dates.
    The provider withholds historical statements before making the request.
    """
    if not curr_date:
        return result
    is_string = isinstance(result, str)
    try:
        payload = json.loads(result) if is_string else deepcopy(result)
    except (json.JSONDecodeError, TypeError) as exc:
        raise VendorUnavailableError(
            "Alpha Vantage returned malformed financial statements"
        ) from exc
    if not isinstance(payload, dict):
        raise VendorUnavailableError("Alpha Vantage returned unexpected financial statements")
    for key in ("annualReports", "quarterlyReports"):
        if key in payload:
            payload[key] = [
                row
                for row in payload[key]
                if row.get("fiscalDateEnding") and row["fiscalDateEnding"] <= curr_date
            ]
    return json.dumps(payload) if is_string else payload


def get_fundamentals(ticker: str, curr_date: str = None) -> str:
    """Current company overview, withheld for historical dates."""
    withheld = withhold_live_profile(curr_date, ticker)
    if withheld:
        return withheld
    return _make_api_request("OVERVIEW", {"symbol": ticker})


def _statement(ticker, freq, curr_date, title, endpoint):
    withheld = withhold_undated_statements(curr_date, ticker, title)
    if withheld:
        return withheld
    return _filter_reports_by_date(_make_api_request(endpoint, {"symbol": ticker}), curr_date)


def get_balance_sheet(ticker: str, freq: str = "quarterly", curr_date: str = None):
    """Balance sheet with a known-date guard for historical runs."""
    return _statement(ticker, freq, curr_date, "Balance Sheet", "BALANCE_SHEET")


def get_cashflow(ticker: str, freq: str = "quarterly", curr_date: str = None):
    """Cash flow with a known-date guard for historical runs."""
    return _statement(ticker, freq, curr_date, "Cash Flow", "CASH_FLOW")


def get_income_statement(ticker: str, freq: str = "quarterly", curr_date: str = None):
    """Income statement with a known-date guard for historical runs."""
    return _statement(ticker, freq, curr_date, "Income Statement", "INCOME_STATEMENT")
