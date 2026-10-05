"""The whole graph, end to end, with scripted models and no network.

Every tool-using analyst calls each of its tools once through the vendor router,
the debates and managers run, and the decision is parsed and logged. This pins
the wiring: a restructure that drops a node, a tool or an edge fails here.
"""

from __future__ import annotations

import copy

import pandas as pd
import pytest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableLambda
from pydantic import Field

from tradingagents.agents import schemas
from tradingagents.agents.utils import agent_utils as context
from tradingagents.agents.analysts import sentiment_analyst
from tradingagents.dataflows import interface as router
from tradingagents.dataflows import market_data_validator as snapshot
from tradingagents.default_config import DEFAULT_CONFIG
from tradingagents.graph import trading_graph

TRADE_DATE = "2026-01-09"

# Enough for every free-text reader: the PM's labelled rating and the trader's
# closing proposal line.
TEXT = "Report.\n\n**Rating**: Overweight\n\nFINAL TRANSACTION PROPOSAL: **BUY**"

STRUCTURED = {
    schemas.ResearchPlan: schemas.ResearchPlan(
        recommendation=schemas.PortfolioRating.OVERWEIGHT, rationale="r", strategic_actions="a"
    ),
    schemas.TraderProposal: schemas.TraderProposal(action=schemas.TraderAction.BUY, reasoning="r"),
    # The thesis quotes another party's rating; the decision is still the PM's own.
    schemas.PortfolioDecision: schemas.PortfolioDecision(
        rating=schemas.PortfolioRating.OVERWEIGHT,
        executive_summary="s",
        investment_thesis="Street consensus rating: Buy (28 of 35 analysts).",
    ),
    schemas.SentimentReport: schemas.SentimentReport(
        overall_band=schemas.SentimentBand.NEUTRAL,
        overall_score=5.0,
        confidence="low",
        narrative="n",
    ),
}

ARGS = {
    "symbol": "NVDA",
    "ticker": "NVDA",
    "curr_date": TRADE_DATE,
    "start_date": "2026-01-02",
    "end_date": TRADE_DATE,
    "indicator": "rsi",
    "topic": "Fed rate cut",
    "freq": "quarterly",
}


class ScriptedModel(BaseChatModel):
    """Calls every bound tool once, then answers with TEXT."""

    structured: bool = False
    tools: tuple = ()
    calls: list = Field(default_factory=list)  # shared across bound copies
    threads: set = Field(default_factory=set)  # threads that served a tool-bound call
    fail_at: int | None = None  # raise on this call, once

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self.model_copy(update={"tools": tuple(tools)})

    def with_structured_output(self, schema, **kwargs):
        if not self.structured:
            raise NotImplementedError
        return RunnableLambda(lambda _: self._count() or STRUCTURED[schema])

    def _count(self) -> None:
        self.calls.append(1)
        if len(self.calls) == self.fail_at:
            raise RuntimeError("provider unavailable")

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self._count()
        if self.tools:
            import threading
            import time

            self.threads.add(threading.current_thread().name)
            time.sleep(0.05)  # long enough for concurrent analysts to overlap
        if self.tools and not isinstance(messages[-1], ToolMessage):
            calls = [
                {
                    "name": t.name,
                    "id": f"call_{i}",
                    "args": {
                        k: v
                        for k, v in ARGS.items()
                        if k in t.tool_call_schema.model_json_schema()["properties"]
                    },
                }
                for i, t in enumerate(self.tools)
            ]
            message = AIMessage(content="", tool_calls=calls)
        else:
            message = AIMessage(content=TEXT)
        return ChatResult(generations=[ChatGeneration(message=message)])


class _Client:
    def __init__(self, model):
        self.model = model

    def get_llm(self):
        return self.model


