#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import time
from typing import Any, Dict

from tradingagents.llm_clients import create_llm_client


def test_connection(payload: Dict[str, Any]) -> Dict[str, Any]:
    settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else payload
    provider = str(settings.get("llmProvider") or "openai").strip().lower()
    model = str(settings.get("quickThinkLlm") or settings.get("deepThinkLlm") or "").strip()
    base_url = str(settings.get("backendUrl") or "").strip() or None
    started_at = time.perf_counter()

    if not model:
        return {
            "ok": False,
            "provider": provider,
            "model": "",
            "error": "No model configured.",
        }

    try:
        kwargs = _provider_kwargs(settings, provider)
        llm = create_llm_client(
            provider=provider,
            model=model,
            base_url=base_url,
            **kwargs,
        ).get_llm()
        response = llm.invoke(
            [
                ("system", "You are a connection test. Reply with OK only."),
                ("human", "Return OK."),
            ]
        )
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        content = getattr(response, "content", response)
        message = str(content).strip() or "OK"
        return {
            "ok": True,
            "provider": provider,
            "model": model,
            "latencyMs": elapsed_ms,
            "message": message[:200],
        }
    except Exception as exc:  # noqa: BLE001 - the UI needs the provider's concrete error
        elapsed_ms = round((time.perf_counter() - started_at) * 1000)
        return {
            "ok": False,
            "provider": provider,
            "model": model,
            "latencyMs": elapsed_ms,
            "error": str(exc),
        }


def _provider_kwargs(settings: Dict[str, Any], provider: str) -> Dict[str, Any]:
    kwargs: Dict[str, Any] = {"timeout": 30, "max_retries": 0}

    temperature = _optional_float(settings.get("temperature"))
    if temperature is not None:
        kwargs["temperature"] = temperature

    if provider == "google":
        thinking_level = str(settings.get("googleThinkingLevel") or "").strip()
        if thinking_level:
            kwargs["thinking_level"] = thinking_level
    elif provider == "openai":
        reasoning_effort = str(settings.get("openaiReasoningEffort") or "").strip()
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort
    elif provider == "anthropic":
        effort = str(settings.get("anthropicEffort") or "").strip()
        if effort:
            kwargs["effort"] = effort

    return kwargs


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def main() -> int:
    payload = json.loads(sys.stdin.read() or "{}")
    print(json.dumps(test_connection(payload), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
