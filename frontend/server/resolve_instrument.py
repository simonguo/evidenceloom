#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse
import urllib.request
from typing import Any, Dict, List

import yfinance as yf
from langchain_core.messages import HumanMessage, SystemMessage

from tradingagents.dataflows.symbol_utils import normalize_symbol
from tradingagents.llm_clients.base_client import normalize_utf8_text
from tradingagents.llm_clients.factory import create_llm_client

CRYPTO_BASES = {"BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BCH", "DOT", "AVAX", "LINK"}
TICKER_PATTERN = re.compile(r"^[A-Za-z0-9._\-\^=]{1,16}$")
EASTMONEY_SUGGEST_URL = "https://searchapi.eastmoney.com/api/suggest/get"
COMMON_NAME_ALIASES = {
    "tesla": ("TSLA", "Tesla, Inc."),
    "特斯拉": ("TSLA", "Tesla, Inc."),
    "apple": ("AAPL", "Apple Inc."),
    "苹果": ("AAPL", "Apple Inc."),
    "nvidia": ("NVDA", "NVIDIA Corporation"),
    "英伟达": ("NVDA", "NVIDIA Corporation"),
    "microsoft": ("MSFT", "Microsoft Corporation"),
    "微软": ("MSFT", "Microsoft Corporation"),
    "amazon": ("AMZN", "Amazon.com, Inc."),
    "亚马逊": ("AMZN", "Amazon.com, Inc."),
    "catl": ("300750.SZ", "Contemporary Amperex Technology Co., Limited"),
    "宁德时代": ("300750.SZ", "Contemporary Amperex Technology Co., Limited"),
    "byd": ("002594.SZ", "BYD Company Limited"),
    "比亚迪": ("002594.SZ", "BYD Company Limited"),
    "比亚迪股份": ("1211.HK", "BYD Company Limited"),
    "聚和材料": ("688503.SS", "聚和材料"),
    "岩山科技": ("002195.SZ", "岩山科技"),
    "二三四五": ("002195.SZ", "岩山科技"),
    "每日互动": ("300766.SZ", "每日互动"),
    "贵州茅台": ("600519.SS", "Kweichow Moutai Co., Ltd."),
    "茅台": ("600519.SS", "Kweichow Moutai Co., Ltd."),
}


def emit(value: Dict[str, Any]) -> None:
    serialized = json.dumps(value, ensure_ascii=False, default=str)
    print(normalize_utf8_text(serialized), flush=True)


def normalize_query_ticker(query: str) -> str:
    value = query.strip().upper()
    if re.fullmatch(r"\d{6}", value):
        if value.startswith(("6", "9")):
            return f"{value}.SS"
        if value.startswith(("0", "3")):
            return f"{value}.SZ"
        if value.startswith(("4", "8")):
            return f"{value}.BJ"
    if value in CRYPTO_BASES:
        return f"{value}-USD"
    return normalize_symbol(value)


def is_ticker_like(query: str) -> bool:
    value = query.strip()
    if not value:
        return False
    if re.fullmatch(r"\d{6}", value):
        return True
    if value.upper() in CRYPTO_BASES:
        return True
    if bool(TICKER_PATTERN.fullmatch(value)) and any(ch.isdigit() or ch in ".-^=" for ch in value):
        return True
    return value == value.upper() and bool(re.fullmatch(r"[A-Z]{1,8}", value))


