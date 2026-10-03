"""Connect frozen research inputs to durable, independently dated evaluations."""

from __future__ import annotations

import logging

from tradingagents.evidence import sanitize_diagnostic
from tradingagents.memory.evaluation import (
    bind_evaluation_contract,
    evaluate_decision,
    replay_evaluation,
)
from tradingagents.memory.schema import (
    build_decision_snapshot,
    make_artifact,
    make_component,
    instrument_key,
    now_utc,
    validate_bundle,
)
from tradingagents.memory.store import MemoryStore

logger = logging.getLogger(__name__)


class ResearchMemory:
    """Keep settlement and reflection separate so a model failure cannot lose facts."""

    def __init__(self, config, reflector, model_settings, *, secrets=()):
        self.store = MemoryStore(config.get("memory_log_path"))
        self.reflector = reflector
        self.model_settings = model_settings
        self.secrets = secrets

    def settle_pending(self, instrument):
        """Review at most five previous runs; legacy prose is never evaluated."""
        pending = [
            item
            for item in self.store.list_decisions()
            if instrument_key(item["decision"]["instrument"]) == instrument_key(instrument)
            and item["reflection"] is None
            and (item["outcome"] is None or item["outcome"]["status"] == "available")
        ]
        for snapshot in pending[:5]:
            try:
                self._settle(snapshot)
            except Exception as exc:  # noqa: BLE001 - prior review cannot invent a current result
                # Error bodies can contain source responses, prompts or private paths.
                logger.warning("Previous research review deferred (%s)", type(exc).__name__)

    def _settle(self, snapshot):
        run_id = snapshot["run_id"]
        if snapshot["outcome"] is None:
            result = evaluate_decision(snapshot)
            if result["outcome"] is None:
                return
            # This durable write completes before the model can observe the result.
            snapshot = self.store.attach_outcome(run_id, result["outcome"], result["artifacts"])
        if snapshot["outcome"]["status"] != "available" or snapshot["reflection"] is not None:
            return
        replay = replay_evaluation(snapshot)
        if replay["status"] != "available":
            return
        artifacts = snapshot["artifacts"]
        decision_text = artifacts[snapshot["decision"]["decision_text_sha256"]]["payload"]
        calculation = artifacts[snapshot["outcome"]["calculation_sha256"]]["payload"]
        messages = self.reflector.reference_reflection_messages(decision_text, calculation)
        # Save exactly the sanitized role/content input that is delivered to the model.
        messages = [
            (role, sanitize_diagnostic(content, secrets=self.secrets)) for role, content in messages
        ]
        prompt = make_artifact("text", self.reflector.reference_prompt_text(messages))
        settings = self.model_settings()
        context = make_artifact(
            "canonical_json",
            {
                key: settings.get(key)
                for key in (
                    "llm_provider",
                    "quick_think_llm",
                    "temperature",
                    "max_tokens",
                    "output_language",
                )
            },
        )
        response = self.reflector.invoke_reference_reflection(messages)
        if not isinstance(response, str) or not response.strip():
            raise ValueError("Research reflection did not produce usable text")
        response_artifact = make_artifact(
            "text", sanitize_diagnostic(response, secrets=self.secrets)
        )
        reflection = make_component(
            {
                "schema_version": 1,
                "outcome_sha256": snapshot["outcome"]["outcome_sha256"],
                "reflected_at": now_utc(),
                "model_context_sha256": context["sha256"],
                "prompt_sha256": prompt["sha256"],
                "response_sha256": response_artifact["sha256"],
            },
            "reflection_sha256",
        )
        self.store.attach_reflection(
            run_id,
            reflection,
            {item["sha256"]: item for item in (context, prompt, response_artifact)},
        )

    def record_final(self, final_state, evidence, rating):
        """Freeze completion only after both the decision and its bundle are saved."""
        frozen = final_state["research_memory"]
        run_id = evidence["run_id"]
        decision_text = sanitize_diagnostic(
            str(final_state.get("final_trade_decision") or ""), secrets=self.secrets
        )
        text_artifact = make_artifact("text", decision_text)
        contract = bind_evaluation_contract(frozen["evaluation_plan"], text_artifact["sha256"])
        manifest = evidence["manifest"]
        if (
            frozen["input_snapshot"]["context_sha256"] != manifest.get("memory_input_sha256")
            or contract["holding_period_days"] != manifest.get("holding_period_days")
            or contract["resolved_benchmark"] != manifest.get("benchmark_ticker")
            or contract["analysis_date"] != evidence["analysis_date"]
        ):
            raise ValueError("Research memory does not match the frozen evidence manifest")

        def bound_bundle(value):
            bundle = validate_bundle(value)
            snapshot = bundle["decision_snapshot"]
            decision = snapshot["decision"]
            if (
                bundle["run_id"] != run_id
                or bundle["instrument"] != evidence["instrument"]
                or bundle["analysis_date"] != evidence["analysis_date"]
                or bundle["evidence_bundle_sha256"] != evidence["bundle_sha256"]
                or bundle["input_snapshot"] != frozen["input_snapshot"]
                or decision["research_started_at"] != frozen["research_started_at"]
                or decision["research_as_of"] != evidence["research_as_of"]
                or decision["asset_type"] != final_state.get("asset_type", "stock")
                or decision["rating"] != rating
                or decision["decision_text_sha256"] != text_artifact["sha256"]
                or snapshot["contract"] != contract
            ):
                raise ValueError("Completed research memory does not match the frozen decision")
            return bundle

        if final_state.get("memory_bundle"):
            return bound_bundle(final_state["memory_bundle"])
        previous = self.store.load_decision(run_id)
        recorded_at = previous["decision"]["recorded_at"] if previous else now_utc()
        snapshot = build_decision_snapshot(
            run_id=run_id,
            instrument=evidence["instrument"],
            asset_type=final_state.get("asset_type", "stock"),
            analysis_date=evidence["analysis_date"],
            research_started_at=frozen["research_started_at"],
            research_as_of=evidence["research_as_of"],
            recorded_at=recorded_at,
            analysis_calendar_date=frozen["evaluation_plan"]["research_calendar_date"],
            host_utc_offset=frozen["evaluation_plan"]["host_utc_offset"],
            rating=rating,
            decision_text=decision_text,
            contract=contract,
            evidence_bundle_sha256=evidence["bundle_sha256"],
        )
        snapshot = self.store.record_decision(snapshot)
        if snapshot["outcome"] is None and contract["evaluation_mode"] == "not_evaluable":
            result = evaluate_decision(snapshot, observed_at=now_utc())
            if result["outcome"] is not None:
                self.store.attach_outcome(run_id, result["outcome"], result["artifacts"])
        return bound_bundle(
            self.store.bundle(
                run_id, frozen["input_snapshot"], evidence_bundle_sha256=evidence["bundle_sha256"]
            )
        )
