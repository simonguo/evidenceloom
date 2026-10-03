import functools
import logging
from typing import Any, Mapping, Optional

import yfinance as yf
from langchain_core.messages import HumanMessage, RemoveMessage
from tradingagents.dataflows.symbol_utils import normalize_symbol

# Import tools from separate utility files
from tradingagents.agents.utils.core_stock_tools import get_stock_data
from tradingagents.agents.utils.fundamental_data_tools import (
    get_balance_sheet,
    get_cashflow,
    get_fundamentals,
    get_income_statement,
)
from tradingagents.agents.utils.market_data_validation_tools import (
    get_verified_market_snapshot,
)
from tradingagents.agents.utils.news_data_tools import (
    get_global_news,
    get_insider_transactions,
    get_news,
)
from tradingagents.agents.utils.technical_indicators_tools import get_indicators

__all__ = [
    "build_instrument_context",
    "create_msg_delete",
    "get_balance_sheet",
    "get_cashflow",
    "get_fundamentals",
    "get_global_news",
    "get_indicators",
    "get_insider_transactions",
    "get_income_statement",
    "get_instrument_context_from_state",
    "get_language_instruction",
    "get_news",
    "get_stock_data",
    "get_verified_market_snapshot",
    "resolve_instrument_identity",
    "report_or_unavailable",
]

logger = logging.getLogger(__name__)


def get_language_instruction() -> str:
    """Return a prompt instruction for the configured output language.

    Returns empty string when English (default), so no extra tokens are used.
    Applied to every agent whose output reaches the saved report —
    analysts, researchers, debaters, research manager, trader, and
    portfolio manager — so a non-English run produces a fully localized
    report rather than a mix of languages.
    """
    from tradingagents.dataflows.config import get_config

    lang = get_config().get("output_language", "English")
    if lang.strip().lower() == "english":
        return ""
    return (
        f" Write your response in {lang}, while keeping the labelled lines "
        "Rating: X, Recommendation: X and Action: X in English, including their "
        "canonical rating values Buy / Overweight / Hold / Underweight / Sell."
    )


def _clean_identity_value(value: Any) -> Optional[str]:
    """Return a trimmed string, or None for empty / placeholder-ish values."""
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned or cleaned.lower() in {"none", "n/a", "nan", "null"}:
        return None
    return cleaned


@functools.lru_cache(maxsize=256)
def _cached_instrument_identity(ticker: str) -> dict:
    """Resolve deterministic identity metadata (company name, sector, …) for a ticker.

    This exists to stop the pipeline from hallucinating a *different* company
    when a chart pattern suggests a different industry than the real one
    (#814): without a ground-truth name, the market analyst would pattern-match
    the price action to a narrative and invent an identity that then cascaded
    through every downstream agent.

    Best-effort by design: if yfinance is unavailable, rate-limited, or doesn't
    recognise the ticker, we return ``{}`` and the caller falls back to
    ticker-only context rather than failing before analysis starts. Cached so
    the lookup happens at most once per ticker per process.
    """
    # Exceptions and empty responses are deliberately not cached; a transient
    # outage must not remove identity information for the rest of the process.
    info = yf.Ticker(ticker).info or {}

    identity: dict[str, str] = {}
    company_name = _clean_identity_value(info.get("longName")) or _clean_identity_value(
        info.get("shortName")
    )
    if company_name:
        identity["company_name"] = company_name
    for source_key, target_key in (
        ("sector", "sector"),
        ("industry", "industry"),
        ("exchange", "exchange"),
        ("quoteType", "quote_type"),
    ):
        value = _clean_identity_value(info.get(source_key))
        if value:
            identity[target_key] = value
    if not identity:
        raise ValueError("identity lookup returned no metadata")
    return identity


def resolve_instrument_identity(ticker: str) -> dict:
    """Resolve and cache successful identity lookups, retrying failed lookups later."""
    try:
        return dict(_cached_instrument_identity(normalize_symbol(ticker)))
    except Exception as exc:  # noqa: BLE001 - identification must fail open
        logger.debug("Could not resolve instrument identity for %s: %s", ticker, exc)
        return {}


