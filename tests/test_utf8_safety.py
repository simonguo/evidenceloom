import io
import json
from contextlib import redirect_stdout

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage

from frontend.server.run_analysis import emit
from tradingagents.llm_clients.base_client import (
    normalize_content,
    normalize_utf8_payload,
    normalize_utf8_text,
)
from tradingagents.llm_clients.openai_client import DeepSeekChatOpenAI


@pytest.mark.unit
def test_normalize_utf8_text_repairs_only_malformed_surrogates():
    value = "中文🙂 pair:\ud83d\ude00 low:\udcad high:\ud800"

    normalized = normalize_utf8_text(value)

    assert normalized == "中文🙂 pair:😀 low:� high:�"
    assert normalized.encode("utf-8").decode("utf-8") == normalized


@pytest.mark.unit
def test_normalize_utf8_payload_repairs_nested_json_values_and_keys():
    payload = {
        "outer\udcad": ["ok", {"nested": "bad\ud800"}],
        "tuple": ("pair\ud83d\ude00",),
    }

    normalized = normalize_utf8_payload(payload)

    assert normalized == {
        "outer�": ["ok", {"nested": "bad�"}],
        "tuple": ("pair😀",),
    }
    json.dumps(normalized, ensure_ascii=False).encode("utf-8")


@pytest.mark.unit
def test_normalize_content_repairs_provider_text_before_graph_state():
    response = AIMessage(
        content="answer\udcad",
        additional_kwargs={"reasoning_content": "reason\ud800"},
    )

    normalized = normalize_content(response)

    assert normalized.content == "answer�"
    assert normalized.additional_kwargs["reasoning_content"] == "reason�"


@pytest.mark.unit
def test_deepseek_request_replaces_surrogates_before_sdk_utf8_encoding():
    requests = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content.decode("utf-8")))
        response_payload = {
            "id": "chatcmpl-test",
            "object": "chat.completion",
            "created": 1,
            "model": "deepseek-chat",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "ok",
                        "reasoning_content": "server reasoning\udcad",
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }
        return httpx.Response(
            200,
            content=json.dumps(response_payload).encode("utf-8"),
            headers={"content-type": "application/json"},
        )

    http_client = httpx.Client(transport=httpx.MockTransport(handle))
    client = DeepSeekChatOpenAI(
        model="deepseek-chat",
        api_key="placeholder",
        base_url="https://api.deepseek.test",
        http_client=http_client,
    )
    prior = AIMessage(
        content="previous",
        additional_kwargs={"reasoning_content": "reason\udcad"},
    )

    response = client.invoke(
        [prior, HumanMessage(content="中文🙂 pair \ud83d\ude00 malformed \udcad")]
    )
    http_client.close()

    assert response.content == "ok"
    assert response.additional_kwargs["reasoning_content"] == "server reasoning�"
    assert len(requests) == 1
    assert requests[0]["messages"][0]["reasoning_content"] == "reason�"
    assert requests[0]["messages"][1]["content"] == "中文🙂 pair 😀 malformed �"


@pytest.mark.unit
def test_runner_emit_writes_strict_utf8_for_malformed_event_text():
    raw_output = io.BytesIO()
    strict_stdout = io.TextIOWrapper(raw_output, encoding="utf-8", errors="strict")

    with redirect_stdout(strict_stdout):
        emit({"type": "message", "message": "market data\udcad"})
    strict_stdout.flush()

    event = json.loads(raw_output.getvalue().decode("utf-8"))
    assert event["message"] == "market data�"
