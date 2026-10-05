"""Count real SDK wire attempts using an offline HTTP transport."""

import asyncio
import json

import httpx
import pytest
from openai import (
    APIConnectionError,
    APITimeoutError,
    AuthenticationError,
    InternalServerError,
    PermissionDeniedError,
    RateLimitError,
)

from tradingagents.agents.schemas import ResearchPlan, render_research_plan
from tradingagents.agents.utils.structured import bind_structured, invoke_agent_output
from tradingagents.llm_clients.openai_client import OpenAIClient

pytestmark = pytest.mark.unit
_DEFAULT = object()
_GATEWAY = "https://offline.example.invalid/v1"


def _failure_response(request, failure):
    if failure == "connection":
        raise httpx.ConnectError("offline connection failure", request=request)
    if failure == "timeout":
        raise httpx.ReadTimeout("offline timeout", request=request)
    status, code = {
        "server": (500, "server_error"),
        "rate_limit": (429, "rate_limit_exceeded"),
        "quota": (429, "insufficient_quota"),
        "auth": (401, "invalid_api_key"),
        "permission": (403, "permission_denied"),
    }[failure]
    return httpx.Response(
        status,
        json={"error": {"message": "offline failure", "code": code}},
        request=request,
    )


def _completion():
    return {
        "id": "offline-completion",
        "object": "chat.completion",
        "created": 0,
        "model": "gpt-5.4-mini",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "Recommendation: Hold"},
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def _llm(sync_client, async_client, retries=_DEFAULT, base_url=_GATEWAY):
    kwargs = {} if retries is _DEFAULT else {"max_retries": retries}
    return OpenAIClient(
        "gpt-5.4-mini",
        provider="openai",
        base_url=base_url,
        api_key="offline-placeholder",
        http_client=sync_client,
        http_async_client=async_client,
        **kwargs,
    ).get_llm()


def _invoke(llm, path):
    if path == "plain":
        return llm.invoke("Offline evidence only.")
    return invoke_agent_output(
        bind_structured(llm, ResearchPlan, "Research Manager"),
        llm,
        "Offline evidence only.",
        ResearchPlan,
        render_research_plan,
        "Research Manager",
    )


@pytest.fixture
def wire_gateway(monkeypatch):
    # Remove waiting, not retry logic. Every counted request still travels
    # through ChatOpenAI, the OpenAI SDK and httpx.MockTransport.
    monkeypatch.setattr("openai._base_client.time.sleep", lambda *args: None)

    async def no_wait(*args):
        pass

    monkeypatch.setattr("openai._base_client.anyio.sleep", no_wait)
    sync_clients, async_clients = [], []

    def create(
        failure, retries=_DEFAULT, *, no_retry_header=False, succeeds_at=None, base_url=_GATEWAY
    ):
        requests = []

        def handle(request):
            requests.append({"path": request.url.path, "body": json.loads(request.content)})
            if succeeds_at is not None and len(requests) == succeeds_at:
                return httpx.Response(200, json=_completion(), request=request)
            response = _failure_response(request, failure)
            if no_retry_header:
                response.headers["x-should-retry"] = "false"
            return response

        sync = httpx.Client(transport=httpx.MockTransport(handle))
        async_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
        sync_clients.append(sync)
        async_clients.append(async_client)
        return _llm(sync, async_client, retries, base_url), requests

    yield create
    for client in sync_clients:
        client.close()

    async def close_async_clients():
        for client in async_clients:
            await client.aclose()

    asyncio.run(close_async_clients())


@pytest.mark.parametrize("path", ["plain", "structured"])
@pytest.mark.parametrize(
    "failure,error",
    [
        ("server", InternalServerError),
        ("rate_limit", RateLimitError),
        ("quota", RateLimitError),
        ("connection", APIConnectionError),
        ("timeout", APITimeoutError),
    ],
)
def test_default_sdk_budget_has_three_wire_attempts_and_no_plain_restart(
    wire_gateway, path, failure, error
):
    llm, requests = wire_gateway(failure)
    with pytest.raises(error):
        _invoke(llm, path)
    # SDK retry classification is status based: quota 429s consume the same
    # default budget as transient 429s. They are not guaranteed to fail fast.
    assert len(requests) == 3
    assert all(("tools" in request["body"]) == (path == "structured") for request in requests)