@pytest.fixture
def offline(monkeypatch, tmp_path):
    """Every vendor answers offline; returns the set of router methods called."""
    called: set[str] = set()
    for method, vendors in router.VENDOR_METHODS.items():
        for vendor in vendors:
            monkeypatch.setitem(
                vendors, vendor, lambda *a, _m=method, **k: called.add(_m) or f"{_m} data"
            )
    prices = pd.DataFrame(
        {
            "Date": pd.bdate_range(end=TRADE_DATE, periods=60),
            "Open": 100.0,
            "High": 101.0,
            "Low": 99.0,
            "Close": 100.5,
            "Volume": 1_000_000,
        }
    )
    monkeypatch.setattr(
        snapshot, "load_ohlcv", lambda *a, **k: called.add("ohlcv") or prices.copy()
    )
    monkeypatch.setattr(sentiment_analyst, "fetch_stocktwits_messages", lambda *a, **k: "no posts")
    monkeypatch.setattr(sentiment_analyst, "fetch_reddit_posts", lambda *a, **k: "no posts")
    monkeypatch.setattr(
        context.yf, "Ticker", lambda s: type("T", (), {"info": {"longName": "NVIDIA"}})()
    )
    context.resolve_instrument_identity.cache_clear()
    return called


def _graph(tmp_path, monkeypatch, model, debug=False, **config):
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg.update(
        results_dir=str(tmp_path / "results"),
        data_cache_dir=str(tmp_path / "cache"),
        memory_log_path=str(tmp_path / "log.md"),
    )
    cfg.update(analyst_concurrency_limit=2)
    cfg.update(config)
    monkeypatch.setattr(trading_graph, "create_llm_client", lambda **k: _Client(model))
    return trading_graph.TradingAgentsGraph(config=cfg, debug=debug)


@pytest.mark.unit
@pytest.mark.parametrize("structured", [False, True], ids=["free-text", "structured"])
def test_a_full_run_reaches_a_logged_decision(tmp_path, monkeypatch, offline, structured):
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(structured=structured))

    state, signal = graph.propagate("NVDA", TRADE_DATE)

    assert signal == state["final_rating"] == "REVIEW"
    assert not state["research_readiness"]["recommendation_allowed"]
    assert (
        "historical_availability_unknown"
        in state["research_readiness"]["checks"][0]["reason_codes"]
    )
    for key in (
        "market_report",
        "sentiment_report",
        "news_report",
        "fundamentals_report",
        "investment_plan",
        "trader_investment_plan",
        "final_trade_decision",
    ):
        assert state[key].strip(), key
    tool_methods = {
        "get_stock_data",
        "get_indicators",
        "get_news",
        "get_global_news",
        "get_fundamentals",
        "get_balance_sheet",
        "get_cashflow",
        "get_income_statement",
        "get_insider_transactions",
        "ohlcv",
    }
    assert offline == tool_methods
    memory = state["memory_bundle"]
    assert graph._research_memory().store.load_bundle(memory["run_id"]) == memory
    assert memory["decision_snapshot"]["decision"]["rating"] == "REVIEW"
    assert memory["evidence_bundle_sha256"] == state["evidence_bundle"]["bundle_sha256"]
    assert graph.memory_log.load_entries() == []


@pytest.mark.unit
def test_an_interrupted_run_resumes_from_its_checkpoint(tmp_path, monkeypatch, offline):
    model = ScriptedModel(fail_at=12)  # past the analysts, before the decision
    graph = _graph(tmp_path, monkeypatch, model, checkpoint_enabled=True)
    with pytest.raises(RuntimeError, match="provider unavailable"):
        graph.propagate("NVDA", TRADE_DATE)
    calls_before = len(model.calls)

    _, signal = graph.propagate("NVDA", TRADE_DATE)

    assert signal == "REVIEW"
    resumed_calls = len(model.calls) - calls_before
    full_run = ScriptedModel()
    _graph(tmp_path / "fresh", monkeypatch, full_run).propagate("NVDA", TRADE_DATE)
    # The resumed run makes only the calls the interrupted one had not completed;
    # unknown historical inputs withhold the Portfolio Manager call.
    assert resumed_calls == len(full_run.calls) - (model.fail_at - 1)


@pytest.mark.unit
def test_the_analysts_run_at_the_same_time(tmp_path, monkeypatch, offline):
    model = ScriptedModel()
    graph = _graph(tmp_path, monkeypatch, model)

    assert not [n for n in graph.graph.get_graph().nodes if n.startswith("Msg Clear")]
    graph.propagate("NVDA", TRADE_DATE)

    assert len(model.threads) > 1


