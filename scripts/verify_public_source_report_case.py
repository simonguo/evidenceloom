#!/usr/bin/env python3
"""Read explicit saved report/source artifacts offline; write no output file."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

os.environ["EVIDENCELOOM_BOOTSTRAP_ONLY"] = "1"
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tradingagents.evaluation.public_source_reports import (  # noqa: E402
    MAX_CASE_BYTES,
    MAX_REPORT_BYTES,
    MAX_SOURCE_BYTES,
    PublicSourceReportError,
    evaluate_report_case,
)
from tradingagents.memory.schema import canonical_json, parse_json  # noqa: E402


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise PublicSourceReportError()


def _read(path, limit):
    with Path(path).open("rb") as source:
        payload = source.read(limit + 1)
    if not 0 < len(payload) <= limit:
        raise PublicSourceReportError()
    return payload


def main(argv=None):
    parser = _Parser(description="Verify one saved engineering report's selected BLS cells")
    parser.add_argument("case")
    parser.add_argument("report")
    parser.add_argument("manifest")
    parser.add_argument("raw")
    try:
        options = parser.parse_args(argv)
        result = evaluate_report_case(
            parse_json(_read(options.case, MAX_CASE_BYTES).decode("utf-8")),
            _read(options.report, MAX_REPORT_BYTES),
            parse_json(_read(options.manifest, MAX_SOURCE_BYTES).decode("utf-8")),
            _read(options.raw, MAX_SOURCE_BYTES),
        )
        summary = {
            "case_sha256": result["case_sha256"],
            "report_sha256": result["report_ref"]["report_sha256"],
            "report_raw_utf8_sha256": result["report_ref"]["report_raw_utf8_sha256"],
            "manifest_sha256": result["source_ref"]["manifest_sha256"],
            "raw_sha256": result["source_ref"]["raw_sha256"],
            "table_sha256": result["source_ref"]["table_sha256"],
            "result_sha256": result["result_sha256"],
            "series_count": result["series_count"],
            "observation_count": result["observation_count"],
            "counts": result["counts"],
            "metadata_authority": result["metadata_authority"],
            "semantic_support": result["semantic_support"],
            "provider_origin": result["authority"]["provider_origin"],
            "historical_vintage": result["authority"]["historical_vintage"],
            "publication_time": result["authority"]["publication_time"],
            "first_public_availability": result["authority"]["first_public_availability"],
            "historical_authority": result["historical_authority"],
            "expert": result["expert_review"]["status"],
            "expert_approved_claim_denominator": result["expert_review"][
                "approved_claim_denominator"
            ],
        }
    except (OSError, ValueError, TypeError, UnicodeError, RecursionError):
        print("Invalid public-source report case", file=sys.stderr)
        return 1
    print(canonical_json(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
