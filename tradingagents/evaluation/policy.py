"""Normative scope of the selected frozen-claim evaluation oracle."""

from tradingagents.memory.schema import hash_value

FROZEN_CLAIM_EVALUATION_POLICY = {
    "schema_version": 1,
    "policy_version": "frozen-selected-claims-v1",
    "scope": "explicit_selected_frozen_report_claims",
    "hash_encoding": "python_parsed_canonical_json",
    "span_encoding": "original_utf8_half_open",
    "saved_field_policy": "saved-numeric-field-v1",
    "percent_formula": "100*(end-start)/start",
    "percent_fields": ["Close", "Adj Close"],
    "percent_operand_binding": "same_record_source_artifact_table_and_field",
    "percent_rounding": "exact_fraction_then_single_half_up",
    "percent_span_grammar": "whole_signed_ascii_number_including_exponent_then_percent",
    "max_decimal_places": 18,
    "max_cases": 32,
    "max_claims_per_case": 100,
    "max_total_claims": 1000,
    "label_strata": ["engineering", "independent_arithmetic"],
    "prediction_baseline": "retain_saved_field_review_then_manual_forecast",
    "external_expert_dimensions": [
        "semantic_support",
        "temporal_validity",
        "inference_classification",
        "abstention_appropriateness",
    ],
    "rounded_zero_sign": "positive",
    "date_comparison": "source_label_local_date_component_only",
    "statuses": ["MATCH", "MISMATCH", "MISSING", "MANUAL", "UNKNOWN_LEGACY"],
    "denominator": "all_declared_claims_in_input_order",
    "expert_status": "NOT_EVALUATED",
    "unreviewed_dimensions": [
        "surrounding_prose",
        "source_reliability",
        "provider_entity_identity",
        "historical_vintage",
        "currency_conversion",
        "exchange_calendar",
        "bar_completion",
        "corporate_action_method",
        "prediction",
        "causality",
    ],
}
POLICY_SHA256 = hash_value(FROZEN_CLAIM_EVALUATION_POLICY)