@pytest.mark.parametrize("path", ["plain", "structured"])
@pytest.mark.parametrize(
    "failure,error", [("server", InternalServerError), ("quota", RateLimitError)]
)
@pytest.mark.parametrize("retries,wire_attempts", [(0, 1), (1, 2)])
def test_explicit_sdk_budget_is_the_entire_request_budget(
    wire_gateway, path, failure, error, retries, wire_attempts
):
    llm, requests = wire_gateway(failure, retries)
    with pytest.raises(error):
        _invoke(llm, path)
    assert len(requests) == wire_attempts
    assert all(("tools" in request["body"]) == (path == "structured") for request in requests)


@pytest.mark.parametrize("path", ["plain", "structured"])
@pytest.mark.parametrize(
    "failure,error", [("auth", AuthenticationError), ("permission", PermissionDeniedError)]
)
def test_auth_and_permission_failures_do_not_retry_or_generate_plain_text(
    wire_gateway, path, failure, error
):
    llm, requests = wire_gateway(failure)
    with pytest.raises(error):
        _invoke(llm, path)
    assert len(requests) == 1


@pytest.mark.parametrize("path", ["plain", "structured"])
def test_sdk_no_retry_header_is_respected_without_an_outer_restart(wire_gateway, path):
    llm, requests = wire_gateway("server", no_retry_header=True)
    with pytest.raises(InternalServerError):
        _invoke(llm, path)
    assert len(requests) == 1


@pytest.mark.parametrize("path", ["plain", "structured"])
def test_recovery_stops_before_spending_the_rest_of_the_budget(wire_gateway, path):
    llm, requests = wire_gateway("server", succeeds_at=2)
    result = _invoke(llm, path)
    assert len(requests) == 2
    assert (result.content if path == "plain" else result.text) == "Recommendation: Hold"


@pytest.mark.parametrize(
    "failure,error", [("server", InternalServerError), ("quota", RateLimitError)]
)
def test_native_responses_api_uses_the_same_default_budget(wire_gateway, failure, error):
    llm, requests = wire_gateway(failure, base_url="https://api.openai.com/v1")
    assert llm.use_responses_api is True
    with pytest.raises(error):
        llm.invoke("Offline evidence only.")
    assert len(requests) == 3 and all(request["path"] == "/v1/responses" for request in requests)


@pytest.mark.parametrize(
    "failure,retries,error,wire_attempts",
    [
        ("server", _DEFAULT, InternalServerError, 3),
        ("quota", _DEFAULT, RateLimitError, 3),
        ("connection", _DEFAULT, APIConnectionError, 3),
        ("auth", _DEFAULT, AuthenticationError, 1),
        ("server", 0, InternalServerError, 1),
        ("server", 1, InternalServerError, 2),
    ],
)
def test_async_plain_calls_obey_the_same_sdk_wire_budget(
    wire_gateway, failure, retries, error, wire_attempts
):
    llm, requests = wire_gateway(failure, retries)
    with pytest.raises(error):
        asyncio.run(llm.ainvoke("Offline evidence only."))
    assert len(requests) == wire_attempts


def test_legacy_outer_retry_environment_cannot_multiply_sdk_attempts(wire_gateway, monkeypatch):
    monkeypatch.setenv("TRADINGAGENTS_LLM_RETRY_ATTEMPTS", "100")
    monkeypatch.setenv("TRADINGAGENTS_LLM_RETRY_BASE_DELAY", "invalid")
    llm, requests = wire_gateway("server")
    with pytest.raises(InternalServerError):
        llm.invoke("Offline evidence only.")
    assert len(requests) == 3