@pytest.mark.unit
def test_a_debug_run_prints_the_analysts_work_and_reaches_the_same_decision(
    tmp_path, monkeypatch, offline, capsys
):
    """Debug mode streams the analysts' own graphs, so their tool calls still print."""
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(), debug=True)

    state, signal = graph.propagate("NVDA", TRADE_DATE)

    assert signal == "REVIEW"
    assert state["market_report"].strip() and state["fundamentals_report"].strip()
    printed = capsys.readouterr().out
    assert "get_stock_data" in printed and "get_balance_sheet" in printed


@pytest.mark.unit
def test_each_report_streams_as_soon_as_its_analyst_files_it(tmp_path, monkeypatch, offline):
    """The main state takes the analysts' reports only when the slowest one is
    done; the CLI shows each report, and stops each clock, as it lands."""
    graph = _graph(tmp_path, monkeypatch, ScriptedModel())
    reports = ("market_report", "sentiment_report", "news_report", "fundamentals_report")

    first = next(
        state
        for _, state in graph.stream_run(
            graph.create_run_state("NVDA", TRADE_DATE), **graph.propagator.get_graph_args()
        )
        if state and any(state.get(k) for k in reports)
    )

    assert sum(bool(first.get(k)) for k in reports) == 1


@pytest.mark.unit
def test_a_streamed_run_reads_its_own_graph_config(tmp_path, monkeypatch, offline):
    """The CLI streams the run; a process-wide config set elsewhere must not reach
    its tools, and the graph's config must not reach the caller between steps."""
    from tradingagents.dataflows.config import get_config, set_config

    graph = _graph(
        tmp_path,
        monkeypatch,
        ScriptedModel(),
        output_language="French",
        data_vendors={"core_stock_apis": "yfinance"},
    )
    set_config({"output_language": "German"})
    seen = []
    monkeypatch.setitem(
        router.VENDOR_METHODS["get_stock_data"],
        "yfinance",
        lambda *a, **k: seen.append(get_config()["output_language"]) or "prices",
    )

    between = [
        get_config()["output_language"]
        for _ in graph.stream_run(
            graph.create_run_state("NVDA", TRADE_DATE), **graph.propagator.get_graph_args()
        )
    ]

    assert seen and set(seen) == {"French"}
    assert set(between) == {"German"}


class LoopingModel(ScriptedModel):
    """Calls a tool on every turn it is offered one (#1420)."""

    tool_turns: list = Field(default_factory=list)  # shared across bound copies
    last_turns: list = Field(default_factory=list)  # histories of the turns offered no tools

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        if not self.tools:
            self.last_turns.append(messages)
            return super()._generate(messages, stop, run_manager, **kwargs)
        self.tool_turns.append(1)
        tool = self.tools[0]
        call = {
            "name": tool.name,
            "id": f"call_{len(self.tool_turns)}",
            "args": {
                k: v
                for k, v in ARGS.items()
                if k in tool.tool_call_schema.model_json_schema()["properties"]
            },
        }
        return ChatResult(
            generations=[ChatGeneration(message=AIMessage(content="", tool_calls=[call]))]
        )


@pytest.mark.unit
def test_an_analyst_that_keeps_calling_tools_writes_its_report_at_the_limit(
    tmp_path, monkeypatch, offline
):
    """A model that does not stop calling tools must not end the run (#1420)."""
    model = LoopingModel(structured=True)
    graph = _graph(tmp_path, monkeypatch, model, max_tool_rounds=3)

    final_state, rating = graph.propagate("NVDA", TRADE_DATE)

    assert len(model.tool_turns) == 3 * 3  # three tool-using analysts, three rounds each
    for key in ("market_report", "news_report", "fundamentals_report"):
        assert final_state[key] == TEXT
    assert rating == "REVIEW"
    assert (
        "missing_required_verification"
        in final_state["research_readiness"]["checks"][1]["reason_codes"]
    )