# Preserve the public cache controls used by embedded callers and tests.
resolve_instrument_identity.cache_clear = _cached_instrument_identity.cache_clear
resolve_instrument_identity.cache_info = _cached_instrument_identity.cache_info


def build_instrument_context(
    ticker: str,
    asset_type: str = "stock",
    identity: Optional[Mapping[str, str]] = None,
    trade_date: Optional[str] = None,
) -> str:
    """Describe the exact instrument so agents preserve identity and ticker.

    When ``identity`` is provided (resolved deterministically via
    :func:`resolve_instrument_identity`), the company name and business
    classification are injected so agents anchor to the real company rather
    than pattern-matching the price chart to a wrong one (#814).
    """
    is_crypto = asset_type == "crypto"
    instrument_label = "asset" if is_crypto else "instrument"
    context = (
        f"The {instrument_label} to analyze is `{ticker}`. "
        "Use this exact ticker in every tool call, report, and recommendation, "
        "preserving any exchange suffix (e.g. `.TO`, `.L`, `.HK`, `.T`, `-USD`)."
    )

    details = []
    from tradingagents.dataflows.utils import get_current_date

    historical = trade_date is not None and str(trade_date) < get_current_date()
    if identity:
        name = identity.get("company_name") or identity.get("name")
        if name:
            details.append(f"{'Name' if is_crypto else 'Company'}: {name}")
        sector = identity.get("sector") if not historical else None
        industry = identity.get("industry") if not historical else None
        if sector and industry:
            details.append(f"Business classification: {sector} / {industry}")
        elif sector:
            details.append(f"Sector: {sector}")
        elif industry:
            details.append(f"Industry: {industry}")
        if not historical and identity.get("exchange"):
            details.append(f"Exchange: {identity['exchange']}")

    if details:
        context += (
            f" Resolved identity: {'; '.join(details)}. "
            "Do not substitute a different company or ticker unless a tool "
            "result explicitly disproves this resolved identity."
        )
        if historical:
            context += (
                " This is the company's current name, supplied only as an identifier; "
                "it is not evidence of its name, business or listing on the analysis date."
            )

    if is_crypto:
        context += (
            " Treat it as a crypto asset rather than a company, and do not "
            "assume company fundamentals are available."
        )
    return context


def get_instrument_context_from_state(state: Mapping[str, Any]) -> str:
    """Return the instrument context for the current run.

    Prefers the identity-resolved context computed once at run start and
    stored on the state (see ``TradingAgentsGraph.resolve_instrument_context``).
    Falls back to a ticker-only context — with no network lookup — when the
    state was constructed without it (bare programmatic states, tests), so a
    consumer is never forced to make a yfinance call mid-graph.
    """
    context = state.get("instrument_context")
    if isinstance(context, str) and context.strip():
        return context
    return build_instrument_context(
        str(state["company_of_interest"]),
        state.get("asset_type", "stock"),
        trade_date=state.get("trade_date"),
    )


def report_or_unavailable(report: Any, label: str = "This report") -> str:
    """Make a missing analyst's evidence explicit to downstream agents."""
    return report if isinstance(report, str) and report.strip() else f"{label} was not produced."


def create_msg_delete():
    def delete_messages(state):
        """Clear messages and add a context-anchored placeholder.

        The placeholder must not be a bare ``"Continue"``: some
        OpenAI-compatible providers interpret that literally as the user task
        and produce output about the word "continue" instead of analysing the
        instrument (#888). Anchoring it to the resolved instrument context and
        date keeps the next analyst on-task even if the provider treats the
        placeholder as a standalone request.
        """
        messages = state["messages"]
        removal_operations = [RemoveMessage(id=m.id) for m in messages]

        instrument_context = get_instrument_context_from_state(state)
        trade_date = state.get("trade_date", "the requested date")
        placeholder = HumanMessage(
            content=(
                f"Proceed with your assigned analysis for this workflow. "
                f"{instrument_context} The analysis date is {trade_date}."
            )
        )
        return {"messages": removal_operations + [placeholder]}

    return delete_messages
