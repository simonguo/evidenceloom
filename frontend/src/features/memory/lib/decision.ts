import type { DecisionSnapshot, EvaluationContract, MemoryArtifact, MemoryBundle, ReviewAttachment } from "../types";
import { canonicalJson } from "@/features/evidence/lib/validation";
import { assert, bounded, clone, day, exact, hash, object, offset, parsePayload, stamp, text, timestamp, uuid, verifyHash } from "./guards";
import { copyTargetBinding } from "./targets";
import { targetPolicyArtifact } from "./target-policy";
import { assertTargetSubjects } from "./target-subjects";

const policies = {
  holding_period_unit: "common_complete_provider_daily_rows", policy_version: "common-daily-close-v1",
  entry_policy: "first_common_complete_date_after_recorded_source_and_utc_dates", exit_policy: "holding_count_common_row_transitions",
  alignment_policy: "identical_session_date_no_fill", session_policy: "provider_daily_rows_timezone_required",
  completion_policy: "date_elapsed_in_source_timezone_and_utc", price_basis: "provider_adjusted_close", return_policy: "simple_return_difference_no_fx",
};
const history = { interval: "1d", auto_adjust: false, back_adjust: false, actions: true, repair: false, rounding: false, keepna: true, prepost: false };

export function copyArtifact(value: unknown): MemoryArtifact {
  exact(value, ["kind", "payload", "sha256"]); assert(["text", "canonical_json"].includes(String(value.kind)) && text(value.payload) && hash(value.sha256));
  if (value.kind === "canonical_json") parsePayload(value.payload); else bounded(value);
  return clone(value) as MemoryArtifact;
}
function contract(value: unknown): EvaluationContract {
  assert(object(value));
  const version = value.schema_version;
  exact(value, ["schema_version", "analysis_date", "research_calendar_date", "host_utc_offset", "resolved_benchmark", "holding_period_days", "evaluation_mode", "not_evaluable_reason", "evaluator_version", "evaluator_code_sha256", "effective_history_parameters", "decision_text_sha256", "contract_sha256", ...Object.keys(policies), ...(version === 2 ? ["target_binding"] : [])]);
  assert((version === 1 || version === 2) && day(value.analysis_date) && day(value.research_calendar_date) && offset(value.host_utc_offset));
  assert(text(value.resolved_benchmark) && value.resolved_benchmark && text(value.evaluator_version) && value.evaluator_version && hash(value.evaluator_code_sha256) && hash(value.decision_text_sha256) && hash(value.contract_sha256));
  assert(typeof value.holding_period_days === "number" && Number.isInteger(value.holding_period_days) && value.holding_period_days >= 1 && value.holding_period_days <= 10000);
  assert(Object.entries(policies).every(([key, policy]) => value[key] === policy));
  exact(value.effective_history_parameters, Object.keys(history));
  assert(Object.entries(history).every(([key, expected]) => (value.effective_history_parameters as Record<string, unknown>)[key] === expected));
  assert(value.analysis_date <= value.research_calendar_date);
  let unknownTarget = false;
  if (version === 2) {
    const binding = copyTargetBinding(value.target_binding);
    assert(binding.targets[1].request_symbol === value.resolved_benchmark, "reference_mismatch");
    const sign = value.host_utc_offset.startsWith("-") ? -1 : 1;
    const [hours, minutes] = value.host_utc_offset.slice(1).split(":").map(Number);
    const local = new Date(Date.parse(binding.research_started_at) + sign * (hours * 60 + minutes) * 60_000);
    assert(Number.isFinite(local.getTime()) && local.toISOString().slice(0, 10) === value.research_calendar_date, "temporal_mismatch");
    unknownTarget = binding.targets.some((target) => target.relation === "unknown");
  }
  if (value.analysis_date < value.research_calendar_date) {
    assert(value.evaluation_mode === "not_evaluable" && value.not_evaluable_reason === "historical_decision_availability_unknown");
  } else if (unknownTarget) {
    assert(value.evaluation_mode === "not_evaluable" && value.not_evaluable_reason === "target_resolution_unknown");
  } else {
    assert(value.evaluation_mode === "prospective_reference" && value.not_evaluable_reason === null);
  }
  return value as unknown as EvaluationContract;
}

