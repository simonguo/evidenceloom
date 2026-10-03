from typing import Annotated

from langchain_core.tools import tool
from langgraph.prebuilt import InjectedState
from tradingagents.dataflows.date_window import as_of

from tradingagents.dataflows.market_data_validator import build_verified_market_snapshot
from tradingagents.dataflows.errors import NoMarketDataError, VendorUnavailableError
from tradingagents.dataflows.interface import no_data_available, vendor_unavailable
from tradingagents.evidence import capture_evidence


@tool
def get_verified_market_snapshot(
    symbol: Annotated[str, InjectedState("company_of_interest")],
    curr_date: Annotated[str, "the current trading date, YYYY-mm-dd"],
    look_back_days: Annotated[
        int, "number of recent trading rows to include for sanity-checking"
    ] = 30,
    trade_date: Annotated[str, InjectedState("trade_date")] = "",
) -> str:
    """Deterministic verification snapshot for exact market-data claims.

    Returns the latest OHLCV row on or before curr_date, common technical
    indicators, and recent closes. Call this before making exact claims about
    price levels, Bollinger bands, RSI, MACD, moving averages, support /
    resistance, or historical comparisons, and treat it as the source of truth.
    """
    curr_date = as_of(curr_date, trade_date)
    look_back_days = max(1, min(int(look_back_days), 30))

    def operation():
        try:
            return build_verified_market_snapshot(symbol, curr_date, look_back_days)
        except NoMarketDataError as exc:
            return no_data_available(exc)
        except VendorUnavailableError as exc:
            return vendor_unavailable("get_verified_market_snapshot", exc)

    return capture_evidence(
        "get_verified_market_snapshot",
        {"symbol": symbol, "curr_date": curr_date, "look_back_days": look_back_days},
        operation,
    )
