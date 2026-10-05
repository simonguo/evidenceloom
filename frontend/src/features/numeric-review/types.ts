export type NumericInvalidReason = "malformed" | "hash_mismatch" | "reference_mismatch" | "unsafe_content" | "verification_unavailable";
export type NumericValidation = {
    status: "invalid";
    reason: NumericInvalidReason;
};
export type ReportTextSnapshot = {
    schema_version: 1;
    run_id: string;
    instrument: string;
    analysis_date: string;
    captured_at: string;
    evidence_bundle_sha256: string;
    report_sections: Record<string, string | null>;
    snapshot_sha256: string;
};
export type TextSpan = {
    start_byte: number;
    end_byte: number;
    text: string;
};
export type TableSelector = {
    kind: "table_cell";
    table_path: string[];
    row_date: string;
    field: string;
};
export type ContextKey = "instrument" | "row_date" | "units";
export type ContextBindings = Record<ContextKey, TextSpan | null>;
export type NumericReason = "value_match" | "value_mismatch" | "context_mismatch" | "context_missing" | "source_unavailable" | "source_withheld" | "table_missing" | "table_ambiguous" | "row_missing" | "row_ambiguous" | "field_missing" | "field_not_numeric" | "number_unsupported" | "selection_unsupported";
export type NumericResult = {
    status: "match" | "mismatch" | "missing" | "manual_inference";
    reason: NumericReason;
    rounded_decimal: string | null;
    context_results: Record<ContextKey, "unreviewed" | "match" | "mismatch" | "missing">;
    unreviewed_dimensions: string[];
    source_context: {
        instrument: string;
        row_date: string | null;
        units: string | null;
        provider: string;
        historical_availability: string;
        adjustments: string | null;
        transformations: string[];
    };
};
export type NumericReview = {
    schema_version: 1;
    review_id: string;
    reviewed_at: string;
    previous_review_sha256: string | null;
    policy_version: string;
    policy_sha256: string;
    scope: "selected_saved_numeric_field";
    target: {
        task_id: string;
        version_id: string;
        run_id: string;
        report_snapshot_sha256: string;
        section_key: string;
        section_utf8_sha256: string;
    };
    numeric_span: TextSpan;
    operand: {
        evidence_id: string;
        source_index: number;
        provider: string;
        data_sha256: string | null;
        selector: TableSelector;
        raw_number_lexeme: string | null;
    };
    rounding: {
        mode: "saved_decimal_half_up";
        places: number;
    };
    context_bindings: ContextBindings;
    result: NumericResult;
    review_sha256: string;
};
export type ReviewRequest = Omit<NumericReview, "schema_version" | "policy_version" | "policy_sha256" | "scope" | "result" | "review_sha256" | "operand"> & {
    operand: Pick<NumericReview["operand"], "evidence_id" | "source_index" | "selector">;
};
