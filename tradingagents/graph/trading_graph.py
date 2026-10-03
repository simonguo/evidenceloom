# TradingAgents/graph/trading_graph.py

import hashlib
import logging
from contextlib import contextmanager
from copy import deepcopy
import os
from pathlib import Path
import json
from datetime import datetime, timezone
from typing import Dict, Any, Tuple, List, Optional

from cli.research_manifest import context_sha256 as _context_sha256
from cli.research_manifest import source_code_sha256 as _source_code_sha256
import yfinance as yf  # noqa: F401 - legacy patch point shared with the settlement helper
import tradingagents
from langgraph.prebuilt import ToolNode

from tradingagents.llm_clients import create_llm_client
from tradingagents.default_config import DEFAULT_CONFIG, validate_holding_period_days
from tradingagents.agents.utils.output_quality import sanitize_output_quality
from tradingagents.agents.utils.memory import TradingMemoryLog
from tradingagents.dataflows.utils import safe_ticker_component
from tradingagents.dataflows.symbol_utils import normalize_symbol
from tradingagents.dataflows.config import run_config, run_config_context, set_config
from tradingagents.agents.utils.rating import run_rating
from tradingagents.agents.utils.settlement import compute_returns
from tradingagents.memory.evaluation import make_evaluation_plan
from tradingagents.research import make_policy, validate_policy, validate_readiness
from tradingagents.memory.schema import (
    validate_context_snapshot,
    validate_bundle as validate_memory_bundle,
)
from tradingagents.evidence import (
    EvidenceLedger,
    analyst_evidence,
    audit_citations,
    capture_evidence,
    merge_evidence_bundles,
    observe_attempt,
    observe_source,
    sanitize_diagnostic,
    validate_evidence_bundle,
)
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
from .research_memory import ResearchMemory
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


