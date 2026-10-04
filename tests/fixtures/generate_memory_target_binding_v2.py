"""Regenerate fictional cross-language targets/facts; makes no provider calls."""

from copy import deepcopy
import json
from pathlib import Path
from tempfile import TemporaryDirectory

import pandas as pd

from tradingagents.memory.evaluation import (
    bind_evaluation_contract,
    evaluate_decision,
    make_target_evaluation_plan,
)
from tradingagents.memory.schema import build_decision_snapshot, make_artifact, make_component
from tradingagents.memory.store import MemoryStore
from tradingagents.memory.targets import policy_artifact

TARGET_VECTORS = [
    ("FICT_SOURCE_A", "FICT_SOURCE_A", "exact"),
    (" \tfict_source_a\r\n", "FICT_SOURCE_A", "exact"),
    ("600519.SH", "600519.SS", "venue_notation"),
    ("SH600519", "600519.SS", "venue_notation"),
    ("600519.SS", "600519.SS", "exact"),
    ("SZ000001", "000001.SZ", "venue_notation"),
    ("000001.SZ", "000001.SZ", "exact"),
    ("700.HK", "0700.HK", "venue_notation"),
    ("0700.HK", "0700.HK", "venue_notation"),
    ("1.HK", "0001.HK", "venue_notation"),
    ("9999.HK", "9999.HK", "venue_notation"),
    ("12345.HK", None, "unknown"),
    ("60051.SH", None, "unknown"),
    ("600519OTHER.SS", None, "unknown"),
    ("SH600519OTHER", None, "unknown"),
    ("SZ00001", None, "unknown"),
    ("EURUSD", "EURUSD=X", "pair_notation"),
    ("EURUSD=X", "EURUSD=X", "exact"),
    ("BTCUSD", "BTC-USD", "pair_notation"),
    ("BTC-USD", "BTC-USD", "exact"),
    ("GOLD", "GC=F", "proxy"),
    ("XAUUSD", "GC=F", "proxy"),
    ("US500", "^GSPC", "proxy"),
    ("000001", None, "unknown"),
    ("700", None, "unknown"),
    ("700.UNREVIEWED", None, "unknown"),
    ("XAUUSD+", None, "unknown"),
    ("ＦＩＣＴ", None, "unknown"),
    ("\u00a0FICT_SOURCE_A", None, "unknown"),
    ("FICT.UNKNOWN", "FICT.UNKNOWN", "exact"),
]

SHARED_OBSERVATION_VECTORS = [
    ("FICT_SOURCE_A", "FICT_SOURCE_A", "FICT_SOURCE_A", ["exact", "exact"]),
    ("GOLD", "GC=F", "GC=F", ["proxy", "exact"]),
    ("XAUUSD", "GOLD", "GC=F", ["proxy", "proxy"]),
    ("SH600519", "600519.SS", "600519.SS", ["venue_notation", "exact"]),
    ("700.HK", "0700.HK", "0700.HK", ["venue_notation", "venue_notation"]),
]


def main():
    directory = Path(__file__).parent
    old = json.loads((directory / "memory_bundle_v1.json").read_text(encoding="utf-8"))
    evidence = json.loads(
        (directory / "memory_evidence_bundle_v1.json").read_text(encoding="utf-8")
    )
    decision = old["decision_snapshot"]["decision"]
    text = old["decision_snapshot"]["artifacts"][decision["decision_text_sha256"]]["payload"]
    plan = make_target_evaluation_plan(
        analysis_date=decision["analysis_date"],
        instrument=decision["instrument"],
        benchmark=old["decision_snapshot"]["contract"]["resolved_benchmark"],
        research_started_at=decision["research_started_at"],
        holding_period_days=2,
        host_local_calendar_at_start=decision["analysis_calendar_date"],
        host_utc_offset=decision["host_utc_offset"],
    )
    with TemporaryDirectory(prefix="memory-target-fixture-") as temporary:
        store = MemoryStore(storage_dir=Path(temporary))
        prior = old["input_snapshot"]["decisions"][0]
        store.record_decision(prior)
        context = store.context_snapshot(
            decision["instrument"],
            old["input_snapshot"]["research_cutoff"],
            selected_at=old["input_snapshot"]["selected_at"],
            selector_version="recent-reflections-v2",
        )
        evidence["manifest"]["memory_input_sha256"] = context["context_sha256"]
        evidence["manifest"]["memory_target_binding_sha256"] = plan["target_binding"][
            "binding_sha256"
        ]
        evidence["manifest"] = deepcopy(evidence["manifest"])
        from tradingagents.memory.schema import hash_value

        evidence["manifest_sha256"] = hash_value(evidence["manifest"])
        evidence = make_component(evidence, "bundle_sha256")
        item = build_decision_snapshot(
            run_id=decision["run_id"],
            instrument=decision["instrument"],
            asset_type=decision["asset_type"],
            analysis_date=decision["analysis_date"],
            research_started_at=decision["research_started_at"],
            research_as_of=decision["research_as_of"],
            recorded_at=decision["recorded_at"],
            analysis_calendar_date=decision["analysis_calendar_date"],
            host_utc_offset=decision["host_utc_offset"],
            rating=decision["rating"],
            decision_text=text,
            contract=bind_evaluation_contract(plan, make_artifact("text", text)["sha256"]),
            evidence_bundle_sha256=evidence["bundle_sha256"],
        )
        store.record_decision(item)
        bundle = store.bundle(
            item["run_id"], context, evidence_bundle_sha256=evidence["bundle_sha256"]
        )

        def fictional_history(symbol, **_parameters):
            values = (
                [123.45678901234567, 125.0, 126.25]
                if symbol == decision["instrument"]
                else [200.0, 201.0, 202.0]
            )
            frame = pd.DataFrame(
                {
                    "Close": values,
                    "Adj Close": values,
                    "Dividends": [1e-07, 0.0, 0.0],
                    "Stock Splits": [1.0, 0.0, 0.0],
                },
                index=pd.bdate_range("2025-02-17", periods=3, tz="America/New_York"),
            )
            frame.attrs["currency"] = "USD"
            return frame

        result = evaluate_decision(
            item, observed_at="2025-02-25T18:00:00.000000Z", history_fetcher=fictional_history
        )
        available = store.attach_outcome(item["run_id"], result["outcome"], result["artifacts"])
        value = {
            "schema_version": 1,
            "fictional": True,
            "evidence": evidence,
            "bundle": bundle,
            "available_snapshot": available,
            "legacy_completed_snapshot": prior,
            "policy_artifact": policy_artifact(),
            "target_vectors": [
                {"requested_symbol": raw, "request_symbol": request, "relation": relation}
                for raw, request, relation in TARGET_VECTORS
            ],
            "shared_observation_vectors": [
                {
                    "instrument": instrument,
                    "benchmark": benchmark,
                    "request_symbol": request,
                    "relations": relations,
                    "physical_request_count": 1,
                    "equal_saved_source_bodies": True,
                    "return_difference": "0",
                }
                for instrument, benchmark, request, relations in SHARED_OBSERVATION_VECTORS
            ],
            "expected_reference": {
                "entry_date": "2025-02-17",
                "exit_date": "2025-02-19",
                "raw_return": "126.25 / 123.45678901234567 - 1",
            },
        }
        (directory / "memory_target_binding_v2.json").write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
