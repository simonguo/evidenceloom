"""Check three decision agents with fictional inputs and a real model provider.

This is an opt-in format/transport check, not an evaluation of research accuracy.
Credentials use the provider's normal environment variable. Responses, private
endpoints and exception messages are omitted from the JSON result. For example:

    uv run python scripts/smoke_structured_output.py openai --json
    uv run python scripts/smoke_structured_output.py openai --base-url https://gateway.example/v1 --json

Default limits: 1800 output tokens per generation, no SDK retries, 45s timeout.
Known format failures may permit one text generation per agent. A usable raw
response is reused. Text fallback fails this smoke unless explicitly allowed.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
import logging
import os
import sys
import time

from tradingagents.agents.managers.portfolio_manager import create_portfolio_manager
from tradingagents.agents.managers.research_manager import create_research_manager
from tradingagents.agents.trader.trader import create_trader
from tradingagents.agents.utils.output_quality import sanitize_output_quality
from tradingagents.dataflows.config import run_config
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.propagation import Propagator
from tradingagents.llm_clients import create_llm_client

PROVIDER_DEFAULTS = {
    "openai": "gpt-5.4-mini",
    "google": "gemini-2.5-flash",
    "anthropic": "claude-sonnet-4-6",
    "deepseek": "deepseek-chat",
    "qwen": "qwen-plus",
    "glm": "glm-5",
    "xai": "grok-4",
}


def make_synthetic_state():
    state = Propagator().create_initial_state("SYNTHETIC", "2026-10-02")
    state["instrument_context"] = (
        "Fictional synthetic company. No real security or live market data. "
        "All supplied numbers are invented test fixtures."
    )
    state["portfolio_context"] = "Synthetic flat portfolio. Do not invent data."
    state["investment_debate_state"].update(
        history=(
            "Bull: fictional recurring revenue grew 8%, cash covers liabilities. "
            "Bear: fictional margin fell 2 points and evidence is limited. "
            "A balanced synthetic scenario, no external evidence."
        ),
        count=2,
    )
    state["market_report"] = (
        "Synthetic price 100 USD, entry 99 USD, stop 95 USD. "
        "Fictional stable trend. No real market evidence."
    )
    state["risk_debate_state"].update(
        history=(
            "Synthetic scenario only: aggressive favors a small position, "
            "conservative cites incomplete evidence, neutral favors waiting."
        ),
        count=3,
    )
    return state


def evaluate_agents(deep_llm, quick_llm):
    state = make_synthetic_state()
    records = []
    nodes = (
        ("research_manager", create_research_manager, deep_llm, "investment_plan"),
        ("trader", create_trader, quick_llm, "trader_investment_plan"),
        ("portfolio_manager", create_portfolio_manager, deep_llm, "final_trade_decision"),
    )
    for agent, factory, llm, report_key in nodes:
        started = time.monotonic()
        try:
            result = factory(llm)(state)
            quality = sanitize_output_quality(result.get("output_quality")).get(agent)
            nonempty = bool(result.get(report_key, "").strip())
            record = {
                "agent": agent,
                "ok": nonempty,
                "seconds": round(time.monotonic() - started, 3),
                "quality": quality,
            }
            if agent == "portfolio_manager":
                record["rating_readable"] = result.get("final_rating") not in (None, "REVIEW")
                record["ok"] = nonempty and record["rating_readable"]
            state.update(result)
            records.append(record)
        except Exception as exc:
            # Exception messages may contain credentials or private endpoints.
            status = getattr(exc, "status_code", None)
            records.append(
                {
                    "agent": agent,
                    "ok": False,
                    "error": "provider_or_output_failure",
                    "http_status": status if isinstance(status, int) else None,
                }
            )
            break
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("provider", choices=list(PROVIDER_DEFAULTS))
    parser.add_argument("--deep-model", help="Override deep model")
    parser.add_argument("--quick-model", help="Override quick model")
    parser.add_argument("--base-url", help="Custom provider endpoint; omitted from the result")
    parser.add_argument("--max-tokens", type=int, default=1800)
    parser.add_argument("--max-retries", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--language", choices=["zh", "en"], default="zh")
    parser.add_argument("--allow-text-fallback", action="store_true")
    parser.add_argument("--json", action="store_true", help="Print a machine-readable summary")
    args = parser.parse_args()
    if args.max_tokens < 1 or args.max_retries < 0 or args.timeout <= 0:
        parser.error("Token/timeout limits must be positive; retries must be non-negative")

    # Keep this synthetic diagnostic out of any configured external tracing.
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    previous_log_level = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    models = {
        "deep": args.deep_model or PROVIDER_DEFAULTS[args.provider],
        "quick": args.quick_model or PROVIDER_DEFAULTS[args.provider],
    }
    config = deepcopy(DEFAULT_CONFIG)
    config["output_language"] = args.language
    from tradingagents.llm_clients.factory import build_llm_kwargs

    kwargs = build_llm_kwargs(
        {
            "llm_provider": args.provider,
            "max_tokens": args.max_tokens,
            "llm_max_retries": args.max_retries,
        }
    )
    kwargs["timeout"] = args.timeout
    try:
        deep_llm = create_llm_client(
            args.provider, models["deep"], args.base_url, **kwargs
        ).get_llm()
        quick_llm = create_llm_client(
            args.provider, models["quick"], args.base_url, **kwargs
        ).get_llm()
        with run_config(config):
            records = evaluate_agents(deep_llm, quick_llm)
    except Exception:
        records = [{"ok": False, "error": "client_configuration_failure"}]
    finally:
        logging.disable(previous_log_level)
    passed = len(records) == 3 and all(record.get("ok") for record in records)
    if not args.allow_text_fallback:
        passed = passed and all(
            (record.get("quality") or {}).get("status") == "validated_schema" for record in records
        )
    result = {
        "case": "synthetic-balanced-v1",
        "synthetic": True,
        "evaluates_research_accuracy": False,
        "provider": args.provider,
        "models": models,
        "limits": {
            "max_tokens": args.max_tokens,
            "sdk_retries": args.max_retries,
            "timeout_seconds": args.timeout,
        },
        "allow_text_fallback": args.allow_text_fallback,
        "passed": passed,
        "records": records,
    }
    print(json.dumps(result, ensure_ascii=False, indent=None if args.json else 2))
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
