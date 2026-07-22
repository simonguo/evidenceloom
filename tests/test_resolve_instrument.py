import importlib.util
from pathlib import Path
from unittest.mock import patch


def load_resolver():
    path = Path(__file__).resolve().parents[1] / "frontend" / "server" / "resolve_instrument.py"
    spec = importlib.util.spec_from_file_location("frontend_resolve_instrument", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


resolver = load_resolver()


def test_common_chinese_name_alias_resolves_to_yahoo_symbol():
    result = resolver.resolve({"query": "每日互动"})

    assert result["ticker"] == "300766.SZ"
    assert result["displayName"] == "每日互动"
    assert result["assetType"] == "stock"


def test_ai_candidate_can_fallback_when_metadata_lookup_unavailable():
    with (
        patch.object(resolver, "search_eastmoney_a_share", return_value=[]),
        patch.object(resolver, "search_yahoo", return_value=[]),
        patch.object(resolver, "llm_candidates", return_value=["300766.SZ"]),
        patch.object(resolver, "quote_from_yfinance", return_value=None),
    ):
        result = resolver.resolve({"query": "浙江数据智能公司", "quickThinkLlm": "mock-model"})

    assert result["ticker"] == "300766.SZ"
    assert result["confidence"] == 0.72
    assert result["reason"].startswith("AI suggested")
