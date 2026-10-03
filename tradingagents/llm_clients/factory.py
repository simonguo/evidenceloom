from typing import Optional

from .base_client import BaseLLMClient


def _integer_setting(value, name: str, minimum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"{name} must be an integer >= {minimum}")
    try:
        result = int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer >= {minimum}") from exc
    if result < minimum:
        raise ValueError(f"{name} must be an integer >= {minimum}")
    return result


def build_llm_kwargs(config: dict) -> dict:
    """Translate the run's reasoning controls and resource limits to SDK kwargs."""
    kwargs = {}
    provider = str(config.get("llm_provider", "")).lower()
    controls = {
        "google": ("google_thinking_level", "thinking_level"),
        "openai": ("openai_reasoning_effort", "reasoning_effort"),
        "anthropic": ("anthropic_effort", "effort"),
    }
    if provider in controls:
        source, target = controls[provider]
        if config.get(source):
            kwargs[target] = config[source]
    temperature = config.get("temperature")
    if temperature is not None and temperature != "":
        kwargs["temperature"] = float(temperature)
    for source, target, minimum in (
        ("llm_max_retries", "max_retries", 0),
        ("max_tokens", "max_output_tokens" if provider == "google" else "max_tokens", 1),
    ):
        value = config.get(source)
        if value is not None and value != "":
            kwargs[target] = _integer_setting(value, source, minimum)
    return kwargs


# Providers that use the OpenAI-compatible chat completions API
_OPENAI_COMPATIBLE = (
    "openai",
    "xai",
    "deepseek",
    "qwen",
    "qwen-cn",
    "glm",
    "glm-cn",
    "minimax",
    "minimax-cn",
    "ollama",
    "openrouter",
)


def create_llm_client(
    provider: str,
    model: str,
    base_url: Optional[str] = None,
    **kwargs,
) -> BaseLLMClient:
    """Create an LLM client for the specified provider.

    Provider modules are imported lazily so that simply importing this
    factory (e.g. during test collection) does not pull in heavy LLM SDKs
    or fail when their API keys are absent.

    Args:
        provider: LLM provider name
        model: Model name/identifier
        base_url: Optional base URL for API endpoint
        **kwargs: Additional provider-specific arguments

    Returns:
        Configured BaseLLMClient instance

    Raises:
        ValueError: If provider is not supported
    """
    provider_lower = provider.lower()

    if provider_lower in _OPENAI_COMPATIBLE:
        from .openai_client import OpenAIClient

        return OpenAIClient(model, base_url, provider=provider_lower, **kwargs)

    if provider_lower == "anthropic":
        from .anthropic_client import AnthropicClient

        return AnthropicClient(model, base_url, **kwargs)

    if provider_lower == "google":
        from .google_client import GoogleClient

        return GoogleClient(model, base_url, **kwargs)

    if provider_lower == "azure":
        from .azure_client import AzureOpenAIClient

        return AzureOpenAIClient(model, base_url, **kwargs)

    raise ValueError(f"Unsupported LLM provider: {provider}")
