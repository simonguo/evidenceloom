"""Ratings, optional prices and decision prompts retain only supported claims."""

from unittest.mock import MagicMock

import pytest

from tradingagents.agents.managers.portfolio_manager import create_portfolio_manager
from tradingagents.agents.researchers.bull_researcher import create_bull_researcher
from tradingagents.agents.risk_mgmt.aggressive_debator import create_aggressive_debator
from tradingagents.agents.schemas import PortfolioDecision, TraderProposal
from tradingagents.agents.trader.trader import create_trader
from tradingagents.agents.utils.rating import parse_rating, run_rating
from tradingagents.graph.propagation import Propagator


@pytest.mark.parametrize(
    "text",
    [
        "This is not a Sell; the buy thesis still needs evidence.",
        "Rating Scale: Buy / Overweight / Hold / Underweight / Sell",
        "> Rating: Buy\nThe quoted analyst was overoptimistic.",
        "| Rating | Buy |",
        "A researcher said Rating: Buy, but that is unsupported.",
        "Rating: not a Hold",
    ],
)
def test_unlabelled_or_quoted_rating_is_review(text):
    assert parse_rating(text) == "REVIEW"


@pytest.mark.parametrize(
    "text,expected",
    [
        ("**评级**：减持/低配", "Underweight"),
        ("## 最终评级 — **Overweight**", "Overweight"),
        ("1. **Rating**: Sell", "Sell"),
        ("Rating: Hold\nConsensus rating: Buy", "Hold"),
        ("**Rating**: REVIEW", "REVIEW"),
    ],
)
def test_explicit_rating_compatibility(text, expected):
    assert parse_rating(text) == expected


def test_backend_typed_rating_and_review_override_prose():
    assert run_rating({"final_rating": "Sell", "final_trade_decision": "Rating: Buy"}) == "Sell"
    assert run_rating({"final_rating": "REVIEW", "final_trade_decision": "Rating: Buy"}) == "REVIEW"


@pytest.mark.parametrize(
    "bad", ["N/A", "15%", "150-160", "around 150", [], {}, True, float("inf"), float("nan")]
)
def test_bad_optional_prices_do_not_discard_the_decision(bad):
    decision = PortfolioDecision(
        rating="Sell",
        executive_summary="Reduce risk",
        investment_thesis="Evidence",
        price_target=bad,
    )
    proposal = TraderProposal(action="Buy", reasoning="Evidence", entry_price=bad, stop_loss=bad)
    assert decision.rating.value == "Sell" and decision.price_target is None
    assert (
        proposal.action.value == "Buy"
        and proposal.entry_price is None
        and proposal.stop_loss is None
    )


def test_formatted_absolute_price_is_preserved():
    proposal = TraderProposal(
        action="Buy", reasoning="Evidence", entry_price="$1,234.50", stop_loss="1200"
    )
    assert proposal.entry_price == 1234.5 and proposal.stop_loss == 1200


def state():
    initial = Propagator().create_initial_state("NVDA", "2026-01-05")
    initial.update({"investment_plan": "Research plan", "trader_investment_plan": "Trader plan"})
    return initial


def test_portfolio_manager_keeps_its_typed_rating():
    llm = MagicMock()
    llm.with_structured_output.return_value.invoke.return_value = PortfolioDecision(
        rating="Underweight",
        executive_summary="Trim exposure",
        investment_thesis="Researcher recommendation: Buy is too optimistic.",
    )
    result = create_portfolio_manager(llm)(state())
    assert result["final_rating"] == "Underweight"
    assert result["final_trade_decision"].startswith("**Rating**: Underweight")
    llm.invoke.assert_not_called()


def test_portfolio_manager_freetext_without_rating_requires_review():
    llm = MagicMock()
    llm.with_structured_output.side_effect = NotImplementedError
    llm.invoke.return_value.content = "We cannot support the Sell thesis with this evidence."
    result = create_portfolio_manager(llm)(state())
    assert result["final_rating"] == "REVIEW"


def test_trader_has_the_technical_report_and_does_not_assume_empty_holdings():
    llm = MagicMock()
    llm.with_structured_output.side_effect = NotImplementedError
    llm.invoke.return_value.content = "Action: Hold"
    initial = state()
    initial["market_report"] = "Verified close 189.5 and support 180"
    create_trader(llm)(initial)
    prompt = str(llm.invoke.call_args.args[0])
    assert "Verified close 189.5" in prompt
    assert "absolute prices" in prompt
    assert "not provided" in prompt and "do not assume a flat book" in prompt
    assert "Do not call external tools" in prompt


@pytest.mark.parametrize("factory", [create_bull_researcher, create_aggressive_debator])
def test_opening_debate_does_not_invent_an_opponent(factory):
    llm = MagicMock()
    llm.invoke.return_value.content = "Own case"
    factory(llm)(state())
    assert "absent" in llm.invoke.call_args.args[0]
