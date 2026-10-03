"""Preserve structured answers and make output-format degradation observable."""

from __future__ import annotations

from dataclasses import dataclass
from json import JSONDecodeError
import logging
from typing import Any, Callable, Generic, Mapping, Optional, TypeVar

from langchain_core.exceptions import OutputParserException
from langchain_core.messages import BaseMessage, SystemMessage
from pydantic import BaseModel, ValidationError

from tradingagents.llm_clients.base_client import normalize_content, normalize_utf8_text

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)
_PARSE_ERRORS = (OutputParserException, ValidationError, JSONDecodeError)
_FORMAT_PARAMETERS = {"tools", "tool_choice", "response_format", "json_schema"}
_FORMAT_ERROR_CODES = {
    "unsupported_parameter",
    "unsupported_value",
    "unsupported_format",
    "unknown_parameter",
    "invalid_parameter",
    "missing_required_parameter",
}

NO_EXTERNAL_TOOLS = (
    "Use only the evidence provided in this prompt. Do not call external tools "
    "or search the web; if something is missing, say so explicitly."
)


@dataclass(frozen=True)
class StructuredBinding(Generic[T]):
    runnable: Any
    schema: type[T]

    def invoke(self, prompt: Any):
        return self.runnable.invoke(prompt)


@dataclass(frozen=True)
class AgentOutput(Generic[T]):
    text: str
    parsed: Optional[T]
    quality: dict[str, str]


def portfolio_context(state: dict) -> str:
    context = state.get("portfolio_context")
    if isinstance(context, str) and context.strip():
        return context
    return (
        "Portfolio context: not provided. You do not know the caller's current "
        "holdings or cash, so do not assume a flat book. Give direction and sizing "
        "guidance the caller can apply to their own position."
    )


def _format_compatibility_error(exc: Exception) -> bool:
    """Only recognized format-parameter 400s warrant another generation."""
    if getattr(exc, "status_code", None) != 400:
        return False
    body = getattr(exc, "body", None)
    if not isinstance(body, Mapping):
        return False
    error = body.get("error", body)
    if not isinstance(error, Mapping):
        return False
    parameter = str(error.get("param") or "").split(".", 1)[0]
    return parameter in _FORMAT_PARAMETERS and error.get("code") in _FORMAT_ERROR_CODES


def _structured_prompt(prompt: Any, schema: type[BaseModel]) -> Any:
    instruction = (
        f"Return your final answer using the {schema.__name__} output schema. "
        "If a schema tool is supplied, call it once to format the final answer. "
        "This schema tool only formats your answer; it does not retrieve external data. "
        "Do not call any other tools or search the web."
    )
    if isinstance(prompt, str):
        return prompt + "\n\n" + instruction
    if hasattr(prompt, "to_messages"):
        prompt = prompt.to_messages()
    if not isinstance(prompt, (list, tuple)):
        raise TypeError("structured prompt must be text or a message sequence")
    messages = list(prompt)
    if messages and isinstance(messages[0], dict):
        first = messages[0]
        if first.get("role") in ("system", "developer") and isinstance(first.get("content"), str):
            messages[0] = {**first, "content": first["content"] + "\n\n" + instruction}
        else:
            messages.insert(0, {"role": "system", "content": instruction})
    elif (
        messages and isinstance(messages[0], SystemMessage) and isinstance(messages[0].content, str)
    ):
        messages[0] = messages[0].model_copy(
            update={"content": messages[0].content + "\n\n" + instruction}
        )
    else:
        messages.insert(0, SystemMessage(content=instruction))
    return messages


def _response_text(response: Any) -> str:
    if response is None:
        return ""
    content = getattr(response, "content", None)
    if isinstance(response, BaseMessage):
        content = normalize_content(response).content
    return normalize_utf8_text(content) if isinstance(content, str) else ""


def _require_complete_response(response: Any, agent_name: str) -> None:
    additional = getattr(response, "additional_kwargs", None)
    if isinstance(additional, dict) and additional.get("refusal"):
        raise ValueError(f"{agent_name}: provider refused to produce an answer")
    metadata = getattr(response, "response_metadata", None)
    if not isinstance(metadata, dict):
        return
    reason = str(metadata.get("finish_reason") or metadata.get("stop_reason") or "")
    reason = reason.lower().rsplit(".", 1)[-1]
    if reason == "refusal":
        raise ValueError(f"{agent_name}: provider refused to produce an answer")
    if reason in (
        "length",
        "max_tokens",
        "content_filter",
        "safety",
        "recitation",
        "pause_turn",
        "model_context_window_exceeded",
    ):
        raise ValueError(f"{agent_name}: provider returned an incomplete or filtered answer")


