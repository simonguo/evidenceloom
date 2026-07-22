#!/usr/bin/env python3
from __future__ import annotations

import json
import sys

from tradingagents.dataflows.stockstats_utils import load_ohlcv


def load_chart(symbol: str, curr_date: str):
    symbol = symbol.strip()
    curr_date = curr_date.strip()
    if not symbol or not curr_date:
        raise ValueError("symbol and curr_date are required")

    data = load_ohlcv(symbol, curr_date)
    if data.empty:
        return []

    data = data.copy()
    data["Date"] = data["Date"].dt.strftime("%Y-%m-%d")
    rows = []
    for row in data.tail(240).to_dict(orient="records"):
        rows.append(
            {
                "time": row.get("Date"),
                "open": float(row.get("Open")),
                "high": float(row.get("High")),
                "low": float(row.get("Low")),
                "close": float(row.get("Close")),
                "volume": float(row.get("Volume", 0) or 0),
            }
        )
    return rows


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: load_ohlcv_chart.py <symbol> <curr_date>", file=sys.stderr)
        return 2

    print(json.dumps(load_chart(sys.argv[1], sys.argv[2]), ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
