#!/usr/bin/env python3
"""Check explicit public-source files offline, without writing or fetching."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

os.environ["EVIDENCELOOM_BOOTSTRAP_ONLY"] = "1"
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tradingagents.evaluation.public_sources import (  # noqa: E402
    MAX_SOURCE_BYTES,
    PublicSourceCorpusError,
    derive_bls_table,
    validate_corpus,
    validate_pending_review,
)
from tradingagents.memory.schema import canonical_json, parse_json  # noqa: E402


def _read(path):
    with Path(path).open("rb") as source:
        value = source.read(MAX_SOURCE_BYTES + 1)
    if len(value) > MAX_SOURCE_BYTES:
        raise PublicSourceCorpusError()
    return value


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise PublicSourceCorpusError()


def main(argv=None):
    parser = _Parser(description="Verify a saved BLS monthly public-source corpus")
    parser.add_argument("manifest", help="Explicit corpus manifest JSON")
    parser.add_argument("raw", help="Original saved BLS response bytes")
    parser.add_argument("--review-package", help="Optional separately bound pending-review JSON")
    try:
        options = parser.parse_args(argv)
        raw = _read(options.raw)
        manifest = validate_corpus(parse_json(_read(options.manifest)), raw)
        table = derive_bls_table(raw)
        if options.review_package:
            validate_pending_review(parse_json(_read(options.review_package)), manifest, raw)
        summary = {
            "corpus_id": manifest["corpus_id"],
            "manifest_sha256": manifest["manifest_sha256"],
            "raw_sha256": table["source_raw_sha256"],
            "table_sha256": table["table_sha256"],
            "series_count": len(manifest["series"]),
            "observation_count": len(table["rows"]),
            "historical_authority": "UNAVAILABLE",
            "expert": "NOT_EVALUATED",
        }
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        print("Invalid public-source corpus", file=sys.stderr)
        return 1
    print(canonical_json(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
