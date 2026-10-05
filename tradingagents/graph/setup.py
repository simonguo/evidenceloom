import logging
from collections import Counter
from threading import BoundedSemaphore
from typing import Any, TypedDict

from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph
from langgraph.config import get_stream_writer
from langgraph.prebuilt import ToolNode

from tradingagents.agents import (
    create_aggressive_debator,
    create_bear_researcher,
    create_bull_researcher,
    create_conservative_debator,
    create_fundamentals_analyst,
    create_market_analyst,
    create_neutral_debator,
    create_news_analyst,
    create_portfolio_manager,
    create_research_manager,
    create_sentiment_analyst,
    create_trader,
)
from tradingagents.agents.analysts.turn import WRAP_UP
from tradingagents.agents.utils.agent_states import AgentState
from tradingagents.agents.utils.output_quality import sanitize_output_quality
from tradingagents.evidence import analyst_evidence, current_ledger
from tradingagents.research.readiness import assess_readiness, validate_readiness, withheld_decision
from tradingagents.research.effective_request_identity import unsafe_effective_request_ids

from .analyst_execution import build_analyst_execution_plan
from .conditional_logic import ConditionalLogic

logger = logging.getLogger(__name__)

# Every target a shared conditional router can return. Each edge driven by the
# router maps all of them, so a fall-through return (e.g. under prompt/i18n/
# refactor drift in the speaker labels) can never hit a missing path_map entry
# and crash LangGraph mid-run (#1088).
DEBATE_PATH_MAP = {
    "Bull Researcher": "Bull Researcher",
    "Bear Researcher": "Bear Researcher",
    "Research Manager": "Research Manager",
}
RISK_ANALYSIS_PATH_MAP = {
    "Aggressive Analyst": "Aggressive Analyst",
    "Conservative Analyst": "Conservative Analyst",
    "Neutral Analyst": "Neutral Analyst",
    "Portfolio Manager": "Portfolio Manager",
}


def _tools_or_done(state) -> str:
    """Route an analyst's turn: run its tool calls, or finish with its report."""
    return "tools" if state["messages"][-1].tool_calls else END


def _analyst_graph(spec, agent, max_tool_rounds: int):
    """One analyst as a graph of its own: the model and its tools, on a private message history.

    It returns its report and output-format quality, so its tool calls never
    reach the other analysts' messages. After
    ``max_tool_rounds`` rounds of tool calls it is told to write its report, and
    that turn ends it whatever it answers, so a model that keeps calling tools
    cannot run the graph into its recursion limit (#1420).
    """
    output = TypedDict(
        f"{spec.key.capitalize()}Report",
        {spec.report_key: str, "output_quality": dict, "evidence_bundle": dict},
    )
    graph = StateGraph(AgentState, output_schema=output)

    def emit_turn(result):
        ledger = current_ledger()
        if ledger is not None:
            result = {**result, "evidence_bundle": ledger.bundle(analyst=spec.key)}
        get_stream_writer()({"analyst": spec.agent_node, "messages": result.get("messages", [])})
        return result

    def agent_turn(state):
        return emit_turn(agent(state))

    graph.add_node("agent", agent_turn)
    graph.add_edge(START, "agent")
    if not spec.tools:
        graph.add_edge("agent", END)
        return graph.compile()

    def calls(messages):
        return [call["name"] for m in messages for call in (getattr(m, "tool_calls", None) or [])]

    def rounds(messages) -> int:
        return sum(1 for m in messages if getattr(m, "tool_calls", None))

    def more_or_wrap_up(state) -> str:
        return "wrap_up" if rounds(state["messages"]) >= max_tool_rounds else "agent"

    def wrap_up(state):
        repeated = ", ".join(
            f"{name} x{n}" for name, n in Counter(calls(state["messages"])).most_common()
        )
        logger.warning(
            "%s used its %d tool rounds (%s); asking for its report",
            spec.agent_node,
            max_tool_rounds,
            repeated,
        )
        return emit_turn(agent({**state, "messages": [*state["messages"], HumanMessage(WRAP_UP)]}))

    tool_node = ToolNode(list(spec.tools))

    def tools_turn(state, config):
        return emit_turn(tool_node.invoke(state, config))

    graph.add_node("tools", tools_turn)
    graph.add_node("wrap_up", wrap_up)
    graph.add_conditional_edges("agent", _tools_or_done, ["tools", END])
    graph.add_conditional_edges("tools", more_or_wrap_up, ["agent", "wrap_up"])
    graph.add_edge("wrap_up", END)
    return graph.compile()


