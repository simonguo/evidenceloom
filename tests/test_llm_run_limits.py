"""Provider wire selection and per-run resource budgets, without network calls."""

from unittest.mock import patch

import httpx
import pytest
from openai import APIConnectionError

from tradingagents.llm_clients.capabilities import get_capabilities
from tradingagents.llm_clients.factory import build_llm_kwargs, create_llm_client
from tradingagents.llm_clients.openai_client import (
    LocalCompatibleChatOpenAI,
    NormalizedChatOpenAI,
    OpenAIClient,
)


@pytest.mark.parametrize("endpoint", ["http://localhost:1234/v1", "https://proxy.example/v1"])
def test_custom_endpoint_uses_chat_completions_without_forced_tool_choice(endpoint):
    llm = OpenAIClient("gpt-5.5", base_url=endpoint, provider="openai").get_llm()
    assert llm.use_responses_api is False
    assert isinstance(llm, LocalCompatibleChatOpenAI)
    with patch.object(NormalizedChatOpenAI, "with_structured_output") as bind:
        llm.with_structured_output({"title": "Decision", "type": "object"})
    assert bind.call_args.kwargs["tool_choice"] is None


def test_sdk_environment_endpoint_is_respected(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "http://localhost:1234/v1")
    llm = OpenAIClient("gpt-5.5", provider="openai").get_llm()
    assert llm.use_responses_api is False


def test_native_openai_uses_responses_api():
    assert OpenAIClient("gpt-5.5", provider="openai").get_llm().use_responses_api is True


@pytest.mark.parametrize(
    "provider,model,token_key",
    [
        ("openai", "gpt-5.5", "max_tokens"),
        ("google", "gemini-3-flash-preview", "max_output_tokens"),
        ("anthropic", "claude-sonnet-4-6", "max_tokens"),
        ("azure", "my-deployment", "max_tokens"),
    ],
)
def test_run_budget_reaches_provider(provider, model, token_key, monkeypatch):
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://offline.openai.azure.com")
    monkeypatch.setenv("OPENAI_API_VERSION", "2024-10-21")
    kwargs = build_llm_kwargs(
        {"llm_provider": provider, "max_tokens": "1024", "llm_max_retries": "0"}
    )
    assert kwargs == {token_key: 1024, "max_retries": 0}
    llm = create_llm_client(provider, model, **kwargs).get_llm()
    assert getattr(llm, token_key) == 1024
    assert llm.max_retries == 0


@pytest.mark.parametrize("setting", ["max_tokens", "llm_max_retries"])
@pytest.mark.parametrize("value", [True, 1.5, "bad", -1])
def test_invalid_budgets_fail_before_start(setting, value):
    with pytest.raises(ValueError, match=setting):
        build_llm_kwargs({setting: value})


def test_explicit_zero_sdk_retries_does_not_add_outer_attempts():
    llm = OpenAIClient("gpt-5.5", max_retries=0).get_llm()
    error = APIConnectionError(request=httpx.Request("POST", "https://offline.example"))
    with patch("langchain_openai.ChatOpenAI.invoke", side_effect=error) as invoke:
        with pytest.raises(APIConnectionError):
            llm.invoke("offline")
    assert invoke.call_count == 1


def test_reasoning_capabilities_apply_to_openrouter_namespace():
    assert get_capabilities("deepseek/deepseek-flash").supports_tool_choice is False
    assert get_capabilities("deepseek/deepseek-v4-pro").requires_reasoning_content_roundtrip


@pytest.mark.parametrize("provider", ["openai", "google"])
def test_run_manifest_records_numeric_effective_environment_limits(provider):
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    graph = object.__new__(TradingAgentsGraph)
    graph.config = {"llm_provider": provider, "max_tokens": "1024", "temperature": "0.2"}
    graph.selected_analysts = ("market",)
    settings = graph.run_settings()
    assert settings["max_tokens"] == 1024
    assert settings["temperature"] == 0.2