def clean(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return "" if text.lower() in {"none", "nan", "null", "n/a"} else text


def asset_type_for(ticker: str, quote_type: str = "") -> str:
    ticker_upper = ticker.upper()
    if ticker_upper.endswith(("-USD", "-USDT", "-USDC", "-BTC", "-ETH")):
        return "crypto"
    if quote_type.upper() in {"CRYPTOCURRENCY", "CRYPTO"}:
        return "crypto"
    return "stock"


def quote_from_yfinance(
    ticker: str, query: str, reason: str, confidence: float
) -> Dict[str, Any] | None:
    try:
        info = yf.Ticker(ticker).info or {}
    except Exception:
        info = {}

    name = (
        clean(info.get("longName"))
        or clean(info.get("shortName"))
        or clean(info.get("displayName"))
    )
    quote_type = clean(info.get("quoteType"))
    exchange = clean(info.get("exchange"))
    market = clean(info.get("market"))
    currency = clean(info.get("currency"))
    if not name and not quote_type and not exchange:
        try:
            hist = yf.Ticker(ticker).history(period="5d")
            if hist is None or hist.empty:
                return None
        except Exception:
            return None
    if not name:
        name = ticker
    if currency and market:
        market = f"{market} / {currency}"
    return {
        "query": query,
        "ticker": ticker.upper(),
        "displayName": name,
        "assetType": asset_type_for(ticker, quote_type),
        "quoteType": quote_type,
        "exchange": exchange,
        "market": market,
        "confidence": confidence,
        "reason": reason,
        "alternatives": [],
    }


def fallback_quote(
    ticker: str, query: str, reason: str, confidence: float = 0.68
) -> Dict[str, Any]:
    alias = COMMON_NAME_ALIASES.get(query.strip().lower())
    display_name = alias[1] if alias and alias[0].upper() == ticker.upper() else ticker.upper()
    return {
        "query": query,
        "ticker": ticker.upper(),
        "displayName": display_name,
        "assetType": asset_type_for(ticker),
        "quoteType": "CRYPTOCURRENCY" if asset_type_for(ticker) == "crypto" else "",
        "exchange": "",
        "market": "",
        "confidence": confidence,
        "reason": reason,
        "alternatives": [],
    }


def search_yahoo(query: str) -> List[Dict[str, Any]]:
    url = "https://query1.finance.yahoo.com/v1/finance/search?" + urllib.parse.urlencode(
        {
            "q": query,
            "quotesCount": "6",
            "newsCount": "0",
        }
    )
    request = urllib.request.Request(url, headers={"User-Agent": "EvidenceLoom/0.1"})
    with urllib.request.urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))

    results = []
    for item in payload.get("quotes", []):
        symbol = clean(item.get("symbol"))
        if not symbol:
            continue
        quote_type = clean(item.get("quoteType"))
        name = clean(item.get("longname")) or clean(item.get("shortname")) or symbol
        results.append(
            {
                "ticker": symbol.upper(),
                "displayName": name,
                "assetType": asset_type_for(symbol, quote_type),
                "quoteType": quote_type,
                "exchange": clean(item.get("exchDisp")) or clean(item.get("exchange")),
                "market": clean(item.get("typeDisp")),
                "confidence": 0.86,
                "reason": "Yahoo Finance search matched this instrument.",
            }
        )
    return results


def eastmoney_suffix(item: Dict[str, Any]) -> str:
    quote_id = clean(item.get("QuoteID"))
    market = quote_id.split(".", 1)[0] if "." in quote_id else clean(item.get("MktNum"))
    if market == "1":
        return ".SS"
    if market == "0":
        return ".SZ"
    return ".SS" if clean(item.get("Code")).startswith(("5", "6", "9")) else ".SZ"


def search_eastmoney_a_share(query: str) -> List[Dict[str, Any]]:
    if not re.search(r"[\u4e00-\u9fff]", query):
        return []
    url = (
        EASTMONEY_SUGGEST_URL
        + "?"
        + urllib.parse.urlencode(
            {
                "input": query,
                "type": "14",
                "count": "6",
            }
        )
    )
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=8) as response:
        payload = json.loads(response.read().decode("utf-8"))

    rows = (payload.get("QuotationCodeTable") or {}).get("Data") or []
    results = []
    for item in rows:
        code = clean(item.get("Code"))
        name = clean(item.get("Name"))
        if not re.fullmatch(r"\d{6}", code):
            continue
        ticker = f"{code}{eastmoney_suffix(item)}"
        results.append(
            {
                "ticker": ticker,
                "displayName": name or ticker,
                "assetType": "stock",
                "quoteType": clean(item.get("SecurityTypeName")) or "EQUITY",
                "exchange": "Shanghai" if ticker.endswith(".SS") else "Shenzhen",
                "market": clean(item.get("SecurityTypeName")) or "A-share",
                "confidence": 0.9,
                "reason": "Eastmoney A-share search matched this company name.",
            }
        )
    return results


def llm_candidates(query: str, payload: Dict[str, Any]) -> List[str]:
    provider = (
        str(
            payload.get("llmProvider")
            or os.environ.get("EVIDENCELOOM_LLM_PROVIDER")
            or os.environ.get("TRADINGAGENTS_LLM_PROVIDER")
            or "openai"
        )
        .strip()
        .lower()
    )
    model = str(payload.get("quickThinkLlm") or payload.get("deepThinkLlm") or "").strip()
    if not model:
        return []

    llm = create_llm_client(
        provider,
        model,
        payload.get("backendUrl") or None,
    ).get_llm()
    response = llm.invoke(
        [
            SystemMessage(
                content=(
                    "You resolve user-entered company names, ETF names, crypto names, or tickers "
                    "to Yahoo Finance compatible symbols. Support Chinese A-share and Hong Kong "
                    "company names, US company names, numeric stock codes, ETF names, and crypto "
                    "asset names. For mainland China A-shares use .SS for Shanghai listings and "
                    ".SZ for Shenzhen listings, for Hong Kong use .HK, for crypto use BASE-USD. "
                    "Return only compact JSON with a `candidates` array of up to 5 strings. "
                    "Do not include explanations."
                )
            ),
            HumanMessage(
                content=(
                    "Resolve this instrument query to Yahoo Finance ticker candidates. "
                    f"Query: {query!r}"
                )
            ),
        ]
    )
    content = response.content if isinstance(response.content, str) else str(response.content)
    start = content.find("{")
    end = content.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return []
    parsed = json.loads(content[start : end + 1])
    candidates = parsed.get("candidates", [])
    return [normalize_query_ticker(str(item)) for item in candidates if str(item).strip()]


