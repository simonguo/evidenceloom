#!/usr/bin/env python3
"""Evaluate a frozen selected-claim pack without loading runtime configuration."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

# Set before the first tradingagents import: package bootstrap otherwise loads
# dotenv and langchain. This entry point does not load dotenv, profiles or
# credential files and does not initialize providers or make network requests.
# Inherited sanitizers may inspect already-present environment secret values
# only to reject matching unsafe text; those values are never saved or emitted.
os.environ["EVIDENCELOOM_BOOTSTRAP_ONLY"] = "1"
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tradingagents.evaluation import FrozenEvaluationError, FrozenEvaluationIOError, evaluate_file  # noqa: E402


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Evaluate explicit claims from a frozen offline research pack"
    )
    parser.add_argument("input", help="Frozen selected-claim pack JSON")
    parser.add_argument(
        "--output", required=True, help="New result JSON (existing files are never replaced)"
    )
    options = parser.parse_args(argv)
    try:
        result = evaluate_file(options.input, options.output)
    except (FrozenEvaluationError, FrozenEvaluationIOError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(result["result_sha256"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
