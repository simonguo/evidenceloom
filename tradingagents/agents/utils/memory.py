"""Append-only markdown decision log for TradingAgents."""

from typing import List, Optional
from pathlib import Path
import re
from datetime import datetime

from tradingagents.agents.utils.rating import normalize_rating, parse_rating
from tradingagents.agents.utils.memory_files import locked_memory_file, write_memory_file


class TradingMemoryLog:
    """Append-only markdown log of trading decisions and reflections."""

    # HTML comment: cannot appear in LLM prose output, safe as a hard delimiter
    _SEPARATOR = "\n\n<!-- ENTRY_END -->\n\n"
    # Precompiled patterns — avoids re-compilation on every load_entries() call
    _DECISION_RE = re.compile(r"DECISION:\n(.*?)(?=\nREFLECTION:|\Z)", re.DOTALL)
    _REFLECTION_RE = re.compile(r"REFLECTION:\n(.*?)$", re.DOTALL)

    def __init__(self, config: dict = None):
        cfg = config or {}
        self._log_path = None
        path = cfg.get("memory_log_path")
        if path:
            self._log_path = Path(path).expanduser()
            self._log_path.parent.mkdir(parents=True, exist_ok=True)
        # Optional cap on resolved entries. None disables rotation.
        self._max_entries = cfg.get("memory_log_max_entries")

    # --- Write path (Phase A) ---

    def store_decision(
        self,
        ticker: str,
        trade_date: str,
        final_trade_decision: str,
        rating: Optional[str] = None,
    ) -> None:
        """Store one decision per ticker/date, whether pending or already resolved."""
        if not self._log_path:
            return
        with locked_memory_file(self._log_path):
            text = self._log_path.read_text(encoding="utf-8") if self._log_path.exists() else ""
            for block in text.split(self._SEPARATOR):
                entry = self._parse_entry(block)
                if (
                    entry
                    and entry["date"] == trade_date
                    and entry["ticker"].upper() == ticker.upper()
                ):
                    return
            final_rating = normalize_rating(rating) or parse_rating(final_trade_decision)
            tag = f"[{trade_date} | {ticker} | {final_rating} | pending]"
            entry = f"{tag}\n\nDECISION:\n{final_trade_decision}{self._SEPARATOR}"
            write_memory_file(self._log_path, text + entry)

    # --- Read path (Phase A) ---

    def load_entries(self) -> List[dict]:
        """Parse all entries from log. Returns list of dicts."""
        if not self._log_path or not self._log_path.exists():
            return []
        text = self._log_path.read_text(encoding="utf-8")
        raw_entries = [e.strip() for e in text.split(self._SEPARATOR) if e.strip()]
        entries = []
        for raw in raw_entries:
            parsed = self._parse_entry(raw)
            if parsed:
                entries.append(parsed)
        return entries

    def get_pending_entries(self) -> List[dict]:
        """Return entries with outcome:pending (for Phase B)."""
        return [e for e in self.load_entries() if e.get("pending")]

    def get_past_context(
        self, ticker: str, n_same: int = 5, n_cross: int = 3, as_of: Optional[str] = None
    ) -> str:
        """Read only outcomes known by as_of; undated legacy lessons stay live-only."""
        entries = [e for e in self.load_entries() if not e.get("pending")]
        if as_of is not None:
            cutoff = _iso_date(as_of)
            if cutoff is None:
                raise ValueError("as_of must be a date in YYYY-MM-DD format")
            entries = [
                e
                for e in entries
                if e.get("resolved") and e["resolved"] <= cutoff and e["date"] <= cutoff
            ]
        if not entries:
            return ""

        same, cross = [], []
        for e in reversed(entries):
            if len(same) >= n_same and len(cross) >= n_cross:
                break
            if e["ticker"] == ticker and len(same) < n_same:
                same.append(e)
            elif e["ticker"] != ticker and len(cross) < n_cross:
                cross.append(e)

        if not same and not cross:
            return ""

        parts = []
        if same:
            parts.append(f"Past analyses of {ticker} (most recent first):")
            parts.extend(self._format_full(e) for e in same)
        if cross:
            parts.append("Recent cross-ticker lessons:")
            parts.extend(self._format_reflection_only(e) for e in cross)
        return "\n\n".join(parts)

    # --- Update path (Phase B) ---

    def update_with_outcome(
        self,
        ticker: str,
        trade_date: str,
        raw_return: float,
        alpha_return: float,
        holding_days: int,
        reflection: str,
        resolution_date: Optional[str] = None,
    ) -> None:
        """Record a settled outcome and the date its closing prices became known."""
        self.batch_update_with_outcomes(
            [
                {
                    "ticker": ticker,
                    "trade_date": trade_date,
                    "raw_return": raw_return,
                    "alpha_return": alpha_return,
                    "holding_days": holding_days,
                    "reflection": reflection,
                    "resolution_date": resolution_date,
                }
            ]
        )

    def batch_update_with_outcomes(self, updates: List[dict]) -> None:
        """Read, update and atomically replace the log under one writer lock."""
        if not self._log_path or not updates:
            return
        with locked_memory_file(self._log_path):
            if not self._log_path.exists():
                return
            text = self._log_path.read_text(encoding="utf-8")
            updates_by_key = {(u["trade_date"], u["ticker"].upper()): u for u in updates}
            blocks, changed = [], False
            for block in text.split(self._SEPARATOR):
                entry = self._parse_entry(block)
                update = (
                    updates_by_key.pop((entry["date"], entry["ticker"].upper()), None)
                    if entry
                    else None
                )
                if entry and entry["pending"] and update is not None:
                    tag = (
                        f"[{entry['date']} | {entry['ticker']} | {entry['rating']}"
                        f" | {update['raw_return']:+.1%} | {update['alpha_return']:+.1%}"
                        f" | {update['holding_days']}d"
                    )
                    resolved = _iso_date(update.get("resolution_date"))
                    if resolved:
                        tag += f" | resolved:{resolved}"
                    rest = "\n".join(block.strip().splitlines()[1:]).lstrip()
                    blocks.append(f"{tag}]\n\n{rest}\n\nREFLECTION:\n{update['reflection']}")
                    changed = True
                else:
                    blocks.append(block)
            if changed:
                write_memory_file(
                    self._log_path, self._SEPARATOR.join(self._apply_rotation(blocks))
                )

    # --- Helpers ---

    def _apply_rotation(self, blocks: List[str]) -> List[str]:
        """Drop oldest resolved blocks when their count exceeds max_entries.

        Pending blocks are always kept (they represent unprocessed work).
        Returns ``blocks`` unchanged when rotation is disabled or under cap.
        """
        if not self._max_entries or self._max_entries <= 0:
            return blocks

        # Tag each block with (kept, is_resolved) by parsing tag-line markers.
        decisions = []
        for block in blocks:
            stripped = block.strip()
            if not stripped:
                decisions.append((block, False))
                continue
            tag_line = stripped.splitlines()[0].strip()
            is_resolved = (
                tag_line.startswith("[")
                and tag_line.endswith("]")
                and not tag_line.endswith("| pending]")
            )
            decisions.append((block, is_resolved))

        resolved_count = sum(1 for _, r in decisions if r)
        if resolved_count <= self._max_entries:
            return blocks

        to_drop = resolved_count - self._max_entries
        kept: List[str] = []
        for block, is_resolved in decisions:
            if is_resolved and to_drop > 0:
                to_drop -= 1
                continue
            kept.append(block)
        return kept

    def _parse_entry(self, raw: str) -> Optional[dict]:
        lines = raw.strip().splitlines()
        if not lines:
            return None
        tag_line = lines[0].strip()
        if not (tag_line.startswith("[") and tag_line.endswith("]")):
            return None
        fields = [f.strip() for f in tag_line[1:-1].split("|")]
        if len(fields) < 4:
            return None
        entry = {
            "date": fields[0],
            "ticker": fields[1],
            "rating": fields[2],
            "pending": fields[3] == "pending",
            "raw": fields[3] if fields[3] != "pending" else None,
            "alpha": fields[4] if len(fields) > 4 else None,
            "holding": fields[5] if len(fields) > 5 else None,
            "resolved": next(
                (_iso_date(field[9:]) for field in fields[6:] if field.startswith("resolved:")),
                None,
            ),
        }
        body = "\n".join(lines[1:]).strip()
        decision_match = self._DECISION_RE.search(body)
        reflection_match = self._REFLECTION_RE.search(body)
        entry["decision"] = decision_match.group(1).strip() if decision_match else ""
        entry["reflection"] = reflection_match.group(1).strip() if reflection_match else ""
        return entry

    def _format_full(self, e: dict) -> str:
        raw = e["raw"] or "n/a"
        alpha = e["alpha"] or "n/a"
        holding = e["holding"] or "n/a"
        tag = f"[{e['date']} | {e['ticker']} | {e['rating']} | {raw} | {alpha} | {holding}]"
        parts = [tag, f"DECISION:\n{e['decision']}"]
        if e["reflection"]:
            parts.append(f"REFLECTION:\n{e['reflection']}")
        return "\n\n".join(parts)

    def _format_reflection_only(self, e: dict) -> str:
        tag = f"[{e['date']} | {e['ticker']} | {e['rating']} | {e['raw'] or 'n/a'}]"
        if e["reflection"]:
            return f"{tag}\n{e['reflection']}"
        text = e["decision"][:300]
        suffix = "..." if len(e["decision"]) > 300 else ""
        return f"{tag}\n{text}{suffix}"


def _iso_date(value) -> Optional[str]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
        return parsed if parsed == value else None
    except ValueError:
        return None
