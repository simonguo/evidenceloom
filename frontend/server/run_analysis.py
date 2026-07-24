#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import time
import traceback
from datetime import datetime
from typing import Any, Dict, Iterable, List

from cli.main import (
    ANALYST_ORDER,
    MessageBuffer,
    classify_message_type,
    update_analyst_statuses,
)
from cli.stats_handler import StatsCallbackHandler
from cli.utils import detect_asset_type, normalize_ticker_symbol
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph.analyst_execution import (
    AnalystWallTimeTracker,
    build_analyst_execution_plan,
    get_initial_analyst_node,
)
from tradingagents.graph.checkpointer import clear_checkpoint, thread_id
from tradingagents.graph.trading_graph import TradingAgentsGraph

REPORT_SECTION_KEYS = [
    "market_report",
    "sentiment_report",
    "news_report",
    "fundamentals_report",
    "investment_plan",
    "trader_investment_plan",
    "final_trade_decision",
]


def emit(event: Dict[str, Any]) -> None:
    event.setdefault("timestamp", datetime.now().strftime("%H:%M:%S"))
    print(json.dumps(event, ensure_ascii=False, default=str), flush=True)


def normalize_analysts(raw: Iterable[str], asset_type: str) -> List[str]:
    selected = {str(item).lower() for item in raw}
    analysts = [analyst for analyst in ANALYST_ORDER if analyst in selected]
    if asset_type == "crypto":
        analysts = [analyst for analyst in analysts if analyst != "fundamentals"]
    if not analysts:
        raise ValueError("at least one valid analyst must be selected")
    return analysts


def build_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    config = DEFAULT_CONFIG.copy()
    research_depth = int(payload.get("researchDepth") or 1)
    config["max_debate_rounds"] = _positive_int(payload.get("maxDebateRounds"), research_depth)
    config["max_risk_discuss_rounds"] = _positive_int(payload.get("maxRiskRounds"), research_depth)
    config["analyst_concurrency_limit"] = _positive_int(
        payload.get("analystConcurrencyLimit"), config.get("analyst_concurrency_limit", 1)
    )
    config["news_article_limit"] = _positive_int(
        payload.get("newsArticleLimit"), config.get("news_article_limit", 20)
    )
    config["global_news_article_limit"] = _positive_int(
        payload.get("globalNewsArticleLimit"), config.get("global_news_article_limit", 10)
    )
    config["global_news_lookback_days"] = _positive_int(
        payload.get("globalNewsLookbackDays"), config.get("global_news_lookback_days", 7)
    )
    config["checkpoint_enabled"] = bool(payload.get("checkpointEnabled", False))

    optional_mapping = {
        "llmProvider": "llm_provider",
        "backendUrl": "backend_url",
        "quickThinkLlm": "quick_think_llm",
        "deepThinkLlm": "deep_think_llm",
        "outputLanguage": "output_language",
        "openaiReasoningEffort": "openai_reasoning_effort",
        "googleThinkingLevel": "google_thinking_level",
        "anthropicEffort": "anthropic_effort",
        "benchmarkTicker": "benchmark_ticker",
    }
    for payload_key, config_key in optional_mapping.items():
        value = payload.get(payload_key)
        if isinstance(value, str) and value.strip():
            config[config_key] = value.strip()

    temperature = _optional_float(payload.get("temperature"))
    if temperature is not None:
        config["temperature"] = temperature

    config["data_vendors"] = {
        **config.get("data_vendors", {}),
        "core_stock_apis": str(
            payload.get("coreStockApis") or config["data_vendors"]["core_stock_apis"]
        ).strip(),
        "technical_indicators": str(
            payload.get("technicalIndicators") or config["data_vendors"]["technical_indicators"]
        ).strip(),
        "fundamental_data": str(
            payload.get("fundamentalData") or config["data_vendors"]["fundamental_data"]
        ).strip(),
        "news_data": str(payload.get("newsData") or config["data_vendors"]["news_data"]).strip(),
    }

    return config


def _positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return int(fallback)
    return parsed if parsed > 0 else int(fallback)


def _optional_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def current_stats(stats_handler: StatsCallbackHandler, started_at: float) -> Dict[str, Any]:
    stats = stats_handler.get_stats()
    return {
        "llmCalls": stats["llm_calls"],
        "toolCalls": stats["tool_calls"],
        "tokensIn": stats["tokens_in"],
        "tokensOut": stats["tokens_out"],
        "elapsedSeconds": round(time.time() - started_at, 1),
    }


