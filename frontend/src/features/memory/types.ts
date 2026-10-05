export type MemoryArtifact = { kind: "text" | "canonical_json"; payload: string; sha256: string };
type EvaluationContractFields = {
  analysis_date: string; research_calendar_date: string; host_utc_offset: string;
  resolved_benchmark: string; holding_period_days: number; holding_period_unit: string;
  evaluation_mode: "prospective_reference" | "not_evaluable"; not_evaluable_reason: string | null;
  policy_version: string; evaluator_version: string; evaluator_code_sha256: string;
  entry_policy: string; exit_policy: string; alignment_policy: string; session_policy: string;
  completion_policy: string; price_basis: string; return_policy: string;
  effective_history_parameters: Record<string, string | boolean>; decision_text_sha256: string; contract_sha256: string;
};
export type EvaluationTarget = {
  role: "instrument" | "benchmark";
  requested_symbol: string;
  request_symbol: string | null;
  relation: "exact" | "venue_notation" | "pair_notation" | "proxy" | "unknown";
};
export type EvaluationTargetBinding = {
  schema_version: 1;
  research_started_at: string;
  provider: "yfinance";
  request_namespace: "yahoo_finance_ticker";
  adapter_id: "yfinance-ticker-history-direct-v1";
  adapter_code_sha256: string;
  resolver_code_sha256: string;
  policy_version: "yahoo-evaluation-target-v1";
  policy_artifact_sha256: string;
  targets: [EvaluationTarget, EvaluationTarget];
  binding_sha256: string;
};
export type EvaluationContractV1 = EvaluationContractFields & { schema_version: 1 };
export type EvaluationContractV2 = EvaluationContractFields & {
  schema_version: 2;
  target_binding: EvaluationTargetBinding;
};
export type EvaluationContract = EvaluationContractV1 | EvaluationContractV2;
export type MemoryDecision = {
  schema_version: 1; decision_id: string; run_id: string; instrument: string; asset_type: string;
  analysis_date: string; research_started_at: string; research_as_of: string; recorded_at: string;
  analysis_calendar_date: string; host_utc_offset: string; rating: string; decision_text_sha256: string;
  contract_sha256: string; evidence_bundle_sha256: string; decision_sha256: string;
};
export type MemoryOutcome = {
  schema_version: 1; contract_sha256: string; observed_at: string; status: "available" | "not_evaluable";
  reason: string | null; facts_sha256: string | null; calculation_sha256: string | null; outcome_sha256: string;
};
export type MemoryReflection = {
  schema_version: 1; outcome_sha256: string; reflected_at: string; model_context_sha256: string;
  prompt_sha256: string; response_sha256: string; reflection_sha256: string;
};
export type DecisionSnapshot = {
  schema_version: 1; run_id: string; decision: MemoryDecision; contract: EvaluationContract;
  outcome: MemoryOutcome | null; reflection: MemoryReflection | null;
  artifacts: Record<string, MemoryArtifact>; snapshot_sha256: string;
};
export type ContextSnapshot = {
  schema_version: 1; instrument: string; selected_at: string; research_cutoff: string; availability_cutoff: string;
  selector_version: "recent-reflections-v1" | "recent-reflections-v2"; same_ticker_limit: number; cross_ticker_limit: number;
  decisions: DecisionSnapshot[]; context_artifact: MemoryArtifact; raw_text_sha256: string;
  context_sha256: string; input_sha256: string;
};
export type MemoryBundle = {
  schema_version: 1; run_id: string; instrument: string; analysis_date: string; evidence_bundle_sha256: string;
  persistence_status: "durable" | "memory_only"; input_snapshot: ContextSnapshot;
  decision_snapshot: DecisionSnapshot; bundle_sha256: string;
};
export type ReviewAttachment = {
  schema_version: 1; decision_id: string; reviewed_at: string; snapshot: DecisionSnapshot; attachment_sha256: string;
};
export type MemoryInvalidReason = "malformed" | "hash_mismatch" | "unsafe_content" | "reference_mismatch" | "temporal_mismatch" | "verification_unavailable";
export type MemoryValidation = { status: "invalid"; reason: MemoryInvalidReason };
export type MemoryInventory = {
  type: "memory_inventory"; schema_version: 1; requested_ids: string[]; reviews: ReviewAttachment[];
  missing_ids: string[]; timestamp?: string;
};
export type MemoryFields = { memoryBundle?: MemoryBundle; memoryValidation?: MemoryValidation; evaluationReviews: ReviewAttachment[] };
