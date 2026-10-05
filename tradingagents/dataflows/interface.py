# Import from vendor-specific modules
from .y_finance import (
    get_YFin_data_online,
    get_stock_stats_indicators_window,
    get_fundamentals as get_yfinance_fundamentals,
    get_balance_sheet as get_yfinance_balance_sheet,
    get_cashflow as get_yfinance_cashflow,
    get_income_statement as get_yfinance_income_statement,
    get_insider_transactions as get_yfinance_insider_transactions,
)
from .eastmoney import get_stock_data as get_eastmoney_stock
from .yfinance_news import get_news_yfinance, get_global_news_yfinance
from .alpha_vantage import (
    get_stock as get_alpha_vantage_stock,
    get_indicator as get_alpha_vantage_indicator,
    get_fundamentals as get_alpha_vantage_fundamentals,
    get_balance_sheet as get_alpha_vantage_balance_sheet,
    get_cashflow as get_alpha_vantage_cashflow,
    get_income_statement as get_alpha_vantage_income_statement,
    get_insider_transactions as get_alpha_vantage_insider_transactions,
    get_news as get_alpha_vantage_news,
    get_global_news as get_alpha_vantage_global_news,
)
from .akshare_fundamentals import (
    get_fundamentals as get_akshare_fundamentals,
    get_balance_sheet as get_akshare_balance_sheet,
    get_cashflow as get_akshare_cashflow,
    get_income_statement as get_akshare_income_statement,
)
from .alpha_vantage_common import AlphaVantageRateLimitError as AlphaVantageRateLimitError
from .errors import NoMarketDataError, VendorNotConfiguredError, VendorUnavailableError
from .evidence_utils import attempt_count
import logging
import time

from tradingagents.evidence import capture_evidence, observe_attempt

from yfinance.exceptions import YFRateLimitError

# Configuration and routing logic
from .config import get_config

logger = logging.getLogger(__name__)

# Tools organized by category
TOOLS_CATEGORIES = {
    "core_stock_apis": {"description": "OHLCV stock price data", "tools": ["get_stock_data"]},
    "technical_indicators": {
        "description": "Technical analysis indicators",
        "tools": ["get_indicators"],
    },
    "fundamental_data": {
        "description": "Company fundamentals",
        "tools": ["get_fundamentals", "get_balance_sheet", "get_cashflow", "get_income_statement"],
    },
    "news_data": {
        "description": "News and insider data",
        "tools": [
            "get_news",
            "get_global_news",
            "get_insider_transactions",
        ],
    },
}

VENDOR_LIST = [
    "yfinance",
    "eastmoney",
    "alpha_vantage",
    "akshare",
]

# Mapping of methods to their vendor-specific implementations
VENDOR_METHODS = {
    # core_stock_apis
    "get_stock_data": {
        "alpha_vantage": get_alpha_vantage_stock,
        "yfinance": get_YFin_data_online,
        "eastmoney": get_eastmoney_stock,
    },
    # technical_indicators
    "get_indicators": {
        "alpha_vantage": get_alpha_vantage_indicator,
        "yfinance": get_stock_stats_indicators_window,
    },
    # fundamental_data
    "get_fundamentals": {
        "akshare": get_akshare_fundamentals,
        "alpha_vantage": get_alpha_vantage_fundamentals,
        "yfinance": get_yfinance_fundamentals,
    },
    "get_balance_sheet": {
        "akshare": get_akshare_balance_sheet,
        "alpha_vantage": get_alpha_vantage_balance_sheet,
        "yfinance": get_yfinance_balance_sheet,
    },
    "get_cashflow": {
        "akshare": get_akshare_cashflow,
        "alpha_vantage": get_alpha_vantage_cashflow,
        "yfinance": get_yfinance_cashflow,
    },
    "get_income_statement": {
        "akshare": get_akshare_income_statement,
        "alpha_vantage": get_alpha_vantage_income_statement,
        "yfinance": get_yfinance_income_statement,
    },
    # news_data
    "get_news": {
        "alpha_vantage": get_alpha_vantage_news,
        "yfinance": get_news_yfinance,
    },
    "get_global_news": {
        "yfinance": get_global_news_yfinance,
        "alpha_vantage": get_alpha_vantage_global_news,
    },
    "get_insider_transactions": {
        "alpha_vantage": get_alpha_vantage_insider_transactions,
        "yfinance": get_yfinance_insider_transactions,
    },
}


def get_category_for_method(method: str) -> str:
    """Get the category that contains the specified method."""
    for category, info in TOOLS_CATEGORIES.items():
        if method in info["tools"]:
            return category
    raise ValueError(f"Method '{method}' not found in any category")


def get_vendor(category: str, method: str = None) -> str:
    """Get the configured vendor for a data category or specific tool method.
    Tool-level configuration takes precedence over category-level.
    """
    config = get_config()

    # Check tool-level configuration first (if method provided)
    if method:
        tool_vendors = config.get("tool_vendors", {})
        if method in tool_vendors:
            return tool_vendors[method]

    # Fall back to category-level configuration
    return config.get("data_vendors", {}).get(category, "default")