export function copyDecisionSnapshot(value: unknown): DecisionSnapshot {
  bounded(value);
  exact(value, ["schema_version", "run_id", "decision", "contract", "outcome", "reflection", "artifacts", "snapshot_sha256"]);
  assert(value.schema_version === 1 && uuid(value.run_id) && hash(value.snapshot_sha256));
  const frozen = contract(value.contract); const decision = value.decision;
  exact(decision, ["schema_version", "decision_id", "run_id", "instrument", "asset_type", "analysis_date", "research_started_at", "research_as_of", "recorded_at", "analysis_calendar_date", "host_utc_offset", "rating", "decision_text_sha256", "contract_sha256", "evidence_bundle_sha256", "decision_sha256"]);
  assert(decision.schema_version === 1 && decision.decision_id === value.run_id && decision.run_id === value.run_id && text(decision.instrument) && decision.instrument && text(decision.asset_type) && decision.asset_type);
  assert(day(decision.analysis_date) && day(decision.analysis_calendar_date) && timestamp(decision.research_started_at) && timestamp(decision.recorded_at) && timestamp(decision.research_as_of) && offset(decision.host_utc_offset));
  assert(stamp(decision.recorded_at) >= stamp(decision.research_started_at), "temporal_mismatch");
  assert(decision.research_as_of === `${decision.analysis_date}T23:59:59.999999Z`);
  const sign = decision.host_utc_offset.startsWith("-") ? -1 : 1;
  const [hours, minutes] = decision.host_utc_offset.slice(1).split(":").map(Number);
  const localDate = new Date(Date.parse(decision.research_started_at) + sign * (hours * 60 + minutes) * 60_000);
  assert(Number.isFinite(localDate.getTime()));
  const calendar = localDate.toISOString().slice(0, 10);
  assert(calendar === decision.analysis_calendar_date && decision.analysis_calendar_date === frozen.research_calendar_date && decision.host_utc_offset === frozen.host_utc_offset, "temporal_mismatch");
  assert(["Buy", "Overweight", "Hold", "Underweight", "Sell", "REVIEW"].includes(String(decision.rating)) && hash(decision.evidence_bundle_sha256) && hash(decision.decision_sha256));
  assert(decision.contract_sha256 === frozen.contract_sha256 && decision.decision_text_sha256 === frozen.decision_text_sha256 && decision.analysis_date === frozen.analysis_date, "reference_mismatch");
  if (frozen.schema_version === 2) {
    assert(frozen.target_binding.research_started_at === decision.research_started_at && frozen.target_binding.targets[0].requested_symbol === decision.instrument, "reference_mismatch");
  }
  assert(object(value.artifacts) && Object.keys(value.artifacts).length <= 16);
  const artifacts = value.artifacts; for (const [sha, artifact] of Object.entries(artifacts)) assert(hash(sha) && copyArtifact(artifact).sha256 === sha);
  const references = new Set<string>();
  const reference = (sha: unknown, kind: string) => { assert(hash(sha) && object(artifacts[sha]) && artifacts[sha].kind === kind, "reference_mismatch"); references.add(sha); return artifacts[sha] as unknown as MemoryArtifact; };
  assert(reference(decision.decision_text_sha256, "text").payload);
  if (frozen.schema_version === 2) {
    const policy = reference(frozen.target_binding.policy_artifact_sha256, "canonical_json");
    assert(canonicalJson(policy) === canonicalJson(targetPolicyArtifact), "reference_mismatch");
  }
  const outcome = value.outcome; const reflection = value.reflection;
  if (outcome !== null) {
    exact(outcome, ["schema_version", "contract_sha256", "observed_at", "status", "reason", "facts_sha256", "calculation_sha256", "outcome_sha256"]);
    assert(outcome.schema_version === 1 && timestamp(outcome.observed_at) && hash(outcome.outcome_sha256));
    assert(outcome.contract_sha256 === frozen.contract_sha256, "reference_mismatch");
    assert(stamp(outcome.observed_at) >= stamp(decision.recorded_at), "temporal_mismatch");
    if (outcome.status === "available") {
      assert(frozen.evaluation_mode === "prospective_reference" && outcome.reason === null);
      reference(outcome.facts_sha256, "canonical_json"); reference(outcome.calculation_sha256, "canonical_json");
    } else {
      assert(outcome.status === "not_evaluable" && typeof outcome.reason === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(outcome.reason) && outcome.calculation_sha256 === null && reflection === null);
      if (outcome.facts_sha256 !== null) reference(outcome.facts_sha256, "canonical_json");
      if (frozen.evaluation_mode === "not_evaluable") assert(outcome.reason === frozen.not_evaluable_reason);
    }
  }
  if (reflection !== null) {
    exact(reflection, ["schema_version", "outcome_sha256", "reflected_at", "model_context_sha256", "prompt_sha256", "response_sha256", "reflection_sha256"]);
    assert(reflection.schema_version === 1 && object(outcome) && outcome.status === "available" && reflection.outcome_sha256 === outcome.outcome_sha256 && timestamp(reflection.reflected_at) && hash(reflection.reflection_sha256), "reference_mismatch");
    assert(stamp(reflection.reflected_at) >= stamp(outcome.observed_at as string), "temporal_mismatch");
    reference(reflection.model_context_sha256, "canonical_json"); reference(reflection.prompt_sha256, "text"); assert(reference(reflection.response_sha256, "text").payload);
  }
  assert(references.size === Object.keys(artifacts).length);
  if (frozen.schema_version === 2) assertTargetSubjects(decision, frozen, outcome, artifacts);
  return clone(value) as unknown as DecisionSnapshot;
}

