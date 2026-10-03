import type { AnalystKey } from "@/lib/types";

export type ReadinessInvalidReason = "malformed" | "hash_mismatch" | "unsafe_content" | "reference_mismatch" | "temporal_mismatch" | "verification_unavailable";
export type ReadinessValidation = { status: "invalid"; reason: ReadinessInvalidReason };
export type ReadinessStatus = "ready" | "insufficient_evidence" | "review_required";
export type InputCheckStatus = "passed" | "missing" | "unavailable" | "partial" | "invalid" | "not_selected" | "unknown";
export const readinessReasons = [
  "historical_availability_unknown", "future_analysis_date", "market_not_selected", "missing_required_verification",
  "provider_unavailable", "empty_observations", "partial_observations", "unknown_source_provenance", "verification_quality_unknown",
  "invalid_ohlcv", "conflicting_daily_rows", "provisional_daily_rows", "unknown_bar_completion", "insufficient_indicator_history",
  "unsupported_indicator", "indicator_calculation_failed", "missing_selected_source", "unknown_price_basis", "unknown_price_vintage", "unknown_exchange_calendar", "stale_or_unknown_session_coverage", "price_basis_conflict", "source_withheld",
] as const;
export type ReadinessReason = typeof readinessReasons[number];
export type ResearchReadinessPolicy = {
  schema_version: 1;
  policy_version: "research-readiness-v1";
  selected_analysts: AnalystKey[];
  required_checks: string[];
  research_started_at: string;
  research_as_of: string;
  research_calendar_date: string;
  host_utc_offset: string;
  temporal_mode: "same_host_date" | "historical_date_only" | "future_date";
  max_tool_rounds: number;
  max_complete_row_age_days: 3;
  required_indicators: string[];
  policy_sha256: string;
};
export type ReadinessEvidenceInput = { record_id: string; output_sha256: string; data_sha256s: string[] };
export type InputCheck = { key: string; required: boolean; status: InputCheckStatus; reason_codes: ReadinessReason[]; evidence_ids: string[]; artifact_sha256s: string[] };
export type ResearchReadiness = {
  schema_version: 1;
  run_id: string;
  instrument: string;
  analysis_date: string;
  policy: ResearchReadinessPolicy;
  evidence_inputs: ReadinessEvidenceInput[];
  checks: InputCheck[];
  status: ReadinessStatus;
  recommendation_allowed: boolean;
  assessment_sha256: string;
};
export type ReadinessFields = { researchReadiness?: ResearchReadiness; readinessValidation?: ReadinessValidation };
