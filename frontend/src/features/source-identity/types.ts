export type IdentityAlignment = "consistent" | "conflict" | "unknown" | "proxy" | "not_applicable";
export type IdentityReason =
  | "effective_request_aligned"
  | "effective_request_conflict"
  | "effective_request_missing"
  | "effective_request_unusable"
  | "unqualified_venue"
  | "explicit_venue_conflict"
  | "unreviewed_identifier_relation"
  | "declared_proxy_reference"
  | "unexpected_selector_metadata"
  | "global_query_not_instrument_scoped"
  | "legacy_tool_scope_unknown";
export type ContentScope =
  | "single_instrument_requested_data"
  | "retrieval_context"
  | "identity_context"
  | "global_query"
  | "legacy_tool_scope_unknown";
export type SelectorAssessment = {
  content_scope: ContentScope;
  canonical_selector_key: "symbol" | "ticker" | null;
  canonical_alignment: IdentityAlignment;
  canonical_reason: IdentityReason;
  canonical_rule: string;
  record_alignment: IdentityAlignment;
  record_reason: IdentityReason;
  venue: "SH" | "SZ" | "HK" | null;
  unexpected_selector_keys: string[];
};
export type IdentityRecordAssessment = SelectorAssessment & {
  evidence_id: string;
  tool: string;
  sources: {
    source_index: number;
    provider: string;
    data_sha256: string | null;
    provider_request: "unknown";
    provider_entity: "unknown";
  }[];
};
export type EffectiveRequestIdentity = {
  schema_version: 1;
  scope: "saved_effective_outer_request_alignment";
  policy_version: "saved-effective-request-v1";
  policy_sha256: string;
  run_id: string;
  instrument: string;
  analysis_date: string;
  evidence_bundle_sha256: string;
  report_snapshot_sha256: string;
  reviewed_at: string;
  records: IdentityRecordAssessment[];
  summary: {
    record_count: number;
    source_count: number;
    consistent_count: number;
    conflict_count: number;
    unknown_count: number;
    proxy_count: number;
    not_applicable_count: number;
    unsafe_record_ids: string[];
  };
  assessment_sha256: string;
};
export type IdentityInvalidReason =
  | "malformed"
  | "hash_mismatch"
  | "reference_mismatch"
  | "unsafe_content"
  | "verification_unavailable";
export type IdentityValidation = { status: "invalid"; reason: IdentityInvalidReason };
export type IdentityFields = {
  effectiveRequestIdentity?: EffectiveRequestIdentity;
  identityValidation?: IdentityValidation;
};