export async function verifyDecisionSnapshot(value: unknown): Promise<DecisionSnapshot> {
  const snapshot = copyDecisionSnapshot(value);
  const components: [unknown, string][] = [[snapshot, "snapshot_sha256"], [snapshot.decision, "decision_sha256"], [snapshot.contract, "contract_sha256"], ...Object.values(snapshot.artifacts).map((artifact): [unknown, string] => [artifact, "sha256"])];
  if (snapshot.contract.schema_version === 2) components.push([snapshot.contract.target_binding, "binding_sha256"]);
  if (snapshot.outcome) components.push([snapshot.outcome, "outcome_sha256"]);
  if (snapshot.reflection) components.push([snapshot.reflection, "reflection_sha256"]);
  await Promise.all(components.map(([component, key]) => verifyHash(component as Record<string, unknown>, key)));
  return snapshot;
}

export function copyReviewAttachment(value: unknown, completion?: MemoryBundle): ReviewAttachment {
  bounded(value); exact(value, ["schema_version", "decision_id", "reviewed_at", "snapshot", "attachment_sha256"]);
  assert(value.schema_version === 1 && uuid(value.decision_id) && timestamp(value.reviewed_at) && hash(value.attachment_sha256));
  const snapshot = copyDecisionSnapshot(value.snapshot); assert(snapshot.run_id === value.decision_id, "reference_mismatch");
  const times = [snapshot.decision.recorded_at, snapshot.outcome?.observed_at, snapshot.reflection?.reflected_at].filter((item): item is string => Boolean(item));
  assert(times.every((time) => stamp(time) <= stamp(value.reviewed_at as string)), "temporal_mismatch");
  if (completion) {
    const original = completion.decision_snapshot;
    assert(completion.run_id === snapshot.run_id && original.decision.decision_sha256 === snapshot.decision.decision_sha256 && original.contract.contract_sha256 === snapshot.contract.contract_sha256, "reference_mismatch");
    for (const key of ["outcome", "reflection"] as const) if (original[key]) assert(canonicalJson(original[key]) === canonicalJson(snapshot[key]), "reference_mismatch");
    for (const [sha, artifact] of Object.entries(original.artifacts)) assert(snapshot.artifacts[sha]?.sha256 === artifact.sha256, "reference_mismatch");
  }
  return clone(value) as unknown as ReviewAttachment;
}
export async function verifyReviewAttachment(value: unknown, completion?: MemoryBundle): Promise<ReviewAttachment> {
  const attachment = copyReviewAttachment(value, completion); await verifyDecisionSnapshot(attachment.snapshot);
  await verifyHash(attachment as unknown as Record<string, unknown>, "attachment_sha256"); return attachment;
}

export function assertReviewHistory(reviews: ReviewAttachment[]): void {
  for (let index = 0; index < reviews.length; index++) for (const other of reviews.slice(index + 1)) {
    const current = reviews[index];
    assertSnapshotCompatibility(current.snapshot, other.snapshot);
    const [earlier, later] = stamp(current.reviewed_at) <= stamp(other.reviewed_at) ? [current, other] : [other, current];
    if (stamp(earlier.reviewed_at) === stamp(later.reviewed_at)) assert(earlier.snapshot.snapshot_sha256 === later.snapshot.snapshot_sha256, "reference_mismatch");
    for (const key of ["outcome", "reflection"] as const) {
      if (current.snapshot[key] && other.snapshot[key]) assert(canonicalJson(current.snapshot[key]) === canonicalJson(other.snapshot[key]), "reference_mismatch");
      if (earlier.snapshot[key]) assert(canonicalJson(earlier.snapshot[key]) === canonicalJson(later.snapshot[key]), "reference_mismatch");
    }
  }
}

export function assertSnapshotCompatibility(first: DecisionSnapshot, second: DecisionSnapshot): void {
  assert(first.run_id === second.run_id && first.decision.decision_sha256 === second.decision.decision_sha256 && first.contract.contract_sha256 === second.contract.contract_sha256, "reference_mismatch");
  for (const key of ["outcome", "reflection"] as const) if (first[key] && second[key]) assert(canonicalJson(first[key]) === canonicalJson(second[key]), "reference_mismatch");
}