def _quality(schema: type[BaseModel], source: str, reason: str | None = None) -> dict[str, str]:
    record = {
        "status": "validated_schema" if source == "structured" else "unvalidated_text",
        "schema": schema.__name__,
        "source": source,
    }
    if reason:
        record["reason"] = reason
    return record


def _plain_output(plain_llm, prompt, schema, agent_name, reason) -> AgentOutput:
    response = plain_llm.invoke(prompt)
    _require_complete_response(response, agent_name)
    text = _response_text(response)
    if not text.strip():
        raise ValueError(f"{agent_name}: provider returned an empty answer")
    logger.warning("%s: output format degraded (%s)", agent_name, reason)
    return AgentOutput(text, None, _quality(schema, "plain_generation", reason))


def bind_structured(llm: Any, schema: type[T], agent_name: str) -> Optional[StructuredBinding[T]]:
    """Keep the raw HTTP-success response alongside parsing and validation."""
    try:
        return StructuredBinding(llm.with_structured_output(schema, include_raw=True), schema)
    except (NotImplementedError, AttributeError):
        logger.warning("%s: output schema unavailable; using plain generation", agent_name)
        return None


def invoke_agent_output(
    structured_llm: Optional[Any],
    plain_llm: Any,
    prompt: Any,
    schema: type[T],
    render: Callable[[T], str],
    agent_name: str,
) -> AgentOutput[T]:
    """Validate once, reuse usable prose, and never retry an exhausted API failure.

    A format-specific 400 or a malformed schema with no reusable text permits
    one plain generation. Authentication, quota, transport, other protocol errors
    and programming errors propagate; SDK retries remain the provider's budget.
    """
    if structured_llm is None:
        return _plain_output(plain_llm, prompt, schema, agent_name, "structured_unavailable")
    try:
        result = structured_llm.invoke(_structured_prompt(prompt, schema))
    except _PARSE_ERRORS:
        return _plain_output(plain_llm, prompt, schema, agent_name, "schema_validation_failed")
    except Exception as exc:
        if _format_compatibility_error(exc):
            return _plain_output(plain_llm, prompt, schema, agent_name, "unsupported_format")
        raise

    raw, parsed, parsing_error = None, result, None
    if isinstance(result, Mapping) and "raw" in result:
        raw, parsed, parsing_error = (
            result.get("raw"),
            result.get("parsed"),
            result.get("parsing_error"),
        )
    _require_complete_response(raw, agent_name)
    if parsed is not None:
        try:
            parsed = schema.model_validate(
                parsed.model_dump() if isinstance(parsed, BaseModel) else parsed
            )
        except ValidationError as exc:
            parsed, parsing_error = None, exc
        else:
            # A renderer bug is a programming failure, not a reason to pay for
            # another answer or silently discard the validated decision.
            text = normalize_utf8_text(render(parsed))
            if not text.strip():
                raise ValueError(f"{agent_name}: schema renderer returned an empty answer")
            return AgentOutput(text, parsed, _quality(schema, "structured"))

    invalid_calls = getattr(raw, "invalid_tool_calls", None)
    schema_failed = parsing_error is not None or bool(
        isinstance(invalid_calls, list) and invalid_calls
    )
    reason = "schema_validation_failed" if schema_failed else "no_tool_call"
    text = _response_text(raw)
    if text.strip():
        logger.warning("%s: output format degraded (%s)", agent_name, reason)
        return AgentOutput(text, None, _quality(schema, "raw_response", reason))
    if schema_failed:
        return _plain_output(plain_llm, prompt, schema, agent_name, reason)
    raise ValueError(f"{agent_name}: provider returned an empty answer")


def invoke_structured(structured_llm: Optional[Any], prompt: Any, agent_name: str) -> Optional[T]:
    """Compatibility helper for callers that only need the parsed object."""
    if structured_llm is None:
        return None
    try:
        result = structured_llm.invoke(prompt)
    except _PARSE_ERRORS:
        return None
    except Exception as exc:
        if _format_compatibility_error(exc):
            return None
        raise
    if isinstance(result, Mapping) and "raw" in result:
        _require_complete_response(result.get("raw"), agent_name)
        result = result.get("parsed")
    return result if isinstance(result, BaseModel) else None


def invoke_structured_or_freetext(
    structured_llm: Optional[Any],
    plain_llm: Any,
    prompt: Any,
    render: Callable[[T], str],
    agent_name: str,
) -> str:
    """Retain the legacy string API for callers using ``bind_structured``."""
    if isinstance(structured_llm, StructuredBinding):
        return invoke_agent_output(
            structured_llm, plain_llm, prompt, structured_llm.schema, render, agent_name
        ).text
    result = invoke_structured(structured_llm, prompt, agent_name)
    if result is not None:
        return normalize_utf8_text(render(result))
    response = plain_llm.invoke(prompt)
    _require_complete_response(response, agent_name)
    return _response_text(response)
