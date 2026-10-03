"""Memory lessons respect their known-by date and survive concurrent writers."""

from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest

from tradingagents.agents.utils.memory import TradingMemoryLog


def log_at(path):
    return TradingMemoryLog({"memory_log_path": str(path)})


def test_only_known_outcomes_enter_historical_context(tmp_path):
    log = log_at(tmp_path / "memory.md")
    for ticker, date, known in [
        ("NVDA", "2026-01-01", "2026-01-08"),
        ("NVDA", "2026-01-02", "2026-01-15"),
        ("MSFT", "2026-01-01", None),
    ]:
        log.store_decision(ticker, date, f"Rating: Buy\nEvidence for {date} {ticker}")
        log.update_with_outcome(
            ticker, date, 0.05, 0.02, 5, f"Lesson {ticker} {date}", resolution_date=known
        )
    context = log.get_past_context("NVDA", as_of="2026-01-10")
    assert "2026-01-01" in context
    assert "2026-01-02" not in context and "MSFT" not in context
    assert "MSFT" in log.get_past_context("NVDA")


def test_resolved_entry_blocks_a_duplicate_and_preserves_typed_rating(tmp_path):
    log = log_at(tmp_path / "memory.md")
    log.store_decision("NVDA", "2026-01-01", "Rating: Buy", rating="Sell")
    log.update_with_outcome(
        "NVDA", "2026-01-01", 0.05, 0.02, 5, "Lesson", resolution_date="2026-01-08"
    )
    log.store_decision("nvda", "2026-01-01", "Rating: Hold")
    assert len(log.load_entries()) == 1
    assert log.load_entries()[0]["rating"] == "Sell"


def test_concurrent_appends_and_settlements_keep_all_entries(tmp_path):
    path = tmp_path / "memory.md"

    def write(index):
        log = log_at(path)
        ticker = f"SYM{index}"
        log.store_decision(ticker, "2026-01-01", "Rating: Hold")
        log.update_with_outcome(
            ticker, "2026-01-01", 0.01, 0.0, 5, "Settled", resolution_date="2026-01-08"
        )
        log.store_decision(ticker, "2026-01-01", "Rating: Buy")

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(write, range(24)))
    entries = log_at(path).load_entries()
    assert len(entries) == 24
    assert len({entry["ticker"] for entry in entries}) == 24
    assert all(not entry["pending"] and entry["rating"] == "Hold" for entry in entries)
    assert not list(tmp_path.glob("*.tmp"))


def test_failed_atomic_write_keeps_previous_log_and_cleans_its_temp(tmp_path):
    path = tmp_path / "memory.md"
    log = log_at(path)
    log.store_decision("NVDA", "2026-01-01", "Rating: Buy")
    original = path.read_text()
    with patch(
        "tradingagents.agents.utils.memory_files.os.replace", side_effect=OSError("disk failure")
    ):
        with pytest.raises(OSError):
            log.update_with_outcome("NVDA", "2026-01-01", 0.05, 0.02, 5, "Lesson")
    assert path.read_text() == original
    assert not list(tmp_path.glob("*.tmp"))