def vendor_unavailable(method: str, error: Exception) -> str:
    return (
        f"DATA_UNAVAILABLE: configured vendors for '{method}' are rate limited or "
        "unavailable. This says nothing about the instrument. "
        "Do not estimate or fabricate values; report the data as unavailable."
    )


def no_data_available(error: NoMarketDataError) -> str:
    resolved = "" if error.canonical == error.symbol else f" (resolved to '{error.canonical}')"
    reason = " Returned market data is stale." if "stale" in error.detail.lower() else ""
    return (
        f"NO_DATA_AVAILABLE: No usable market data for '{error.symbol}'{resolved} "
        f"from any configured vendor.{reason} The symbol may be invalid, delisted, "
        "not covered, or the returned data may be stale. Do not estimate or "
        "fabricate values; report that data is unavailable for this symbol."
    )


_PARAMETERS = {
    "get_stock_data": ("symbol", "start_date", "end_date"),
    "get_indicators": (
        "symbol",
        "indicator",
        "curr_date",
        "look_back_days",
        "interval",
        "time_period",
        "series_type",
    ),
    "get_fundamentals": ("ticker", "curr_date"),
    "get_balance_sheet": ("ticker", "freq", "curr_date"),
    "get_cashflow": ("ticker", "freq", "curr_date"),
    "get_income_statement": ("ticker", "freq", "curr_date"),
    "get_news": ("ticker", "start_date", "end_date"),
    "get_global_news": ("curr_date", "look_back_days", "limit"),
    "get_insider_transactions": ("ticker", "curr_date"),
}


def route_to_vendor(method: str, *args, **kwargs):
    parameters = dict(zip(_PARAMETERS.get(method, ()), args))
    parameters.update({k: v for k, v in kwargs.items() if k in _PARAMETERS.get(method, ())})
    if method == "get_global_news":
        config = get_config()
        for name, key in (
            ("look_back_days", "global_news_lookback_days"),
            ("limit", "global_news_article_limit"),
        ):
            if parameters.get(name) is None:
                parameters[name] = config[key]
    elif method == "get_news":
        parameters["limit"] = get_config()["news_article_limit"]
    elif method in {"get_balance_sheet", "get_cashflow", "get_income_statement"}:
        parameters.setdefault("freq", "quarterly")
    return capture_evidence(method, parameters, lambda: _route_to_vendor(method, *args, **kwargs))


def _attempt_status(result):
    if isinstance(result, str):
        text = result.lower()
        if "withheld" in text:
            return "withheld"
        if "unavailable" in text or "not directly available" in text:
            return "unavailable"
        if not text.strip() or text.startswith(("no ", "<no ")):
            return "empty"
    return "available"


def _route_to_vendor(method: str, *args, **kwargs):
    """Try exactly the configured vendor chain, retaining each failure's meaning."""
    category = get_category_for_method(method)
    if method not in VENDOR_METHODS:
        raise ValueError(f"Method '{method}' not supported")
    available = VENDOR_METHODS[method]
    configured = [v.strip() for v in get_vendor(category, method).split(",") if v.strip()]
    if not configured or configured == ["default"]:
        chain = list(available)
    else:
        unknown = [v for v in configured if v not in available]
        if unknown:
            raise ValueError(
                f"Configured vendor(s) {unknown} not available for '{method}'. "
                f"Available: {list(available)}."
            )
        chain = list(dict.fromkeys(configured))

    last_no_data = None
    last_unavailable = None
    not_configured = None
    failed = None
    for vendor in chain:
        impl = available[vendor]
        impl = impl[0] if isinstance(impl, list) else impl
        started = time.monotonic()
        before_attempts = attempt_count()

        def record_attempt(status):
            if attempt_count() == before_attempts:
                observe_attempt(vendor, status, (time.monotonic() - started) * 1000)

        try:
            result = impl(*args, **kwargs)
            record_attempt(_attempt_status(result))
            return result
        except VendorNotConfiguredError as exc:
            record_attempt("not_configured")
            logger.warning("Vendor %s not configured for %s; trying next vendor", vendor, method)
            not_configured = exc
        except (VendorUnavailableError, YFRateLimitError) as exc:
            record_attempt("unavailable")
            logger.warning("Vendor %s unavailable for %s", vendor, method)
            last_unavailable = exc
        except NoMarketDataError as exc:
            record_attempt("empty")
            last_no_data = exc
        except Exception as exc:
            record_attempt("unavailable")
            logger.warning("Vendor %s failed for %s", vendor, method)
            failed = exc

    if last_unavailable is not None or failed is not None:
        return vendor_unavailable(method, last_unavailable or failed)
    if last_no_data is not None:
        return no_data_available(last_no_data)
    if not_configured is not None:
        return vendor_unavailable(method, not_configured)
    raise RuntimeError(f"No available vendor for '{method}'")