def status_snapshot(buffer: MessageBuffer) -> Dict[str, str]:
    return dict(buffer.agent_status)


def report_snapshot(buffer: MessageBuffer) -> Dict[str, Any]:
    return dict(buffer.report_sections)


def current_agent(buffer: MessageBuffer) -> str:
    for agent, status in buffer.agent_status.items():
        if status == "in_progress":
            return agent
    return buffer.current_agent or ""


def infer_chunk_agent(buffer: MessageBuffer, chunk: Dict[str, Any]) -> str:
    report_agents = {
        "market_report": "Market Analyst",
        "sentiment_report": "Sentiment Analyst",
        "news_report": "News Analyst",
        "fundamentals_report": "Fundamentals Analyst",
        "trader_investment_plan": "Trader",
    }
    for key, agent in report_agents.items():
        if chunk.get(key):
            return agent

    debate_state = chunk.get("investment_debate_state") or {}
    if debate_state.get("judge_decision"):
        return "Research Manager"
    current_response = str(debate_state.get("current_response") or "")
    if current_response.startswith("Bull Analyst:"):
        return "Bull Researcher"
    if current_response.startswith("Bear Analyst:"):
        return "Bear Researcher"

    risk_state = chunk.get("risk_debate_state") or {}
    if risk_state.get("judge_decision"):
        return "Portfolio Manager"
    risk_current = [
        ("current_aggressive_response", "Aggressive Analyst"),
        ("current_conservative_response", "Conservative Analyst"),
        ("current_neutral_response", "Neutral Analyst"),
    ]
    for key, agent in risk_current:
        if str(risk_state.get(key) or "").strip():
            return agent

    return current_agent(buffer)


def emit_progress(
    buffer: MessageBuffer,
    stats_handler: StatsCallbackHandler,
    started_at: float,
    message: str | None = None,
) -> None:
    event = {
        "type": "progress",
        "agentStatuses": status_snapshot(buffer),
        "reportSections": report_snapshot(buffer),
        "stats": current_stats(stats_handler, started_at),
    }
    if message:
        event["message"] = message
        event["messageType"] = "System"
        agent = current_agent(buffer)
        if agent:
            event["agent"] = agent
    emit(event)


def resolve_pending_entries_safely(
    graph: TradingAgentsGraph,
    ticker: str,
    buffer: MessageBuffer,
    stats_handler: StatsCallbackHandler,
    started_at: float,
) -> None:
    try:
        graph._resolve_pending_entries(ticker)
    except Exception as exc:  # noqa: BLE001 - historical refresh must not block a new run
        emit(
            {
                "type": "message",
                "messageType": "System",
                "message": f"Skipped historical outcome refresh: {exc}",
                "agentStatuses": status_snapshot(buffer),
                "reportSections": report_snapshot(buffer),
                "stats": current_stats(stats_handler, started_at),
            }
        )


def update_reports_from_chunk(buffer: MessageBuffer, chunk: Dict[str, Any]) -> None:
    if chunk.get("investment_debate_state"):
        debate_state = chunk["investment_debate_state"]
        bull_hist = debate_state.get("bull_history", "").strip()
        bear_hist = debate_state.get("bear_history", "").strip()
        judge = debate_state.get("judge_decision", "").strip()

        if bull_hist or bear_hist:
            for agent in ["Bull Researcher", "Bear Researcher", "Research Manager"]:
                buffer.update_agent_status(agent, "in_progress")
        if bull_hist:
            buffer.update_report_section(
                "investment_plan", f"### Bull Researcher Analysis\n{bull_hist}"
            )
        if bear_hist:
            buffer.update_report_section(
                "investment_plan", f"### Bear Researcher Analysis\n{bear_hist}"
            )
        if judge:
            buffer.update_report_section(
                "investment_plan", f"### Research Manager Decision\n{judge}"
            )
            for agent in ["Bull Researcher", "Bear Researcher", "Research Manager"]:
                buffer.update_agent_status(agent, "completed")
            buffer.update_agent_status("Trader", "in_progress")

    if chunk.get("trader_investment_plan"):
        buffer.update_report_section("trader_investment_plan", chunk["trader_investment_plan"])
        buffer.update_agent_status("Trader", "completed")
        buffer.update_agent_status("Aggressive Analyst", "in_progress")

    if chunk.get("risk_debate_state"):
        risk_state = chunk["risk_debate_state"]
        risk_updates = [
            ("aggressive_history", "Aggressive Analyst", "### Aggressive Analyst Analysis"),
            ("conservative_history", "Conservative Analyst", "### Conservative Analyst Analysis"),
            ("neutral_history", "Neutral Analyst", "### Neutral Analyst Analysis"),
        ]
        for state_key, agent, heading in risk_updates:
            history = risk_state.get(state_key, "").strip()
            if history:
                if buffer.agent_status.get(agent) != "completed":
                    buffer.update_agent_status(agent, "in_progress")
                buffer.update_report_section("final_trade_decision", f"{heading}\n{history}")

        judge = risk_state.get("judge_decision", "").strip()
        if judge:
            buffer.update_agent_status("Portfolio Manager", "in_progress")
            buffer.update_report_section(
                "final_trade_decision", f"### Portfolio Manager Decision\n{judge}"
            )
            for agent in [
                "Aggressive Analyst",
                "Conservative Analyst",
                "Neutral Analyst",
                "Portfolio Manager",
            ]:
                buffer.update_agent_status(agent, "completed")


