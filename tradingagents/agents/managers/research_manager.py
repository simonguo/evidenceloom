"""Research Manager: turns the bull/bear debate into a structured investment plan for the trader."""

from __future__ import annotations

from tradingagents.agents.schemas import ResearchPlan, render_research_plan
from tradingagents.agents.utils.agent_utils import (
    get_instrument_context_from_state,
    get_language_instruction,
)
from tradingagents.agents.utils.structured import (
    bind_structured,
    invoke_agent_output,
    NO_EXTERNAL_TOOLS,
)


def create_research_manager(llm):
    structured_llm = bind_structured(llm, ResearchPlan, "Research Manager")

    def research_manager_node(state) -> dict:
        instrument_context = get_instrument_context_from_state(state)
        history = state["investment_debate_state"].get("history", "")

        investment_debate_state = state["investment_debate_state"]

        prompt = f"""As the Research Manager and debate facilitator, your role is to critically evaluate this round of debate and deliver a clear, actionable investment plan for the trader.

{instrument_context}

---

**Rating Scale** (use exactly one):
- **Buy**: Strong conviction in the bull thesis; recommend taking or growing the position
- **Overweight**: Constructive view; recommend gradually increasing exposure
- **Hold**: Balanced view; recommend maintaining the current position
- **Underweight**: Cautious view; recommend trimming exposure
- **Sell**: Strong conviction in the bear thesis; recommend exiting or avoiding the position

Weigh the opposing cases on their evidence, independent of speaking order. Conflict alone is not a reason to Hold: choose the stronger case and size by how decisively it wins. Choose Hold when the evidence remains balanced or too thin to support a call; do not manufacture a direction to appear decisive.

---

**Debate History:**
{history}

Write Recommendation, Rationale and Strategic Actions in that order, starting with **Recommendation**: exactly one of Buy / Overweight / Hold / Underweight / Sell on its own line.

The research team does not know the caller's holdings. Express sizing against a standard allocation, so the trader can apply the actual portfolio. {NO_EXTERNAL_TOOLS}""" + get_language_instruction()

        output = invoke_agent_output(
            structured_llm,
            llm,
            prompt,
            ResearchPlan,
            render_research_plan,
            "Research Manager",
        )
        investment_plan = output.text

        new_investment_debate_state = {
            "judge_decision": investment_plan,
            "history": investment_debate_state.get("history", ""),
            "bear_history": investment_debate_state.get("bear_history", ""),
            "bull_history": investment_debate_state.get("bull_history", ""),
            "current_response": investment_plan,
            "count": investment_debate_state["count"],
        }

        return {
            "investment_debate_state": new_investment_debate_state,
            "investment_plan": investment_plan,
            "output_quality": {"research_manager": output.quality},
        }

    return research_manager_node