def fallback_from_ai_candidate(candidate: str, query: str) -> Dict[str, Any] | None:
    ticker = normalize_query_ticker(candidate)
    if not is_ticker_like(ticker):
        return None
    return fallback_quote(
        ticker,
        query,
        "AI suggested this Yahoo Finance symbol, but metadata lookup was unavailable.",
        0.72,
    )


def with_alternatives(
    primary: Dict[str, Any], alternatives: List[Dict[str, Any]]
) -> Dict[str, Any]:
    primary["alternatives"] = [
        {
            "ticker": item["ticker"],
            "displayName": item["displayName"],
            "assetType": item["assetType"],
            "quoteType": item.get("quoteType", ""),
            "exchange": item.get("exchange", ""),
            "market": item.get("market", ""),
            "confidence": item.get("confidence", 0.5),
            "reason": item.get("reason", ""),
        }
        for item in alternatives
        if item["ticker"] != primary["ticker"]
    ][:4]
    return primary


def resolve(payload: Dict[str, Any]) -> Dict[str, Any]:
    query = str(payload.get("query") or "").strip()
    if not query:
        raise ValueError("请输入公司名称、股票代码或币种。")

    direct_ticker = ""
    if is_ticker_like(query):
        ticker = normalize_query_ticker(query)
        direct_ticker = ticker.upper()
        direct = quote_from_yfinance(
            ticker, query, "Input looked like a ticker and was verified with Yahoo Finance.", 0.94
        )
        if direct:
            return direct

    alias = COMMON_NAME_ALIASES.get(query.strip().lower())
    if alias:
        ticker, _name = alias
        return fallback_quote(
            ticker, query, "Common company name matched a known Yahoo Finance symbol.", 0.86
        )

    eastmoney_results: List[Dict[str, Any]] = []
    try:
        eastmoney_results = search_eastmoney_a_share(query)
    except Exception:
        eastmoney_results = []
    if eastmoney_results:
        primary = {**eastmoney_results[0], "query": query, "alternatives": []}
        return with_alternatives(primary, eastmoney_results[1:])

    yahoo_results: List[Dict[str, Any]] = []
    try:
        yahoo_results = search_yahoo(query)
    except Exception:
        yahoo_results = []
    if yahoo_results:
        if direct_ticker:
            for index, item in enumerate(yahoo_results):
                if item["ticker"].upper() == direct_ticker:
                    primary = {**item, "query": query, "alternatives": []}
                    return with_alternatives(
                        primary, yahoo_results[:index] + yahoo_results[index + 1 :]
                    )
        primary = {**yahoo_results[0], "query": query, "alternatives": []}
        return with_alternatives(primary, yahoo_results[1:])

    if direct_ticker:
        return fallback_quote(
            direct_ticker,
            query,
            "Input looked like a Yahoo Finance ticker, but metadata lookup was unavailable.",
        )

    llm_results: List[Dict[str, Any]] = []
    llm_fallbacks: List[Dict[str, Any]] = []
    llm_errors = []
    try:
        for candidate in llm_candidates(query, payload):
            resolved = quote_from_yfinance(
                candidate,
                query,
                "AI suggested this Yahoo Finance symbol and it was verified.",
                0.78,
            )
            if resolved:
                llm_results.append(resolved)
                continue
            fallback = fallback_from_ai_candidate(candidate, query)
            if fallback:
                llm_fallbacks.append(fallback)
    except Exception as exc:
        llm_errors.append(str(exc))

    if llm_results:
        return with_alternatives(llm_results[0], llm_results[1:])
    if llm_fallbacks:
        return with_alternatives(llm_fallbacks[0], llm_fallbacks[1:])

    detail = f" ({'; '.join(llm_errors[:1])})" if llm_errors else ""
    raise ValueError(f"无法识别这个标的，请补充市场或直接输入 Yahoo Finance 代码。{detail}")


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        emit(resolve(payload))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
