"""Real SDK requests stay bounded and output-format degradation remains explicit."""

from copy import deepcopy
import json
from unittest.mock import MagicMock

import httpx
from langchain_core.exceptions import OutputParserException
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate
import pytest

from tradingagents.agents.analysts import sentiment_analyst
from tradingagents.agents.managers.portfolio_manager import create_portfolio_manager
from tradingagents.agents.managers.research_manager import create_research_manager
from tradingagents.agents.schemas import (
    PortfolioDecision,
    ResearchPlan,
    SentimentReport,
    TraderProposal,
    render_research_plan,
)
from tradingagents.agents.trader.trader import create_trader
from tradingagents.agents.utils.structured import bind_structured, invoke_agent_output
from tradingagents.graph.propagation import Propagator
from tradingagents.llm_clients.openai_client import OpenAIClient

PROMPT = "Use supplied evidence only. Do not call external tools."
PLAN = {
    "recommendation": "Hold",
    "rationale": "Evidence is balanced.",
    "strategic_actions": "Wait.",
}


def completion(content="", arguments=None, finish_reason="stop", refusal=None):
    message = {"role": "assistant", "content": content}
    if arguments is not None:
        message["tool_calls"] = [
            {
                "id": "call_offline",
                "type": "function",
                "function": {"name": "ResearchPlan", "arguments": json.dumps(arguments)},
            }
        ]
    if refusal:
        message["refusal"] = refusal
    return {
        "id": "offline-completion",
        "object": "chat.completion",
        "created": 0,
        "model": "gpt-5.4-mini",
        "choices": [{"index": 0, "finish_reason": finish_reason, "message": message}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
    }


@pytest.fixture
def gateway(monkeypatch):
    clients = []
    monkeypatch.setattr("openai._base_client.time.sleep", lambda *args: None)

    def create(responses, max_retries=0):
        requests = []

        def handle(request):
            requests.append(json.loads(request.content))
            response = responses[min(len(requests) - 1, len(responses) - 1)]
            if isinstance(response, Exception):
                raise response
            status, body = response
            return httpx.Response(
                status,
                content=json.dumps(body, ensure_ascii=True).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                request=request,
            )

        client = httpx.Client(transport=httpx.MockTransport(handle))
        clients.append(client)
        llm = OpenAIClient(
            "gpt-5.4-mini",
            provider="openai",
            base_url="https://gateway.example.invalid/v1",
            api_key="offline-placeholder",
            http_client=client,
            max_retries=max_retries,
        ).get_llm()
        return llm, requests

    yield create
    for client in clients:
        client.close()


def run(llm, render=render_research_plan):
    return invoke_agent_output(
        bind_structured(llm, ResearchPlan, "Research Manager"),
        llm,
        PROMPT,
        ResearchPlan,
        render,
        "Research Manager",
    )


def node_state():
    state = Propagator().create_initial_state("NVDA", "2026-01-05")
    state.update(investment_plan="Research plan", trader_investment_plan="Trader plan")
    return state


def test_schema_tool_output_is_validated_without_forcing_gateway_tool_choice(gateway):
    llm, requests = gateway([(200, completion(arguments=PLAN, finish_reason="tool_calls"))])
    output = run(llm)
    assert output.parsed.recommendation.value == "Hold"
    assert output.text.startswith("**Recommendation**: Hold")
    assert output.quality == {
        "status": "validated_schema",
        "schema": "ResearchPlan",
        "source": "structured",
    }
    assert len(requests) == 1
    assert "tool_choice" not in requests[0]
    assert requests[0]["tools"][0]["function"]["name"] == "ResearchPlan"
    assert "formats your answer" in requests[0]["messages"][0]["content"]


def test_successful_gateway_prose_is_reused_without_a_second_paid_request(gateway):
    prose = "**Recommendation**: Hold\n\nThe evidence remains balanced."
    llm, requests = gateway([(200, completion(content=prose))])
    output = run(llm)
    assert output.text == prose and output.parsed is None
    assert output.quality == {
        "status": "unvalidated_text",
        "schema": "ResearchPlan",
        "source": "raw_response",
        "reason": "no_tool_call",
    }
    assert len(requests) == 1


@pytest.mark.parametrize("status", [401, 403, 404, 429, 500])
def test_fatal_provider_errors_do_not_trigger_plain_generation(gateway, status):
    body = {"error": {"message": "offline failure", "code": "insufficient_quota"}}
    llm, requests = gateway([(status, body)])
    with pytest.raises(Exception) as error:
        run(llm)
    assert error.value.status_code == status
    assert len(requests) == 1


def test_exhausted_sdk_retry_budget_is_not_restarted_by_a_plain_fallback(gateway):
    llm, requests = gateway([(500, {"error": {"message": "offline failure"}})], max_retries=1)
    with pytest.raises(Exception) as error:
        run(llm)
    assert error.value.status_code == 500 and len(requests) == 2


def test_transport_failure_is_not_repeated_as_plain_generation(gateway):
    llm, requests = gateway([httpx.ConnectError("offline connection failure")])
    with pytest.raises(Exception, match="Connection error"):
        run(llm)
    assert len(requests) == 1


@pytest.mark.parametrize("parameter", ["tools", "tool_choice.name", "response_format"])
def test_known_format_protocol_errors_allow_only_one_plain_request(gateway, parameter, caplog):
    secret = "secret https://user:password@private.example/v1"
    error = {"message": secret, "param": parameter, "code": "unsupported_parameter"}
    llm, requests = gateway([(400, {"error": error}), (200, completion(content="Plan text."))])
    output = run(llm)
    assert output.quality["source"] == "plain_generation"
    assert output.quality["reason"] == "unsupported_format"
    assert len(requests) == 2 and "tools" not in requests[1]
    assert requests[1]["messages"][0]["content"] == PROMPT
    assert secret not in json.dumps(output.quality) and secret not in caplog.text


@pytest.mark.parametrize("code", ["context_length_exceeded", "invalid_api_key", None])
def test_unknown_or_nonformat_400s_do_not_trigger_a_second_request(gateway, code):
    llm, requests = gateway(
        [(400, {"error": {"message": "offline failure", "param": "tools", "code": code}})]
    )
    with pytest.raises(Exception) as error:
        run(llm)
    assert error.value.status_code == 400 and len(requests) == 1


def test_invalid_schema_with_usable_prose_reuses_text_and_hides_validation_inputs(gateway, caplog):
    secret = "https://user:password@private.example/v1"
    invalid = {**PLAN, "recommendation": secret}
    llm, requests = gateway([(200, completion(content="Prose evidence.", arguments=invalid))])
    output = run(llm)
    assert output.text == "Prose evidence." and output.parsed is None
    assert output.quality["reason"] == "schema_validation_failed"
    assert output.quality["source"] == "raw_response" and len(requests) == 1
    assert secret not in json.dumps(output.quality) and secret not in caplog.text


def test_invalid_schema_without_prose_gets_one_plain_generation(gateway):
    invalid = {**PLAN, "recommendation": "Buy or Sell"}
    llm, requests = gateway(
        [(200, completion(arguments=invalid)), (200, completion(content="Recommendation: Hold"))]
    )
    output = run(llm)
    assert output.parsed is None and output.quality["reason"] == "schema_validation_failed"
    assert output.quality["source"] == "plain_generation" and len(requests) == 2


def test_malformed_tool_json_gets_one_plain_generation(gateway):
    response = completion(arguments=PLAN)
    response["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"] = "{broken json"
    llm, requests = gateway([(200, response), (200, completion(content="Recommendation: Hold"))])
    output = run(llm)
    assert output.quality["reason"] == "schema_validation_failed"
    assert output.quality["source"] == "plain_generation" and len(requests) == 2


@pytest.mark.parametrize("error", [NotImplementedError, AttributeError])
def test_unavailable_structured_binding_uses_one_plain_generation_with_explicit_quality(error):
    llm = MagicMock()
    llm.with_structured_output.side_effect = error("Provider unavailable schema API")
    llm.invoke.return_value = AIMessage(content="Recommendation: Hold")
    output = run(llm)
    assert output.quality == {
        "status": "unvalidated_text",
        "schema": "ResearchPlan",
        "source": "plain_generation",
        "reason": "structured_unavailable",
    }
    llm.invoke.assert_called_once_with(PROMPT)


def test_rendering_failure_propagates_without_discarding_a_validated_answer(gateway):
    llm, requests = gateway([(200, completion(arguments=PLAN))])

    def broken_render(plan):
        raise RuntimeError("renderer programming failure")

    with pytest.raises(RuntimeError, match="renderer programming failure"):
        run(llm, render=broken_render)
    assert len(requests) == 1


@pytest.mark.parametrize("finish_reason", ["length", "content_filter"])
def test_truncated_or_filtered_responses_cannot_look_like_completed_research(
    gateway, finish_reason
):
    llm, requests = gateway(
        [(200, completion(content="Partial thesis.", finish_reason=finish_reason))]
    )
    with pytest.raises(ValueError, match="incomplete or filtered"):
        run(llm)
    assert len(requests) == 1


@pytest.mark.parametrize("content,refusal", [(" ", None), ("", "Provider refused.")])
def test_empty_or_refused_responses_do_not_trigger_an_unbounded_fallback(gateway, content, refusal):
    llm, requests = gateway([(200, completion(content=content, refusal=refusal))])
    with pytest.raises(ValueError, match="empty|refused"):
        run(llm)
    assert len(requests) == 1


@pytest.mark.parametrize(
    "metadata_key,stop_reason",
    [
        ("stop_reason", "refusal"),
        ("stop_reason", "pause_turn"),
        ("stop_reason", "max_tokens"),
        ("stop_reason", "model_context_window_exceeded"),
        ("finish_reason", "MAX_TOKENS"),
        ("finish_reason", "SAFETY"),
    ],
)
def test_anthropic_and_google_incomplete_metadata_override_even_a_parsed_schema(
    metadata_key, stop_reason
):
    llm = MagicMock()
    llm.with_structured_output.return_value.invoke.return_value = {
        "raw": AIMessage(content="Partial response", response_metadata={metadata_key: stop_reason}),
        "parsed": ResearchPlan(**PLAN),
        "parsing_error": None,
    }
    with pytest.raises(ValueError, match="refused|incomplete or filtered"):
        run(llm)
    llm.invoke.assert_not_called()


@pytest.mark.parametrize("structured", [False, True])
def test_malformed_unicode_is_repaired_before_reports_and_quality_are_serialized(
    gateway, structured
):
    if structured:
        response = completion(arguments={**PLAN, "rationale": "Evidence\ud800"})
    else:
        response = completion(content="Recommendation: Hold\nEvidence\ud800")
    llm, requests = gateway([(200, response)])
    output = run(llm)
    assert "\ufffd" in output.text and len(requests) == 1
    json.dumps({"text": output.text, "quality": output.quality}, ensure_ascii=False).encode("utf-8")


@pytest.mark.parametrize(
    "prompt",
    [
        PROMPT,
        [{"role": "system", "content": PROMPT}, {"role": "user", "content": "Evidence"}],
        [SystemMessage(content=PROMPT), HumanMessage(content="Evidence")],
        ChatPromptTemplate.from_messages([("system", PROMPT)]).invoke({}),
    ],
)
def test_structured_format_instruction_never_mutates_the_plain_fallback_prompt(prompt):
    original = deepcopy(prompt)
    llm = MagicMock()
    llm.with_structured_output.return_value.invoke.side_effect = OutputParserException("Bad schema")
    llm.invoke.return_value = AIMessage(content="Plain fallback")
    output = invoke_agent_output(
        bind_structured(llm, ResearchPlan, "Research Manager"),
        llm,
        prompt,
        ResearchPlan,
        render_research_plan,
        "Research Manager",
    )
    assert output.quality["reason"] == "schema_validation_failed"
    assert prompt == original and llm.invoke.call_args.args[0] == original
    assert "formats your answer" in str(llm.with_structured_output.return_value.invoke.call_args)


def test_programming_errors_in_a_structured_runnable_are_not_hidden_as_fallbacks():
    llm = MagicMock()
    llm.with_structured_output.return_value.invoke.side_effect = ValueError("programming error")
    with pytest.raises(ValueError, match="programming error"):
        run(llm)
    llm.invoke.assert_not_called()


@pytest.mark.parametrize(
    "factory,key,parsed",
    [
        (create_research_manager, "research_manager", ResearchPlan(**PLAN)),
        (create_trader, "trader", TraderProposal(action="Buy", reasoning="Evidence")),
        (
            create_portfolio_manager,
            "portfolio_manager",
            PortfolioDecision(
                rating="Underweight", executive_summary="Trim", investment_thesis="Quoted Buy case."
            ),
        ),
        (
            sentiment_analyst.create_sentiment_analyst,
            "sentiment",
            SentimentReport(
                overall_band="Neutral", overall_score=5, confidence="low", narrative="Evidence"
            ),
        ),
    ],
)
def test_each_structured_node_emits_safe_quality_and_pm_retains_typed_rating(
    monkeypatch, factory, key, parsed
):
    monkeypatch.setattr(sentiment_analyst.get_news, "func", lambda *args, **kwargs: "No news")
    monkeypatch.setattr(sentiment_analyst, "fetch_stocktwits_messages", lambda *a, **kw: "No posts")
    monkeypatch.setattr(sentiment_analyst, "fetch_reddit_posts", lambda *a, **kw: "No posts")
    llm = MagicMock()
    llm.with_structured_output.return_value.invoke.return_value = {
        "raw": AIMessage(content=""),
        "parsed": parsed,
        "parsing_error": None,
    }
    result = factory(llm)(node_state())
    assert result["output_quality"] == {
        key: {"status": "validated_schema", "schema": type(parsed).__name__, "source": "structured"}
    }
    if key == "portfolio_manager":
        assert result["final_rating"] == "Underweight"
    llm.invoke.assert_not_called()


@pytest.mark.parametrize(
    "text,rating", [("Rating: Sell", "Sell"), ("Quoted Buy thesis.", "REVIEW")]
)
def test_pm_reuses_prose_and_preserves_explicit_rating_or_review(text, rating):
    llm = MagicMock()
    llm.with_structured_output.return_value.invoke.return_value = {
        "raw": AIMessage(content=text),
        "parsed": None,
        "parsing_error": None,
    }
    result = create_portfolio_manager(llm)(node_state())
    assert result["final_rating"] == rating
    assert result["output_quality"]["portfolio_manager"]["status"] == "unvalidated_text"
    llm.invoke.assert_not_called()
