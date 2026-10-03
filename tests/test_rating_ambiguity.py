"""A list of directional alternatives is not the Portfolio Manager's call."""

import pytest

from tradingagents.agents.utils.rating import parse_rating


@pytest.mark.parametrize(
    "label",
    [
        "Rating: Buy or Sell",
        "Rating: Buy/Hold/Sell",
        "评级：买入或卖出",
        "评级：增持/低配",
        "Rating: Buy (买入/超配)",
    ],
)
def test_an_ambiguous_rating_clause_requires_review(label):
    assert parse_rating(label) == "REVIEW"


@pytest.mark.parametrize(
    "label,expected",
    [
        ("Rating: Buy (买入)", "Buy"),
        ("评级：减持/低配", "Underweight"),
        ("Rating: Buy — this is stronger than the Sell case", "Buy"),
        ("Rating: Buy; a Sell would be premature", "Buy"),
    ],
)
def test_a_single_rating_keeps_translations_and_separate_explanations(label, expected):
    assert parse_rating(label) == expected
