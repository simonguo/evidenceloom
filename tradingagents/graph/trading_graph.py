# TradingAgents/graph/trading_graph.py

import hashlib
import logging
from contextlib import contextmanager
from copy import deepcopy
import os
from pathlib import Path
import json
from datetime import datetime
from typing import Dict, Any, Tuple, List, Optional

import yfinance as yf  # noqa: F401 - legacy patch point shared with the settlement helper
import tradingagents
from langgraph.prebuilt import ToolNode

from tradingagents.llm_clients import create_llm_client
from tradingagents.default_config import DEFAULT_CONFIG, validate_holding_period_days
from tradingagents.agents.utils.memory import TradingMemoryLog
from tradingagents.dataflows.utils import safe_ticker_component
from tradingagents.dataflows.config import run_config, run_config_context, set_config
from tradingagents.agents.utils.rating import run_rating
from tradingagents.agents.utils.settlement import compute_returns
from .analyst_execution import ANALYST_NODE_SPECS

# Import the new abstract tool methods from agent_utils
from tradingagents.agents.utils.agent_utils import (
    build_instrument_context,
    resolve_instrument_identity,
)

from .checkpointer import checkpoint_step, clear_checkpoint, get_checkpointer, thread_id
from .conditional_logic import ConditionalLogic
from .setup import GraphSetup
from .propagation import Propagator
from .reflection import Reflector
from .signal_processing import SignalProcessor

logger = logging.getLogger(__name__)

_NOT_IN_SIGNATURE = frozenset(
    {
        "results_dir",
        "data_cache_dir",
        "memory_log_path",
        "checkpoint_enabled",
        "llm_max_retries",
    }
)


def _validate_trade_date(trade_date) -> str:
    from tradingagents.dataflows.utils import get_current_date

    value = str(trade_date)
    try:
        canonical = datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d") == value
    except ValueError:
        canonical = False
    if not canonical or value > get_current_date():
        raise ValueError("trade_date must be a YYYY-MM-DD date no later than today")
    return value