def compact_final_state(final_state: Dict[str, Any]) -> Dict[str, Any]:
    return {key: final_state.get(key) for key in REPORT_SECTION_KEYS if key in final_state}


def run_post_completion_tasks(
    graph: TradingAgentsGraph,
    config: Dict[str, Any],
    ticker: str,
    analysis_date: str,
    final_state: Dict[str, Any],
    buffer: MessageBuffer,
    stats_handler: StatsCallbackHandler,
    started_at: float,
) -> None:
    warnings: List[str] = []

    def record_warning(label: str, exc: Exception) -> None:
        warnings.append(f"{label}: {exc}")
        print(f"TradingAgents post-run warning: {label}: {exc}", file=sys.stderr, flush=True)

    try:
        graph._log_state(analysis_date, final_state)
    except Exception as exc:  # noqa: BLE001 - result persistence must not change run outcome
        record_warning("failed to write state log", exc)

    try:
        graph.memory_log.store_decision(
            ticker=ticker,
            trade_date=analysis_date,
            final_trade_decision=str(final_state.get("final_trade_decision") or ""),
        )
    except Exception as exc:  # noqa: BLE001 - memory persistence is best-effort after completion
        record_warning("failed to store memory decision", exc)

    if config.get("checkpoint_enabled"):
        try:
            clear_checkpoint(config["data_cache_dir"], ticker, analysis_date)
        except Exception as exc:  # noqa: BLE001 - checkpoint cleanup should not mark analysis failed
            record_warning("failed to clear checkpoint", exc)

    if warnings:
        emit(
            {
                "type": "message",
                "messageType": "System",
                "message": "Analysis completed, but some post-run cleanup was skipped: "
                + "; ".join(warnings),
                "agentStatuses": status_snapshot(buffer),
                "reportSections": report_snapshot(buffer),
                "stats": current_stats(stats_handler, started_at),
            }
        )