class GraphSetup:
    """Handles the setup and configuration of the agent graph."""

    def __init__(
        self,
        quick_thinking_llm: Any,
        deep_thinking_llm: Any,
        tool_nodes: dict[str, ToolNode],
        conditional_logic: ConditionalLogic,
        analyst_concurrency_limit: int = 1,
        max_tool_rounds: int = 20,
    ):
        """Initialize with required components."""
        self.quick_thinking_llm = quick_thinking_llm
        self.deep_thinking_llm = deep_thinking_llm
        # Keep the legacy attribute for embedded callers. Tool bindings now come
        # from the same declaration as the analyst's model bindings.
        self.tool_nodes = tool_nodes
        self.conditional_logic = conditional_logic
        self.analyst_concurrency_limit = analyst_concurrency_limit
        self.max_tool_rounds = max_tool_rounds

    def setup_graph(self, selected_analysts=("market", "social", "news", "fundamentals")):
        """Set up and compile the agent workflow graph.

        Args:
            selected_analysts (list): List of analyst types to include. Options are:
                - "market": Market analyst
                - "social": Sentiment analyst
                - "news": News analyst
                - "fundamentals": Fundamentals analyst
        """
        plan = build_analyst_execution_plan(
            selected_analysts, concurrency_limit=self.analyst_concurrency_limit
        )

        analyst_factories = {
            "market": lambda: create_market_analyst(self.quick_thinking_llm),
            "social": lambda: create_sentiment_analyst(self.quick_thinking_llm),
            "news": lambda: create_news_analyst(self.quick_thinking_llm),
            "fundamentals": lambda: create_fundamentals_analyst(self.quick_thinking_llm),
        }

        bull_researcher_node = create_bull_researcher(self.quick_thinking_llm)
        bear_researcher_node = create_bear_researcher(self.quick_thinking_llm)
        research_manager_node = create_research_manager(self.deep_thinking_llm)
        trader_node = create_trader(self.quick_thinking_llm)

        aggressive_analyst = create_aggressive_debator(self.quick_thinking_llm)
        neutral_analyst = create_neutral_debator(self.quick_thinking_llm)
        conservative_analyst = create_conservative_debator(self.quick_thinking_llm)
        portfolio_manager_node = create_portfolio_manager(self.deep_thinking_llm)

        def gated_portfolio_manager(state):
            ledger = current_ledger()
            evidence = ledger.bundle() if ledger is not None else state.get("evidence_bundle")
            policy = state.get("research_readiness_policy")
            if not evidence or not policy:
                # Embedded callers without a frozen capture cannot establish
                # input readiness from model prose or a completed execution.
                text = (
                    "Rating: REVIEW\n\nNo frozen research input contract is available. "
                    "Earlier analyst reports and debate require human review."
                )
                return {
                    "final_rating": "REVIEW",
                    "final_trade_decision": text,
                    "risk_debate_state": {
                        **state["risk_debate_state"],
                        "judge_decision": text,
                        "latest_speaker": "Judge",
                    },
                }
            assessment = assess_readiness(evidence, policy)
            if state.get("research_readiness"):
                validate_readiness(state["research_readiness"], evidence)
                if state["research_readiness"] != assessment:
                    raise ValueError("Research readiness changed after it was frozen")
            unsafe_requests = unsafe_effective_request_ids(evidence)
            if assessment["recommendation_allowed"] and not unsafe_requests:
                result = portfolio_manager_node(state)
            else:
                text = (
                    "Rating: REVIEW\n\n"
                    "Saved effective tool requests require human review before a directional recommendation.\n"
                    "Provider requests and returned entity identity remain unverified.\n"
                    "Earlier reports and debate remain exploratory research.\n"
                    "Saved request references: "
                    + " ".join(f"[E:{item}]" for item in unsafe_requests)
                    if unsafe_requests
                    else withheld_decision(assessment)
                )
                result = {
                    "final_rating": "REVIEW",
                    "final_trade_decision": text,
                    "risk_debate_state": {
                        **state["risk_debate_state"],
                        "judge_decision": text,
                        "latest_speaker": "Judge",
                    },
                }
            return {**result, "research_readiness": assessment, "evidence_bundle": evidence}

        workflow = StateGraph(AgentState)

        slots = BoundedSemaphore(self.analyst_concurrency_limit)

        def bounded_analyst(spec):
            private_graph = _analyst_graph(
                spec, analyst_factories[spec.key](), self.max_tool_rounds
            )

            def run_analyst(state, config):
                # Stream execution reserves a worker for LangGraph's queue
                # waiter, so bound the actual analyst lifetime independently.
                with slots, analyst_evidence(spec.key):
                    writer = get_stream_writer()
                    writer({"analyst": spec.agent_node, "analyst_started": True})
                    result = private_graph.invoke(state, config)
                    # An analyst inherits parent state on resume. Project only
                    # its own quality so an inherited, stale record cannot
                    # overwrite a concurrent analyst's newer validation.
                    quality = sanitize_output_quality(result.get("output_quality"))
                    key = "sentiment" if spec.key == "social" else None
                    result = {
                        **result,
                        "output_quality": {key: quality[key]} if key in quality else {},
                    }
                    ledger = current_ledger()
                    if ledger is not None:
                        result["evidence_bundle"] = ledger.bundle(analyst=spec.key)
                    writer({"analyst": spec.agent_node, "report": result})
                    return result

            return run_analyst

        for spec in plan.specs:
            workflow.add_node(spec.agent_node, bounded_analyst(spec))

        workflow.add_node("Bull Researcher", bull_researcher_node)
        workflow.add_node("Bear Researcher", bear_researcher_node)
        workflow.add_node("Research Manager", research_manager_node)
        workflow.add_node("Trader", trader_node)
        workflow.add_node("Aggressive Analyst", aggressive_analyst)
        workflow.add_node("Neutral Analyst", neutral_analyst)
        workflow.add_node("Conservative Analyst", conservative_analyst)
        workflow.add_node("Portfolio Manager", gated_portfolio_manager)

        # The analysts work at the same time; the research debate starts once
        # every one of them has filed its report.
        analysts = [spec.agent_node for spec in plan.specs]
        for node in analysts:
            workflow.add_edge(START, node)
        workflow.add_edge(analysts, "Bull Researcher")

        # Both research-debate edges share the complete DEBATE_PATH_MAP (#1088).
        for debate_node in ("Bull Researcher", "Bear Researcher"):
            workflow.add_conditional_edges(
                debate_node,
                self.conditional_logic.should_continue_debate,
                DEBATE_PATH_MAP,
            )
        workflow.add_edge("Research Manager", "Trader")
        workflow.add_edge("Trader", "Aggressive Analyst")
        # All three risk edges share the complete RISK_ANALYSIS_PATH_MAP (#1088).
        for risk_node in ("Aggressive Analyst", "Conservative Analyst", "Neutral Analyst"):
            workflow.add_conditional_edges(
                risk_node,
                self.conditional_logic.should_continue_risk_analysis,
                RISK_ANALYSIS_PATH_MAP,
            )

        workflow.add_edge("Portfolio Manager", END)

        return workflow