class TradingAgentsGraph:
    """Main class that orchestrates the trading agents framework."""

    def __init__(
        self,
        selected_analysts=("market", "social", "news", "fundamentals"),
        debug=False,
        config: Dict[str, Any] = None,
        callbacks: Optional[List] = None,
    ):
        """Initialize the trading agents graph and components.

        Args:
            selected_analysts: List of analyst types to include
            debug: Whether to run in debug mode
            config: Configuration dictionary. If None, uses default config
            callbacks: Optional list of callback handlers (e.g., for tracking LLM/tool stats)
        """
        self.debug = debug
        self.config = deepcopy(DEFAULT_CONFIG)
        if config is not None:
            for key, value in deepcopy(config).items():
                if isinstance(value, dict) and isinstance(self.config.get(key), dict):
                    self.config[key].update(value)
                else:
                    self.config[key] = value
        validate_holding_period_days(self.config.get("holding_period_days", 5))
        self.selected_analysts = tuple(dict.fromkeys(selected_analysts))
        self.callbacks = callbacks or []

        # Update the interface's config
        set_config(self.config)

        # Create necessary directories
        os.makedirs(self.config["data_cache_dir"], exist_ok=True)
        os.makedirs(self.config["results_dir"], exist_ok=True)

        # Initialize LLMs with provider-specific thinking configuration
        llm_kwargs = self._get_provider_kwargs()

        # Add callbacks to kwargs if provided (passed to LLM constructor)
        if self.callbacks:
            llm_kwargs["callbacks"] = self.callbacks

        deep_client = create_llm_client(
            provider=self.config["llm_provider"],
            model=self.config["deep_think_llm"],
            base_url=self.config.get("backend_url"),
            **llm_kwargs,
        )
        quick_client = create_llm_client(
            provider=self.config["llm_provider"],
            model=self.config["quick_think_llm"],
            base_url=self.config.get("backend_url"),
            **llm_kwargs,
        )

        self.deep_thinking_llm = deep_client.get_llm()
        self.quick_thinking_llm = quick_client.get_llm()

        self.memory_log = TradingMemoryLog(self.config)

        # Create tool nodes
        self.tool_nodes = self._create_tool_nodes()

        # Initialize components
        self.conditional_logic = ConditionalLogic(
            max_debate_rounds=self.config["max_debate_rounds"],
            max_risk_discuss_rounds=self.config["max_risk_discuss_rounds"],
        )
        max_tool_rounds = self.config.get("max_tool_rounds", 20)
        max_recur_limit = self.config.get("max_recur_limit", 100)
        if (
            isinstance(max_tool_rounds, bool)
            or not isinstance(max_tool_rounds, int)
            or max_tool_rounds < 1
        ):
            raise ValueError("max_tool_rounds must be a positive integer")
        if 2 * max_tool_rounds + 2 >= max_recur_limit:
            raise ValueError(
                f"max_tool_rounds={max_tool_rounds} needs max_recur_limit above {2 * max_tool_rounds + 2}"
            )
        self.graph_setup = GraphSetup(
            self.quick_thinking_llm,
            self.deep_thinking_llm,
            self.tool_nodes,
            self.conditional_logic,
            analyst_concurrency_limit=self.config.get("analyst_concurrency_limit", 1),
            max_tool_rounds=max_tool_rounds,
        )

        self.propagator = Propagator(
            max_recur_limit=max_recur_limit,
            analyst_concurrency_limit=self.config.get("analyst_concurrency_limit", 1),
        )
        self.reflector = Reflector(self.quick_thinking_llm)
        self.signal_processor = SignalProcessor(self.quick_thinking_llm)

        # State tracking
        self.curr_state = None
        self.ticker = None
        self.log_states_dict = {}  # date to full state dict

        # Set up the graph: keep the workflow for recompilation with a checkpointer.
        self.workflow = self.graph_setup.setup_graph(self.selected_analysts)
        self.graph = self.workflow.compile()
        self._checkpointer_ctx = None
        self._resuming = False

    def _get_provider_kwargs(self) -> Dict[str, Any]:
        """Build provider kwargs while retaining the embedded caller's legacy API."""
        from tradingagents.llm_clients.factory import build_llm_kwargs

        return build_llm_kwargs(self.config)

    def _create_tool_nodes(self) -> Dict[str, ToolNode]:
        """Bind the executor to the same tools the analyst is offered."""
        return {key: ToolNode(list(spec.tools)) for key, spec in ANALYST_NODE_SPECS.items()}

    def _resolve_benchmark(self, ticker: str) -> str:
        """Pick the benchmark ticker for alpha calculation against ``ticker``.

        ``config["benchmark_ticker"]`` overrides everything when set; otherwise
        the suffix map matches the ticker's exchange suffix (e.g. ``.T`` for
        Tokyo). US-listed tickers without a dotted suffix fall through to the
        empty-suffix entry (SPY by default). Unrecognised suffixes (including
        US tickers with dots like ``BRK.B``) also fall back to the empty-suffix
        entry, which is the right default because the alpha calculation works
        in USD.
        """
        explicit = self.config.get("benchmark_ticker")
        if explicit:
            return explicit
        benchmark_map = self.config.get("benchmark_map", {})
        ticker_upper = ticker.upper()
        for suffix, benchmark in benchmark_map.items():
            if suffix and ticker_upper.endswith(suffix.upper()):
                return benchmark
        return benchmark_map.get("", "SPY")

    def _fetch_returns(
        self,
        ticker: str,
        trade_date: str,
        holding_days: int = 5,
        benchmark: str = "SPY",
    ) -> Tuple[Optional[float], Optional[float], Optional[int]]:
        """Compatibility wrapper returning outcomes only after the complete window."""
        return compute_returns(ticker, trade_date, holding_days, benchmark)[:3]

    def _resolve_pending_entries(self, ticker: str) -> None:
        """Resolve pending log entries for ticker at the start of a new run.

        Fetches returns for each same-ticker pending entry, generates reflections,
        then writes all updates in a single atomic batch write to avoid redundant I/O.
        Skips entries whose price data is not yet available (too recent or delisted)
        and fails open when deferred reflection cannot be completed.

        Trade-off: only same-ticker entries are resolved per run.  Entries for
        other tickers accumulate until that ticker is run again.
        """
        pending = [e for e in self.memory_log.get_pending_entries() if e["ticker"] == ticker]
        if not pending:
            return

        benchmark = self._resolve_benchmark(ticker)
        updates = []
        for entry in pending:
            raw, alpha, days, resolution_date = compute_returns(
                ticker,
                entry["date"],
                holding_days=self.config.get("holding_period_days", 5),
                benchmark=benchmark,
            )
            if raw is None:
                continue  # price not available yet — try again next run
            try:
                reflection = self.reflector.reflect_on_final_decision(
                    final_decision=entry.get("decision", ""),
                    raw_return=raw,
                    alpha_return=alpha,
                    benchmark_name=benchmark,
                )
            except Exception as e:
                logger.warning(
                    "Could not generate outcome reflection for %s on %s vs %s (will retry next run): %s",
                    ticker,
                    entry["date"],
                    benchmark,
                    e,
                )
                continue
            updates.append(
                {
                    "ticker": ticker,
                    "trade_date": entry["date"],
                    "raw_return": raw,
                    "alpha_return": alpha,
                    "holding_days": days,
                    "reflection": reflection,
                    "resolution_date": resolution_date,
                }
            )

        if updates:
            try:
                self.memory_log.batch_update_with_outcomes(updates)
            except Exception as e:
                logger.warning(
                    "Could not persist resolved outcomes for %s (will retry next run): %s",
                    ticker,
                    e,
                )

    def resolve_instrument_context(
        self,
        ticker: str,
        asset_type: str = "stock",
        trade_date: Optional[str] = None,
    ) -> str:
        """Resolve identity once, identifying historical names as current metadata."""
        identity = resolve_instrument_identity(ticker)
        return build_instrument_context(ticker, asset_type, identity, trade_date)

    def _memory_as_of(self, trade_date) -> Optional[str]:
        """Historical runs see only lessons resolved by their trade date."""
        from tradingagents.dataflows.utils import get_current_date

        return str(trade_date) if str(trade_date) < get_current_date() else None

    def _run_signature(self, asset_type: str = "stock") -> str:
        settings = {k: v for k, v in self.config.items() if k not in _NOT_IN_SIGNATURE}
        digest = hashlib.sha256(
            json.dumps(settings, sort_keys=True, default=str).encode()
        ).hexdigest()[:16]
        return "|".join(
            [
                "analysts=" + ",".join(self.selected_analysts),
                f"asset={asset_type}",
                "layout=parallel-v1",
                f"settings={digest}",
            ]
        )

    def begin_checkpoint(self, company_name, trade_date, asset_type: str = "stock"):
        """Attach a per-ticker saver; pair with end_checkpoint in a finally block."""
        trade_date = _validate_trade_date(trade_date)
        if self._checkpointer_ctx is not None:
            raise RuntimeError("a checkpointed run is already active on this graph")
        self._resuming = False
        if not self.config.get("checkpoint_enabled"):
            return None
        signature = self._run_signature(asset_type)
        self._checkpointer_ctx = get_checkpointer(self.config["data_cache_dir"], company_name)
        try:
            saver = self._checkpointer_ctx.__enter__()
        except Exception:
            self._checkpointer_ctx = None
            raise
        try:
            self.graph = self.workflow.compile(checkpointer=saver)
            step = checkpoint_step(
                self.config["data_cache_dir"], company_name, str(trade_date), signature
            )
        except Exception:
            self.end_checkpoint()
            raise
        self._resuming = step is not None
        logger.info(
            "%s for %s on %s",
            f"Resuming from step {step}" if self._resuming else "Starting fresh",
            company_name,
            trade_date,
        )
        return thread_id(company_name, str(trade_date), signature)

    def checkpoint_input(self, initial_state):
        """Passing None resumes without appending initial messages a second time."""
        return None if self._resuming else initial_state

    def end_checkpoint(self):
        """Close the saver and restore the graph, including after stream errors."""
        if self._checkpointer_ctx is not None:
            context, self._checkpointer_ctx = self._checkpointer_ctx, None
            try:
                context.__exit__(None, None, None)
            finally:
                self.graph = self.workflow.compile()
        self._resuming = False

    @contextmanager
    def checkpoint_scope(self, company_name, trade_date, asset_type: str = "stock"):
        try:
            yield self.begin_checkpoint(company_name, trade_date, asset_type)
        finally:
            self.end_checkpoint()

    def clear_checkpoint_on_success(self, company_name, trade_date, asset_type: str = "stock"):
        if self.config.get("checkpoint_enabled"):
            clear_checkpoint(
                self.config["data_cache_dir"],
                company_name,
                str(trade_date),
                self._run_signature(asset_type),
            )

    def run_settings(self) -> dict:
        """An allowlist for reproducibility that excludes endpoints, secrets and paths."""
        llm_kwargs = self._get_provider_kwargs()
        return {
            "core_version": tradingagents.__version__,
            "upstream_revision": "8b22d43",
            "llm_provider": self.config.get("llm_provider"),
            "quick_think_llm": self.config.get("quick_think_llm"),
            "deep_think_llm": self.config.get("deep_think_llm"),
            "analysts": list(self.selected_analysts),
            "max_debate_rounds": self.config.get("max_debate_rounds"),
            "max_risk_discuss_rounds": self.config.get("max_risk_discuss_rounds"),
            "max_tool_rounds": self.config.get("max_tool_rounds", 20),
            "analyst_concurrency_limit": self.config.get("analyst_concurrency_limit", 1),
            "output_language": self.config.get("output_language"),
            "temperature": llm_kwargs.get("temperature"),
            "max_tokens": llm_kwargs.get("max_tokens", llm_kwargs.get("max_output_tokens")),
            "data_vendors": dict(self.config.get("data_vendors") or {}),
            "tool_vendors": dict(self.config.get("tool_vendors") or {}),
        }

    def create_run_state(self, company_name, trade_date, asset_type: str = "stock"):
        """Build the shared initial state for script, CLI and desktop entry points."""
        trade_date = _validate_trade_date(trade_date)
        with run_config(self.config):
            self.ticker = company_name
            self._resolve_pending_entries(company_name)
            return self.propagator.create_initial_state(
                company_name,
                trade_date,
                asset_type=asset_type,
                past_context=self.memory_log.get_past_context(
                    company_name, as_of=self._memory_as_of(trade_date)
                ),
                instrument_context=self.resolve_instrument_context(
                    company_name, asset_type, str(trade_date)
                ),
                run_settings={
                    **self.run_settings(),
                    "trade_date": trade_date,
                    "asset_type": asset_type,
                },
            )

    def record_decision(self, company_name, trade_date, final_state):
        """Write the final state and preserve the Portfolio Manager's authoritative rating."""
        self.curr_state = final_state
        if not final_state.get("run_settings"):
            final_state["run_settings"] = {
                **self.run_settings(),
                "trade_date": str(trade_date),
                "asset_type": final_state.get("asset_type", "stock"),
            }
        self._log_state(trade_date, final_state)
        decision = final_state.get("final_trade_decision")
        if decision:
            self.memory_log.store_decision(
                ticker=company_name,
                trade_date=trade_date,
                final_trade_decision=decision,
                rating=run_rating(final_state),
            )

    def propagate(self, company_name, trade_date, asset_type: str = "stock"):
        """Run a graph, returning its final state and a 5-tier rating or REVIEW."""
        trade_date = _validate_trade_date(trade_date)
        with (
            run_config(self.config),
            self.checkpoint_scope(company_name, trade_date, asset_type) as tid,
        ):
            return self._run_graph(company_name, trade_date, asset_type, checkpoint_thread_id=tid)

    def _run_graph(
        self, company_name, trade_date, asset_type: str = "stock", checkpoint_thread_id=None
    ):
        initial = self.create_run_state(company_name, trade_date, asset_type)
        args = self.propagator.get_graph_args()
        if checkpoint_thread_id is not None:
            args["config"].setdefault("configurable", {})["thread_id"] = checkpoint_thread_id
        graph_input = self.checkpoint_input(initial)
        if self.debug:
            final_state, printed = {}, set()
            for messages, state in self.stream_run(graph_input, **args):
                for message in messages:
                    key = getattr(message, "id", None) or (
                        type(message).__name__,
                        str(message.content),
                    )
                    if key not in printed:
                        printed.add(key)
                        message.pretty_print()
                if state:
                    final_state.update(
                        {key: value for key, value in state.items() if key != "analyst_started"}
                    )
        else:
            final_state = self.graph.invoke(graph_input, **args)
        self.record_decision(company_name, trade_date, final_state)
        self.clear_checkpoint_on_success(company_name, trade_date, asset_type)
        return final_state, run_rating(final_state)

    def stream_run(self, graph_input, *, include_agent=False, **args):
        """Yield (messages, state) pairs, or triples with agent when include_agent=True.

        Analyst messages arrive from private subgraphs. A partial state carries
        a report as soon as it finishes; top-level values carry the full state.
        The context advances each step privately so it does not leak to callers.
        """
        args = {**args, "stream_mode": ["values", "custom"]}
        args["config"] = {
            **args.get("config", {}),
            "max_concurrency": self.config.get("analyst_concurrency_limit", 1) + 1,
        }
        context = run_config_context(self.config)
        stream = context.run(self.graph.stream, graph_input, subgraphs=True, **args)
        try:
            while (step := context.run(next, stream, None)) is not None:
                namespace, mode, chunk = step
                if mode == "custom" and isinstance(chunk, dict) and chunk.get("analyst"):
                    agent = chunk["analyst"]
                    if chunk.get("analyst_started"):
                        event = ([], {"analyst_started": agent})
                        yield (*event, agent) if include_agent else event
                    else:
                        messages, report = chunk.get("messages", []), chunk.get("report")
                        if messages or report:
                            yield (messages, report, agent) if include_agent else (messages, report)
                elif not namespace and mode == "values":
                    result = (chunk.get("messages", []), chunk)
                    yield (*result, None) if include_agent else result
        finally:
            context.run(stream.close)

    def _log_state(self, trade_date, final_state):
        """Log the final state to a JSON file."""
        self.log_states_dict[str(trade_date)] = {
            "company_of_interest": final_state["company_of_interest"],
            "trade_date": final_state["trade_date"],
            "market_report": final_state["market_report"],
            "sentiment_report": final_state["sentiment_report"],
            "news_report": final_state["news_report"],
            "fundamentals_report": final_state["fundamentals_report"],
            "investment_debate_state": {
                "bull_history": final_state["investment_debate_state"]["bull_history"],
                "bear_history": final_state["investment_debate_state"]["bear_history"],
                "history": final_state["investment_debate_state"]["history"],
                "current_response": final_state["investment_debate_state"]["current_response"],
                "judge_decision": final_state["investment_debate_state"]["judge_decision"],
            },
            "trader_investment_decision": final_state["trader_investment_plan"],
            "risk_debate_state": {
                "aggressive_history": final_state["risk_debate_state"]["aggressive_history"],
                "conservative_history": final_state["risk_debate_state"]["conservative_history"],
                "neutral_history": final_state["risk_debate_state"]["neutral_history"],
                "history": final_state["risk_debate_state"]["history"],
                "judge_decision": final_state["risk_debate_state"]["judge_decision"],
            },
            "investment_plan": final_state["investment_plan"],
            "final_trade_decision": final_state["final_trade_decision"],
            "final_rating": run_rating(final_state),
            "run_settings": final_state.get("run_settings", self.run_settings()),
        }

        # Save to file. Reject ticker values that would escape the
        # results directory when joined as a path component.
        safe_ticker = safe_ticker_component(final_state["company_of_interest"])
        directory = Path(self.config["results_dir"]) / safe_ticker / "TradingAgentsStrategy_logs"
        directory.mkdir(parents=True, exist_ok=True)

        log_path = directory / f"full_states_log_{trade_date}.json"
        with open(log_path, "w", encoding="utf-8") as f:
            json.dump(self.log_states_dict[str(trade_date)], f, indent=4)

    def process_signal(self, full_signal):
        """Process a signal to extract the core decision."""
        return self.signal_processor.process_signal(full_signal)