@pytest.mark.unit
def test_the_last_turn_is_offered_no_tools_and_reads_its_tool_results_as_text(
    tmp_path, monkeypatch, offline
):
    """Offered tools, a model may call one whatever it is told; a history holding
    tool calls may be refused by a provider when no tools are bound."""
    model = LoopingModel(structured=True)
    graph = _graph(tmp_path, monkeypatch, model, max_tool_rounds=2)

    graph.propagate("NVDA", TRADE_DATE)

    wrap_ups = [
        h
        for h in model.last_turns
        if isinstance(h[-1], HumanMessage) and "tool round" in h[-1].content
    ]
    assert len(wrap_ups) == 3
    for history in wrap_ups:
        assert not any(
            isinstance(m, ToolMessage) or getattr(m, "tool_calls", None) for m in history
        )
        assert any("returned]" in str(m.content) for m in history)
        assert "tool rounds are spent" in history[0].content  # the system prompt lists no tools


@pytest.mark.unit
def test_a_tool_limit_the_recursion_limit_cannot_hold_is_refused(tmp_path, monkeypatch):
    with pytest.raises(ValueError, match="max_tool_rounds"):
        _graph(tmp_path, monkeypatch, ScriptedModel(), max_tool_rounds=60, max_recur_limit=100)


@pytest.mark.unit
@pytest.mark.parametrize("limit", [1, 2, 4])
def test_the_analyst_concurrency_limit_is_respected(tmp_path, monkeypatch, offline, limit):
    import threading
    import time

    class MeasuredModel(ScriptedModel):
        measurements: dict = Field(default_factory=lambda: {"active": 0, "peak": 0})
        mutex: object = Field(default_factory=threading.Lock)

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if not self.tools:
                return super()._generate(messages, stop, run_manager, **kwargs)
            with self.mutex:
                self.measurements["active"] += 1
                self.measurements["peak"] = max(
                    self.measurements["peak"], self.measurements["active"]
                )
            try:
                time.sleep(0.04)
                return super()._generate(messages, stop, run_manager, **kwargs)
            finally:
                with self.mutex:
                    self.measurements["active"] -= 1

    model = MeasuredModel()
    graph = _graph(tmp_path, monkeypatch, model, analyst_concurrency_limit=limit)
    graph.propagate("NVDA", TRADE_DATE)
    assert model.measurements["peak"] == min(limit, 3)


@pytest.mark.unit
def test_the_stream_names_started_analysts_before_their_messages(tmp_path, monkeypatch, offline):
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(), analyst_concurrency_limit=1)
    seen = set()
    for messages, state, agent in graph.stream_run(
        graph.create_run_state("NVDA", TRADE_DATE),
        include_agent=True,
        **graph.propagator.get_graph_args(),
    ):
        if state and state.get("analyst_started"):
            assert agent not in seen
            seen.add(agent)
        elif agent and messages:
            assert agent in seen
    assert seen == {"Market Analyst", "News Analyst", "Sentiment Analyst", "Fundamentals Analyst"}


@pytest.mark.unit
def test_tool_bindings_use_one_declaration_and_include_the_snapshot(tmp_path, monkeypatch, offline):
    from tradingagents.graph.analyst_execution import ANALYST_NODE_SPECS

    graph = _graph(tmp_path, monkeypatch, ScriptedModel())
    for key, spec in ANALYST_NODE_SPECS.items():
        assert set(graph.tool_nodes[key].tools_by_name) == {tool.name for tool in spec.tools}
    assert "get_verified_market_snapshot" in graph.tool_nodes["market"].tools_by_name


@pytest.mark.unit
def test_manifest_excludes_credentials_and_endpoint(tmp_path, monkeypatch, offline):
    import json

    graph = _graph(
        tmp_path,
        monkeypatch,
        ScriptedModel(),
        backend_url="https://secret-user:secret-password@gateway.invalid/v1",
        api_key="private-token",
    )
    state, _ = graph.propagate("NVDA", TRADE_DATE)
    manifest = state["run_settings"]
    assert manifest["trade_date"] == TRADE_DATE
    assert manifest["analysts"] == ["market", "social", "news", "fundamentals"]
    dumped = json.dumps(manifest)
    assert "secret-user" not in dumped and "secret-password" not in dumped
    assert "private-token" not in dumped and "gateway.invalid" not in dumped
    logs = list((tmp_path / "results").rglob("*.json"))
    assert json.loads(logs[0].read_text())["run_settings"] == manifest


