import warnings
from abc import ABC, abstractmethod
from typing import Any, Optional


def normalize_utf8_text(value: str) -> str:
    """Return text that can be encoded as strict UTF-8.

    Python strings can contain isolated UTF-16 surrogate code points when an
    upstream API returns malformed escaped Unicode.  UTF-8 encoders reject
    those code points.  Preserve valid surrogate pairs by combining them into
    their Unicode scalar value and replace only malformed surrogates with the
    standard replacement character.
    """
    if not any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        return value

    normalized = []
    index = 0
    while index < len(value):
        codepoint = ord(value[index])
        if 0xD800 <= codepoint <= 0xDBFF and index + 1 < len(value):
            low = ord(value[index + 1])
            if 0xDC00 <= low <= 0xDFFF:
                normalized.append(chr(0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00)))
                index += 2
                continue
        if 0xD800 <= codepoint <= 0xDFFF:
            normalized.append("\ufffd")
        else:
            normalized.append(value[index])
        index += 1

    return "".join(normalized)


def normalize_utf8_payload(value: Any) -> Any:
    """Recursively make JSON-like payload strings safe for UTF-8 encoding."""
    if isinstance(value, str):
        return normalize_utf8_text(value)
    if isinstance(value, dict):
        return {
            normalize_utf8_payload(key): normalize_utf8_payload(item) for key, item in value.items()
        }
    if isinstance(value, list):
        return [normalize_utf8_payload(item) for item in value]
    if isinstance(value, tuple):
        return tuple(normalize_utf8_payload(item) for item in value)
    return value


def normalize_content(response):
    """Normalize LLM response content to valid-Unicode plain text.

    Multiple providers (OpenAI Responses API, Google Gemini 3) return content
    as a list of typed blocks, e.g. [{'type': 'reasoning', ...}, {'type': 'text', 'text': '...'}].
    Downstream agents expect response.content to be a string. This extracts
    and joins the text blocks, discarding reasoning/metadata blocks. It also
    repairs malformed surrogate code points in provider text and metadata
    before they enter graph state or persistence.
    """
    content = response.content
    if isinstance(content, list):
        texts = [
            item.get("text", "")
            if isinstance(item, dict) and item.get("type") == "text"
            else item
            if isinstance(item, str)
            else ""
            for item in content
        ]
        response.content = "\n".join(t for t in texts if t)
    if isinstance(response.content, str):
        response.content = normalize_utf8_text(response.content)
    if isinstance(getattr(response, "additional_kwargs", None), dict):
        response.additional_kwargs = normalize_utf8_payload(response.additional_kwargs)
    return response


class BaseLLMClient(ABC):
    """Abstract base class for LLM clients."""

    def __init__(self, model: str, base_url: Optional[str] = None, **kwargs):
        self.model = model
        self.base_url = base_url
        self.kwargs = kwargs

    def get_provider_name(self) -> str:
        """Return the provider name used in warning messages."""
        provider = getattr(self, "provider", None)
        if provider:
            return str(provider)
        return self.__class__.__name__.removesuffix("Client").lower()

    def warn_if_unknown_model(self) -> None:
        """Warn when the model is outside the known list for the provider."""
        if self.validate_model():
            return

        warnings.warn(
            (
                f"Model '{self.model}' is not in the known model list for "
                f"provider '{self.get_provider_name()}'. Continuing anyway."
            ),
            RuntimeWarning,
            stacklevel=2,
        )

    @abstractmethod
    def get_llm(self) -> Any:
        """Return the configured LLM instance."""
        pass

    @abstractmethod
    def validate_model(self) -> bool:
        """Validate that the model is supported by this client."""
        pass
