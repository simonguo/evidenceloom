"""Research input durability, replay and integrity acceptance cases."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import pytest

from tradingagents.evidence import (
    EvidenceLedger,
    EvidencePersistenceError,
    EvidenceSourceError,
    analyst_evidence,
    audit_citations,
    capture_evidence,
    current_ledger,
    merge_evidence_bundles,
    observe_attempt,
    observe_source,
    validate_evidence_bundle,
)
from tradingagents.evidence import ledger as module


@pytest.mark.parametrize(
    "url",
    [
        "https://0x7f.1/private",
        "https://0x7f.0.0.1/private",
        "https://0x7f.1./private",
        "https://0177.0.0.1/private",
        "https://127.1/private",
        "https://internal.local./private",
        "https://gateway.internal./private",
        "https://bücher.example/data",
        "https://%30x7f.1/private",
    ],
)
def test_noncanonical_or_local_hosts_are_withheld_before_evidence_capture(url):
    from tradingagents.evidence import sanitize_diagnostic
    from tradingagents.memory.schema import MemoryValidationError, make_artifact

    assert sanitize_diagnostic(url) == "[private URL withheld]"
    with pytest.raises(MemoryValidationError):
        make_artifact("text", url)


@pytest.mark.parametrize(
    "url",
    [
        "https://123.example.com/data",
        "https://0xbeef.example.com/data",
        "https://xn--bcher-kva.example/data",
    ],
)
def test_public_ascii_hosts_preserve_the_exact_source_url(url):
    from tradingagents.evidence import sanitize_diagnostic
    from tradingagents.memory.schema import make_artifact

    assert sanitize_diagnostic(url) == url
    assert make_artifact("text", url)["payload"] == url


def new_ledger(tmp_path, **kwargs):
    return EvidenceLedger(
        "EVDM.TEST", "2025-02-14", {"temperature": 0.2, "analysts": ["market"]}, tmp_path, **kwargs
    )


def capture(ledger, text="close=123.46", *, analyst="market", parameters=None):
    with ledger.bind(), analyst_evidence(analyst):

        def source():
            observe_attempt("tencent", "available", 3.8)
            observe_source(
                "tencent",
                url="https://example.com/quote?apikey=secret#fragment",
                normalized_data={"close": 123.45678901234567, "tiny": 1e-7, "integral": 1.0},
                observed_window={"start": "2025-02-13", "end": "2025-02-14"},
            )
            return text

        return capture_evidence(
            "get_stock_data",
            parameters or {"symbol": "EVDM.TEST", "end_date": "2025-02-14"},
            source,
        )


def test_exact_input_full_precision_and_cross_language_safe_envelope(tmp_path):
    ledger = new_ledger(tmp_path)
    model_input = capture(ledger)
    bundle = ledger.bundle()
    record = bundle["records"][0]
    assert bundle["manifest"]["temperature"] == "0.2"
    assert bundle["artifacts"][record["output_sha256"]]["payload"] == model_input
    assert model_input.startswith(f"[E:{record['id']}]\n")
    source = record["sources"][0]
    assert source["url"] == "https://example.com/quote"
    assert source["historical_availability"] == "unknown"
    original = bundle["artifacts"][source["data_sha256"]]["payload"]
    assert "123.45678901234567" in original
    assert "1e-07" in original
    assert json.loads(original)["integral"] == 1.0
    assert record["attempts"][0]["elapsed_ms"] == 3
    saved = json.loads((tmp_path / bundle["run_id"] / "bundle.json").read_text())
    assert saved == bundle


def test_no_context_keeps_embedded_api_unchanged():
    assert current_ledger() is None
    assert capture_evidence("legacy arbitrary tool", {}, lambda: "unmodified") == "unmodified"
    observe_source("unregistered", normalized_data=object())
    observe_attempt("unregistered", "unregistered")


def test_repeated_calls_keep_distinct_ids_and_deduplicate_normalized_data(tmp_path):
    ledger = new_ledger(tmp_path)
    assert capture(ledger) != capture(ledger)
    bundle = ledger.bundle()
    assert len(bundle["records"]) == 2
    assert len(bundle["artifacts"]) == 3
    assert len({r["id"] for r in bundle["records"]}) == 2


def test_replay_only_uncheckpointed_captures_and_preserve_sequence(tmp_path):
    ledger = new_ledger(tmp_path)
    committed = capture(ledger, "committed")
    checkpoint = ledger.bundle()
    first, second = capture(ledger, "pending first"), capture(ledger, "pending second")
    restored = EvidenceLedger.restore(checkpoint, tmp_path)
    with restored.bind(), analyst_evidence("market"):

        def forbidden():
            raise AssertionError("Pending evidence must replay without retrieval")

        params = {"symbol": "EVDM.TEST", "end_date": "2025-02-14"}
        assert capture_evidence("get_stock_data", params, forbidden) == first
        assert capture_evidence("get_stock_data", params, forbidden) == second
    assert committed not in {first, second}
    new = capture(restored, "genuinely new identical request")
    assert new not in {committed, first, second}
    assert len(restored.bundle()["records"]) == 4


def test_atomic_failure_stops_delivery_and_preserves_previous_bundle(tmp_path, monkeypatch):
    ledger = new_ledger(tmp_path)
    capture(ledger)
    before = ledger.bundle()

    def reject(*args):
        raise OSError("/Users/private/path contains secret")

    monkeypatch.setattr(module.os, "replace", reject)
    with pytest.raises(EvidencePersistenceError, match="stopped before using this source") as exc:
        capture(ledger, "should not reach model")
    assert "private" not in str(exc.value)
    assert ledger.bundle() == before
    assert json.loads((tmp_path / before["run_id"] / "bundle.json").read_text()) == before
    assert {p.name for p in (tmp_path / before["run_id"]).iterdir()} == {"bundle.json", ".lock"}


@pytest.mark.parametrize(
    "mutation", ["artifact", "manifest", "record", "extra", "url", "reference"]
)
def test_corruption_is_rejected_without_silent_repair(tmp_path, mutation):
    ledger = new_ledger(tmp_path)
    capture(ledger)
    bundle = ledger.bundle()
    record = bundle["records"][0]
    if mutation == "artifact":
        bundle["artifacts"][record["output_sha256"]]["payload"] += " altered"
    elif mutation == "manifest":
        bundle["manifest"]["temperature"] = "0.8"
    elif mutation == "record":
        record["instrument"] = "DIFFERENT"
    elif mutation == "extra":
        record["raw_error"] = "private source response"
    elif mutation == "url":
        record["sources"][0]["url"] = "http://127.0.0.1/private?api_key=secret"
    else:
        record["sources"][0]["data_sha256"] = "0" * 64
    module._rehash(bundle)
    with pytest.raises(ValueError, match="corrupted research evidence"):
        validate_evidence_bundle(bundle)


def test_disk_corruption_prevents_resume(tmp_path):
    ledger = new_ledger(tmp_path)
    checkpoint = ledger.bundle()
    capture(ledger)
    path = tmp_path / checkpoint["run_id"] / "bundle.json"
    disk = json.loads(path.read_text())
    disk["manifest"]["temperature"] = "9"
    path.write_text(json.dumps(disk))
    with pytest.raises(ValueError):
        EvidenceLedger.restore(checkpoint, tmp_path)


def test_private_projection_and_concurrent_run_isolation(tmp_path):
    a, b = new_ledger(tmp_path), new_ledger(tmp_path)

    def work(ledger, analyst):
        return capture(ledger, f"source for {analyst}", analyst=analyst)

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = [
            executor.submit(work, a, "market"),
            executor.submit(work, a, "news"),
            executor.submit(work, b, "social"),
        ]
        outputs = [f.result() for f in futures]
    assert len(set(outputs)) == 3
    assert {r["analyst"] for r in a.bundle()["records"]} == {"market", "news"}
    assert {r["analyst"] for r in b.bundle()["records"]} == {"social"}
    projected = a.bundle(analyst="market")
    assert len(projected["records"]) == 1
    joined = merge_evidence_bundles(projected, a.bundle(analyst="news"))
    assert joined["artifacts"] == a.bundle()["artifacts"]
    projected["records"].clear()
    assert len(a.bundle()["records"]) == 2
    with pytest.raises(ValueError, match="different frozen run"):
        merge_evidence_bundles(a.bundle(), b.bundle())


def test_conflicting_record_id_is_rejected(tmp_path):
    ledger = new_ledger(tmp_path)
    capture(ledger)
    first = ledger.bundle()
    other = deepcopy(first)
    other["records"][0]["parameters"]["limit"] = 2
    module._rehash(other)
    with pytest.raises(ValueError, match="Conflicting immutable"):
        merge_evidence_bundles(first, other)


def test_future_observations_never_reach_model_as_valid_input(tmp_path):
    ledger = new_ledger(tmp_path)
    with ledger.bind(), analyst_evidence("news"):

        def source():
            observe_source(
                "yfinance",
                normalized_data={"future_fact": "not available yet"},
                publication_dates=["2025-02-15T00:00:00Z"],
                historical_availability="within_as_of",
            )
            return "tomorrow future fact"

        result = capture_evidence("get_news", {"ticker": "EVDM.TEST"}, source)
    assert "future fact" not in result
    record = ledger.bundle()["records"][0]
    assert record["status"] == "withheld"
    assert record["sources"][0]["historical_availability"] == "withheld"
    assert record["sources"][0]["data_sha256"] is None


def test_unknown_metadata_and_missing_citations_remain_explicit(tmp_path):
    ledger = new_ledger(tmp_path)
    model_input = capture(ledger)
    evidence_id = ledger.bundle()["records"][0]["id"]
    bundle = ledger.bundle(
        reports={
            "market_report": f"Based on {model_input.splitlines()[0]} plus [E:missing-id]",
            "final_trade_decision": "No evidence citation present",
        }
    )
    audit = bundle["citation_audit"]
    assert audit["market_report"] == {
        "referenced_ids": [evidence_id, "missing-id"],
        "unresolved_ids": ["missing-id"],
        "status": "unresolved",
    }
    assert audit["final_trade_decision"]["status"] == "none"
    assert "factual_support" not in json.dumps(bundle)
    restored = EvidenceLedger.restore(bundle, tmp_path)
    assert restored.bundle() == bundle
    assert (
        audit_citations(bundle, {"market_report": f"[E:{evidence_id}]"})["citation_audit"][
            "market_report"
        ]["status"]
        == "resolved"
    )


def test_secrets_private_endpoints_paths_and_raw_envelopes_are_excluded(tmp_path):
    secret = "credential-only-in-memory"
    shaped_key = "sk-" + "a" * 32
    ledger = new_ledger(tmp_path, secrets=(secret,))
    text = capture(
        ledger,
        f"API_KEY={secret} https://user:password@example.com/public?api_key={secret} http://127.0.0.1/private /Users/person/private/file {shaped_key}",
    )
    with ledger.bind():

        def source():
            observe_source(
                "reddit",
                url="http://192.168.1.10/private",
                normalized_data={
                    "title": "safe",
                    "api_key": secret,
                    "headers": {"Authorization": secret},
                },
            )
            return "safe"

        capture_evidence(
            "fetch_reddit_posts", {"ticker": "EVDM.TEST", "backend_url": secret}, source
        )
    serialized = json.dumps(ledger.bundle())
    for prohibited in (
        secret,
        "user:password",
        "127.0.0.1",
        "/Users/person",
        shaped_key,
        "192.168.1.10",
        "Authorization",
    ):
        assert prohibited not in text
        assert prohibited not in serialized
    assert "backend_url" not in serialized


def test_committed_fixture_matches_core_hashes():
    fixture = Path(__file__).parent / "fixtures" / "evidence_bundle_v1.json"
    bundle = json.loads(fixture.read_text())
    assert validate_evidence_bundle(bundle) == bundle
    for digest, artifact in bundle["artifacts"].items():
        assert hashlib.sha256(module._canonical(artifact).encode()).hexdigest() == digest


def test_resume_redacts_current_environment_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "opaque-current-credential")
    monkeypatch.setenv("GITHUB_TOKEN", "opaque-current-session-token")
    ledger = new_ledger(tmp_path)
    restored = EvidenceLedger.restore(ledger.bundle(), tmp_path)
    output = capture(
        restored, "opaque-current-credential opaque-current-session-token Bearer opaque-auth-value"
    )
    assert "opaque-current-credential" not in output
    assert "opaque-current-credential" not in json.dumps(restored.bundle())
    assert "opaque-current-session-token" not in output
    assert "opaque-auth-value" not in output


def test_source_exception_never_exposes_raw_body_or_endpoint(tmp_path):
    ledger = new_ledger(tmp_path)
    with ledger.bind(), analyst_evidence("market"):

        def bad_source():
            raise RuntimeError("opaque credential https://user:password@127.0.0.1/private")

        with pytest.raises(EvidenceSourceError) as exc:
            capture_evidence("get_stock_data", {}, bad_source)
    assert "opaque" not in str(exc.value)
    assert "127.0.0.1" not in str(exc.value)
    assert ledger.bundle()["records"][0]["status"] == "unavailable"


def test_explicit_withheld_values_do_not_reach_model_or_invent_dates(tmp_path):
    ledger = new_ledger(tmp_path)
    with ledger.bind():

        def source():
            observe_source(
                "yfinance",
                normalized_data={"live_price": 98765},
                historical_availability="withheld",
            )
            return "private live price 98765"

        output = capture_evidence("get_fundamentals", {}, source)
    assert "98765" not in output
    assert "dates exceed" not in output
    assert "historical source availability is not established" in output
    record = ledger.bundle()["records"][0]
    assert record["status"] == "withheld"
    assert record["sources"][0]["publication_dates"] is None


@pytest.mark.parametrize("value", [1, [], {}, True])
def test_malformed_run_ids_fail_with_safe_value_error(tmp_path, value):
    bundle = new_ledger(tmp_path).bundle()
    bundle["run_id"] = value
    with pytest.raises(ValueError, match="Invalid or corrupted"):
        validate_evidence_bundle(bundle)


def test_unsafe_manifest_keys_are_rejected_even_with_recomputed_hash(tmp_path):
    bundle = new_ledger(tmp_path).bundle()
    bundle["manifest"]["data_vendors"] = {"https://user:password@127.0.0.1/private": "yfinance"}
    bundle["manifest_sha256"] = module._sha(bundle["manifest"])
    module._rehash(bundle)
    with pytest.raises(ValueError):
        validate_evidence_bundle(bundle)


@pytest.mark.parametrize("bad", ["[E:ev-bad!]", "[E:with spaces]", "[E:]", "[E:unclosed"])
def test_malformed_citations_cannot_disappear_next_to_valid_reference(tmp_path, bad):
    ledger = new_ledger(tmp_path)
    capture(ledger)
    evidence_id = ledger.bundle()["records"][0]["id"]
    bundle = audit_citations(ledger.bundle(), {"market_report": f"[E:{evidence_id}] {bad}"})
    assert bundle["citation_audit"]["market_report"]["status"] == "unresolved"
    assert bundle["citation_audit"]["market_report"]["unresolved_ids"] == ["invalid-citation"]