def run(payload: Dict[str, Any]) -> None:
    ticker = normalize_ticker_symbol(str(payload.get("ticker") or "SPY"))
    asset_type = str(payload.get("assetType") or detect_asset_type(ticker).value)
    analysis_date = str(payload.get("analysisDate") or datetime.now().strftime("%Y-%m-%d"))
    selected_analysts = normalize_analysts(payload.get("analysts") or ANALYST_ORDER, asset_type)
    config = build_config(payload)

    stats_handler = StatsCallbackHandler()
    analyst_execution_plan = build_analyst_execution_plan(
        selected_analysts,
        concurrency_limit=config["analyst_concurrency_limit"],
    )
    analyst_wall_time_tracker = AnalystWallTimeTracker(analyst_execution_plan)

    graph = TradingAgentsGraph(
        selected_analysts,
        config=config,
        debug=False,
        callbacks=[stats_handler],
    )

    buffer = MessageBuffer()
    buffer.init_for_analysis(selected_analysts)
    started_at = time.time()

    emit(
        {
            "type": "started",
            "message": f"Started analysis for {ticker} on {analysis_date}",
            "messageType": "System",
            "agentStatuses": status_snapshot(buffer),
            "reportSections": report_snapshot(buffer),
            "stats": current_stats(stats_handler, started_at),
        }
    )

    first_analyst = get_initial_analyst_node(analyst_execution_plan)
    buffer.update_agent_status(first_analyst, "in_progress")
    analyst_wall_time_tracker.mark_started(selected_analysts[0])
    emit_progress(buffer, stats_handler, started_at, f"Running {first_analyst}")

    graph.ticker = ticker
    resolve_pending_entries_safely(graph, ticker, buffer, stats_handler, started_at)

    if config.get("checkpoint_enabled"):
        from tradingagents.graph.checkpointer import get_checkpointer

        graph._checkpointer_ctx = get_checkpointer(config["data_cache_dir"], ticker)
        saver = graph._checkpointer_ctx.__enter__()
        graph.graph = graph.workflow.compile(checkpointer=saver)

    try:
        instrument_context = graph.resolve_instrument_context(ticker, asset_type)
        init_agent_state = graph.propagator.create_initial_state(
            ticker,
            analysis_date,
            asset_type=asset_type,
            past_context=graph.memory_log.get_past_context(ticker),
            instrument_context=instrument_context,
        )
        args = graph.propagator.get_graph_args(callbacks=[stats_handler])
        if config.get("checkpoint_enabled"):
            args.setdefault("config", {}).setdefault("configurable", {})["thread_id"] = thread_id(
                ticker, analysis_date
            )

        trace: List[Dict[str, Any]] = []
        processed_message_ids = set()

        for chunk in graph.graph.stream(init_agent_state, **args):
            chunk_agent = infer_chunk_agent(buffer, chunk)
            for message in chunk.get("messages", []):
                message_id = getattr(message, "id", None)
                if message_id is not None:
                    if message_id in processed_message_ids:
                        continue
                    processed_message_ids.add(message_id)

                message_type, content = classify_message_type(message)
                if content and content.strip():
                    emit(
                        {
                            "type": "message",
                            "messageType": message_type,
                            "message": content.strip(),
                            "agent": chunk_agent,
                        }
                    )

                if hasattr(message, "tool_calls") and message.tool_calls:
                    for tool_call in message.tool_calls:
                        if isinstance(tool_call, dict):
                            tool_name = tool_call.get("name", "tool")
                        else:
                            tool_name = getattr(tool_call, "name", "tool")
                        emit(
                            {
                                "type": "message",
                                "messageType": "Tool",
                                "message": f"{tool_name} called",
                                "agent": chunk_agent,
                            }
                        )

            update_analyst_statuses(buffer, chunk, wall_time_tracker=analyst_wall_time_tracker)
            update_reports_from_chunk(buffer, chunk)
            emit_progress(buffer, stats_handler, started_at)
            trace.append(chunk)

        final_state: Dict[str, Any] = {}
        for chunk in trace:
            final_state.update(chunk)

        graph.curr_state = final_state
        decision = graph.process_signal(final_state["final_trade_decision"])
        for agent in list(buffer.agent_status.keys()):
            buffer.update_agent_status(agent, "completed")
        for section in list(buffer.report_sections.keys()):
            if section in final_state:
                buffer.update_report_section(section, final_state[section])

        emit(
            {
                "type": "completed",
                "message": analyst_wall_time_tracker.format_summary(),
                "messageType": "System",
                "agentStatuses": status_snapshot(buffer),
                "reportSections": report_snapshot(buffer),
                "stats": current_stats(stats_handler, started_at),
                "decision": decision,
                "finalState": compact_final_state(final_state),
            }
        )
        run_post_completion_tasks(
            graph, config, ticker, analysis_date, final_state, buffer, stats_handler, started_at
        )
    finally:
        if graph._checkpointer_ctx is not None:
            graph._checkpointer_ctx.__exit__(None, None, None)
            graph._checkpointer_ctx = None
            graph.graph = graph.workflow.compile()


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
        if payload.get("__command") == "smoke_test":
            emit({"type": "ready"})
            return 0
        if payload.get("__command") == "resolve_instrument":
            from resolve_instrument import resolve

            emit(resolve(payload))
            return 0
        if payload.get("__command") == "load_ohlcv_chart":
            from load_ohlcv_chart import load_chart

            symbol = str(payload.get("symbol") or "")
            curr_date = str(payload.get("currDate") or payload.get("curr_date") or "")
            print(
                json.dumps(load_chart(symbol, curr_date), ensure_ascii=False, allow_nan=False),
                flush=True,
            )
            return 0
        if payload.get("__command") == "test_llm":
            from test_llm import test_connection

            print(
                json.dumps(test_connection(payload), ensure_ascii=False, allow_nan=False),
                flush=True,
            )
            return 0
        run(payload)
        return 0
    except Exception as exc:  # noqa: BLE001 - bridge must surface any backend failure to UI
        print(f"Evidence Loom runner error: {exc}", file=sys.stderr, flush=True)
        emit(
            {
                "type": "error",
                "error": str(exc),
                "message": traceback.format_exc(limit=8),
                "messageType": "Error",
            }
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