@pytest.mark.unit
def test_private_analyst_histories_do_not_include_other_analysts_tools(
    tmp_path, monkeypatch, offline
):
    class IsolatedModel(ScriptedModel):
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            if self.tools:
                allowed = {tool.name for tool in self.tools}
                for message in messages:
                    if isinstance(message, ToolMessage):
                        assert message.name in allowed
                    if isinstance(message, AIMessage):
                        assert all(call["name"] in allowed for call in message.tool_calls)
            return super()._generate(messages, stop, run_manager, **kwargs)

    graph = _graph(tmp_path, monkeypatch, IsolatedModel(), analyst_concurrency_limit=4)
    state, _ = graph.propagate("NVDA", TRADE_DATE)
    assert state["market_report"] and state["fundamentals_report"]
    assert not any(isinstance(message, ToolMessage) for message in state["messages"])


@pytest.mark.unit
def test_an_interrupted_private_analyst_resumes_without_repeating_its_tools(
    tmp_path, monkeypatch, offline
):
    counts = []
    for method, vendors in router.VENDOR_METHODS.items():
        for vendor in vendors:
            monkeypatch.setitem(
                vendors, vendor, lambda *a, _m=method, **k: counts.append(_m) or f"{_m} data"
            )
    model = ScriptedModel(fail_at=2)
    graph = _graph(
        tmp_path, monkeypatch, model, checkpoint_enabled=True, analyst_concurrency_limit=1
    )
    with pytest.raises(RuntimeError, match="provider unavailable"):
        graph.propagate("NVDA", TRADE_DATE)
    completed_tools = list(counts)
    assert completed_tools
    graph.propagate("NVDA", TRADE_DATE)
    for method in completed_tools:
        assert counts.count(method) == completed_tools.count(method)


@pytest.mark.unit
def test_failed_identity_lookup_can_recover_on_the_next_attempt(monkeypatch):
    calls = []

    def ticker(_):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("temporary lookup failure")
        return type("Ticker", (), {"info": {"longName": "Correct Company"}})()

    context.resolve_instrument_identity.cache_clear()
    monkeypatch.setattr(context.yf, "Ticker", ticker)
    assert context.resolve_instrument_identity("AAPL") == {}
    assert context.resolve_instrument_identity("AAPL")["company_name"] == "Correct Company"
    assert context.resolve_instrument_identity("AAPL")["company_name"] == "Correct Company"
    assert len(calls) == 2


@pytest.mark.unit
def test_historical_identity_supplies_only_the_current_name():
    text = context.build_instrument_context(
        "AAPL",
        identity={
            "company_name": "Current Company",
            "sector": "TodaySector",
            "industry": "TodayIndustry",
            "exchange": "TodayExchange",
        },
        trade_date="2020-01-02",
    )
    assert "Current Company" in text and "current name" in text
    assert all(value not in text for value in ("TodaySector", "TodayIndustry", "TodayExchange"))


@pytest.mark.unit
@pytest.mark.parametrize("trade_date", ["2026-1-2", "invalid", "2999-01-01"])
def test_invalid_or_future_run_dates_are_rejected(tmp_path, monkeypatch, offline, trade_date):
    graph = _graph(tmp_path, monkeypatch, ScriptedModel())
    with pytest.raises(ValueError, match="trade_date"):
        graph.propagate("NVDA", trade_date)


@pytest.mark.unit
def test_pair_stream_preserves_start_events_for_cli_timing(tmp_path, monkeypatch, offline):
    graph = _graph(tmp_path, monkeypatch, ScriptedModel(), analyst_concurrency_limit=1)
    started, reported = set(), set()
    for messages, state in graph.stream_run(
        graph.create_run_state("NVDA", TRADE_DATE), **graph.propagator.get_graph_args()
    ):
        if state and state.get("analyst_started"):
            started.add(state["analyst_started"])
        for key, agent in (
            ("market_report", "Market Analyst"),
            ("news_report", "News Analyst"),
            ("sentiment_report", "Sentiment Analyst"),
            ("fundamentals_report", "Fundamentals Analyst"),
        ):
            if state and state.get(key) and agent not in reported:
                assert agent in started
                reported.add(agent)
    assert len(started) == len(reported) == 4