def _reports_for_audit(state):
    reports = {
        key: state[key]
        for key in (
            "market_report",
            "sentiment_report",
            "news_report",
            "fundamentals_report",
            "investment_plan",
            "trader_investment_plan",
            "final_trade_decision",
        )
        if isinstance(state.get(key), str)
    }
    for key, fields in (
        ("investment_debate_state", ("bull_history", "bear_history", "judge_decision")),
        (
            "risk_debate_state",
            ("aggressive_history", "conservative_history", "neutral_history", "judge_decision"),
        ),
    ):
        debate = state.get(key) or {}
        reports.update(
            {
                f"{key}.{field}": debate[field]
                for field in fields
                if isinstance(debate.get(field), str)
            }
        )
    return reports


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
        self._checkpoint_config = None
        self._evidence_ledger = None

    def _get_provider_kwargs(self) -> Dict[str, Any]:
        """Build provider kwargs while retaining the embedded caller's legacy API."""
        from tradingagents.llm_clients.factory import build_llm_kwargs

        return build_llm_kwargs(self.config)

    def _create_tool_nodes(self) -> Dict[str, ToolNode]:
        """Bind the executor to the same tools the analyst is offered."""
        return {key: ToolNode(list(spec.tools)) for key, spec in ANALYST_NODE_SPECS.items()}

    def _resolve_benchmark(self, ticker: str) -> str:
        """Resolve the benchmark symbol before freezing the research contract.

        ``config["benchmark_ticker"]`` overrides everything when set; otherwise
        the suffix map matches the ticker's exchange suffix (e.g. ``.T`` for
        Tokyo). US-listed tickers without a dotted suffix fall through to the
        empty-suffix entry (SPY by default). Unrecognised suffixes (including
        US tickers with dots like ``BRK.B``) also fall back to the empty-suffix
        entry. Reference returns retain each instrument's currency; no FX
        conversion or risk-adjusted alpha is implied.
        """
        explicit = self.config.get("benchmark_ticker")
        if explicit:
            return normalize_symbol(explicit)
        benchmark_map = self.config.get("benchmark_map", {})
        ticker_upper = ticker.upper()
        for suffix, benchmark in benchmark_map.items():
            if suffix and ticker_upper.endswith(suffix.upper()):
                return normalize_symbol(benchmark)
        return normalize_symbol(benchmark_map.get("", "SPY"))

    def _fetch_returns(
        self,
        ticker: str,
        trade_date: str,
        holding_days: int = 5,
        benchmark: str = "SPY",
    ) -> Tuple[Optional[float], Optional[float], Optional[int]]:
        """Compatibility wrapper returning outcomes only after the complete window."""
        return compute_returns(ticker, trade_date, holding_days, benchmark)[:3]

    def _research_memory(self):
        memory = getattr(self, "_research_memory_controller", None)
        if memory is None:
            memory = ResearchMemory(
                self.config, self.reflector, self.run_settings, secrets=self._evidence_secrets()
            )
            self._research_memory_controller = memory
        return memory

    def _resolve_pending_entries(self, ticker: str) -> None:
        """Settle immutable JSON decisions; legacy Markdown remains unverified."""
        self._research_memory().settle_pending(ticker)

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
                "layout=parallel-v5-evidence-v1-memory-v1-readiness-v1",
                "code=" + _source_code_sha256(Path(tradingagents.__file__).parent)[:16],
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
        self._checkpoint_config = {
            "configurable": {"thread_id": thread_id(company_name, str(trade_date), signature)}
        }
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
        self._checkpoint_config = None

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
            "holding_period_days": self.config.get("holding_period_days", 5),
            "benchmark_ticker": self.config.get("benchmark_ticker"),
        }

    def _evidence_storage(self) -> Path:
        return Path(self.config["data_cache_dir"]) / "evidence_bundles"

    def _evidence_secrets(self) -> tuple[str, ...]:
        """Pass configured secret values to the source-input sanitizer."""
        return tuple(
            value
            for key, value in self.config.items()
            if isinstance(value, str)
            and value
            and any(marker in key.lower() for marker in ("api_key", "token", "secret", "password"))
        )

    def _checkpoint_state(self, config=None):
        config = config or getattr(self, "_checkpoint_config", None)
        if config is None:
            raise ValueError("an evidence checkpoint requires a thread configuration")
        snapshot = self.graph.get_state(config, subgraphs=True)
        state = deepcopy(snapshot.values)
        if not state.get("evidence_bundle"):
            raise ValueError("checkpoint has no frozen research evidence")

        def collect(value):
            bundle = (value.values or {}).get("evidence_bundle")
            if bundle:
                state["evidence_bundle"] = merge_evidence_bundles(state["evidence_bundle"], bundle)
            for task in value.tasks:
                child = getattr(task, "state", None)
                if child is not None and hasattr(child, "tasks"):
                    collect(child)

        collect(snapshot)
        self._validate_frozen_state(state)
        return state

    def _validate_frozen_state(self, state):
        bundle = validate_evidence_bundle(state["evidence_bundle"])
        if (
            bundle["instrument"] != state.get("company_of_interest")
            or bundle["analysis_date"] != state.get("trade_date")
            or bundle["manifest"] != state.get("run_settings")
            or bundle["manifest"].get("memory_input_sha256")
            != _context_sha256(state.get("past_context", ""))
        ):
            raise ValueError("research evidence does not match the frozen run context")
        memory = state.get("research_memory")
        if bundle["manifest"].get("research_readiness_policy_sha256") and not memory:
            raise ValueError("Frozen research input checks require their original memory start")
        policy = state.get("research_readiness_policy")
        if bundle["manifest"].get("research_readiness_policy_sha256"):
            validate_policy(policy, bundle)
        elif policy:
            raise ValueError("Research readiness policy has no frozen manifest binding")
        if state.get("research_readiness"):
            validate_readiness(state["research_readiness"], bundle)
        if memory:
            context = validate_context_snapshot(memory["input_snapshot"])
            plan = memory["evaluation_plan"]
            if policy and (
                policy["research_started_at"] != memory["research_started_at"]
                or policy["research_calendar_date"] != plan["research_calendar_date"]
                or policy["host_utc_offset"] != plan["host_utc_offset"]
            ):
                raise ValueError("Research input policies disagree with the frozen memory start")
            if (
                context["instrument"] != bundle["instrument"]
                or context["research_cutoff"] != bundle["research_as_of"]
                or context["context_artifact"]["payload"] != state.get("past_context", "")
                or context["context_sha256"] != bundle["manifest"].get("memory_input_sha256")
                or plan["holding_period_days"] != bundle["manifest"].get("holding_period_days")
                or plan["resolved_benchmark"] != bundle["manifest"].get("benchmark_ticker")
                or plan["analysis_date"] != bundle["analysis_date"]
            ):
                raise ValueError("research memory does not match the frozen run context")
        identity = [
            record
            for record in bundle["records"]
            if record["analyst"] == "identity" and record["tool"] == "resolve_instrument_context"
        ]
        if len(identity) != 1:
            raise ValueError("research evidence has no unique frozen instrument context")
        artifact = bundle["artifacts"].get(identity[0]["output_sha256"])
        if artifact is None or artifact["payload"] != state.get("instrument_context"):
            raise ValueError("research evidence does not match the frozen instrument context")
        context = artifact["payload"].removeprefix(f"[E:{identity[0]['id']}]").lstrip("\n")
        if bundle["manifest"].get("instrument_identity_context_sha256") != _context_sha256(context):
            raise ValueError("research evidence does not match the instrument context manifest")
        return bundle

    def _ledger_for_state(self, state):
        bundle = self._validate_frozen_state(state)
        ledger = getattr(self, "_evidence_ledger", None)
        if ledger is None or ledger.bundle()["run_id"] != bundle["run_id"]:
            ledger = EvidenceLedger.restore(
                bundle, self._evidence_storage(), secrets=self._evidence_secrets()
            )
            self._evidence_ledger = ledger
        else:
            # Validate private checkpoint fragments against the active run.
            merge_evidence_bundles(ledger.bundle(), bundle)
        return ledger

    def create_run_state(self, company_name, trade_date, asset_type: str = "stock"):
        """Build the shared initial state for script, CLI and desktop entry points."""
        trade_date = _validate_trade_date(trade_date)
        if getattr(self, "_resuming", False):
            # A resume uses the checkpoint's original memory and identity;
            # resolving pending outcomes or Yahoo metadata would change inputs.
            state = self._checkpoint_state()
            if (
                state["company_of_interest"] != company_name
                or state["trade_date"] != trade_date
                or state.get("asset_type", "stock") != asset_type
            ):
                raise ValueError("research checkpoint does not match the requested run")
            self.ticker = company_name
            self._evidence_ledger = None
            self._ledger_for_state(state)
            return state
        with run_config(self.config):
            local_start = datetime.now().astimezone()
            research_started_at = (
                local_start.astimezone(timezone.utc)
                .isoformat(timespec="microseconds")
                .replace("+00:00", "Z")
            )
            offset = local_start.strftime("%z")
            host_utc_offset = offset[:3] + ":" + offset[3:]
            readiness_policy = make_policy(
                selected_analysts=self.selected_analysts,
                analysis_date=trade_date,
                research_started_at=research_started_at,
                research_calendar_date=local_start.date().isoformat(),
                host_utc_offset=host_utc_offset,
                max_tool_rounds=self.config.get("max_tool_rounds", 20),
            )
            evaluation_plan = make_evaluation_plan(
                analysis_date=trade_date,
                resolved_benchmark=self._resolve_benchmark(company_name),
                holding_period_days=self.config.get("holding_period_days", 5),
                host_local_calendar_at_start=local_start.date().isoformat(),
                host_utc_offset=host_utc_offset,
            )
            self.ticker = company_name
            self._resolve_pending_entries(company_name)
            memory_input = self._research_memory().store.context_snapshot(
                company_name, trade_date + "T23:59:59.999999Z"
            )
            past_context = memory_input["context_artifact"]["payload"]
            identity = resolve_instrument_identity(company_name)
            source_instrument_context = sanitize_diagnostic(
                build_instrument_context(company_name, asset_type, identity, trade_date),
                secrets=self._evidence_secrets(),
            )
            package = Path(tradingagents.__file__).parent
            settings = {
                **self.run_settings(),
                "trade_date": trade_date,
                "asset_type": asset_type,
                "benchmark_ticker": evaluation_plan["resolved_benchmark"],
                "code_sha256": _source_code_sha256(package),
                "prompt_templates_sha256": _source_code_sha256(package / "agents"),
                "memory_input_sha256": _context_sha256(past_context),
                "research_readiness_policy_sha256": readiness_policy["policy_sha256"],
                "instrument_identity_context_sha256": _context_sha256(source_instrument_context),
                "model_context_sha256": _context_sha256(
                    {
                        key: self.run_settings()[key]
                        for key in (
                            "llm_provider",
                            "quick_think_llm",
                            "deep_think_llm",
                            "temperature",
                            "max_tokens",
                        )
                    }
                ),
            }
            ledger = EvidenceLedger(
                company_name,
                trade_date,
                settings,
                self._evidence_storage(),
                secrets=self._evidence_secrets(),
            )

            def identity_input():
                observe_attempt("yfinance", "available" if identity else "unavailable")
                observe_source(
                    "yfinance",
                    normalized_data=identity,
                    historical_availability="unknown",
                    transformations=(
                        "Selected current Yahoo identity metadata, possibly from process cache; no historical identity vintage is established",
                    ),
                )
                return source_instrument_context

            with ledger.bind(), analyst_evidence("identity"):
                instrument_context = capture_evidence(
                    "resolve_instrument_context",
                    {"ticker": company_name, "trade_date": trade_date},
                    identity_input,
                )
            bundle = ledger.bundle()
            self._evidence_ledger = ledger
            return self.propagator.create_initial_state(
                company_name,
                trade_date,
                asset_type=asset_type,
                past_context=past_context,
                instrument_context=instrument_context,
                run_settings=bundle["manifest"],
                evidence_bundle=bundle,
                research_readiness_policy=readiness_policy,
                research_memory={
                    "research_started_at": research_started_at,
                    "evaluation_plan": evaluation_plan,
                    "input_snapshot": memory_input,
                },
            )

    def record_decision(self, company_name, trade_date, final_state, *, persist_state=True):
        """Write the final state and preserve the Portfolio Manager's authoritative rating."""
        if isinstance(final_state.get("final_trade_decision"), str):
            final_state["final_trade_decision"] = sanitize_diagnostic(
                final_state["final_trade_decision"], secrets=self._evidence_secrets()
            )
        if final_state.get("evidence_bundle"):
            ledger = self._ledger_for_state(final_state)
            merge_evidence_bundles(final_state["evidence_bundle"], ledger.bundle())
            final_state["evidence_bundle"] = ledger.bundle(reports=_reports_for_audit(final_state))
        self.curr_state = final_state
        if not final_state.get("run_settings"):
            final_state["run_settings"] = {
                **self.run_settings(),
                "trade_date": str(trade_date),
                "asset_type": final_state.get("asset_type", "stock"),
            }
        decision = final_state.get("final_trade_decision")
        if final_state.get("research_readiness"):
            final_state["research_readiness"] = validate_readiness(
                final_state["research_readiness"],
                final_state["evidence_bundle"],
                rating=run_rating(final_state),
                final_text=decision,
            )
        elif final_state.get("research_readiness_policy") and decision:
            raise ValueError("Completed research has no frozen input assessment")
        if decision and final_state.get("evidence_bundle"):
            final_state["memory_bundle"] = self._research_memory().record_final(
                final_state, final_state["evidence_bundle"], run_rating(final_state)
            )
            memory = validate_memory_bundle(final_state["memory_bundle"])
            if memory["input_snapshot"]["context_sha256"] != final_state["run_settings"].get(
                "memory_input_sha256"
            ):
                raise ValueError("completed research memory does not match the evidence manifest")
        if persist_state:
            self._log_state(trade_date, final_state)

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
            ledger = self._ledger_for_state(initial)
            with ledger.bind():
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
        state = (
            graph_input if graph_input is not None else self._checkpoint_state(args.get("config"))
        )
        ledger = self._ledger_for_state(state)
        binding = ledger.bind()
        context.run(binding.__enter__)
        stream = None
        try:
            stream = context.run(self.graph.stream, graph_input, subgraphs=True, **args)
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
                    full_bundle = merge_evidence_bundles(chunk["evidence_bundle"], ledger.bundle())
                    reports = _reports_for_audit(chunk)
                    chunk = {
                        **chunk,
                        "evidence_bundle": ledger.bundle(reports=reports)
                        if chunk.get("final_trade_decision")
                        else audit_citations(full_bundle, reports),
                    }
                    result = (chunk.get("messages", []), chunk)
                    yield (*result, None) if include_agent else result
        finally:
            try:
                if stream is not None:
                    context.run(stream.close)
            finally:
                context.run(binding.__exit__, None, None, None)

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
            "output_quality": sanitize_output_quality(final_state.get("output_quality")),
            "evidence_bundle": final_state.get("evidence_bundle", {}),
            **(
                {"research_readiness": final_state["research_readiness"]}
                if final_state.get("research_readiness")
                else {}
            ),
            **(
                {"memory_bundle": validate_memory_bundle(final_state["memory_bundle"])}
                if final_state.get("memory_bundle")
                else {}
            ),
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
