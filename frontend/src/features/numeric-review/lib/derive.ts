import { clone, exact, hash, stamp, text, timestamp, uuid } from "@/features/memory/lib/guards";
import type { EvidenceBundle } from "@/features/evidence/types";
import type { NumericResult, NumericReview, ReportTextSnapshot, ReviewRequest, TextSpan } from "../types";
import { parseDecimal, roundedDecimal, decimalEqual } from "./decimal";
import { fixed, requireNumeric, rawBytes, safeBounded, same } from "./guards";
import { contextKeys, numericPolicy, numericPolicyHash, sectionKeys } from "./policy";
import { selectedSource, dateComponent } from "./source";
import { fullLiteral, fullNumber, spanText } from "./spans";
export function validateSpan(value: unknown): asserts value is TextSpan {
    exact(value, ["start_byte", "end_byte", "text"]);
    requireNumeric(Number.isSafeInteger(value.start_byte) && Number.isSafeInteger(value.end_byte) && (value.start_byte as number) >= 0 && (value.end_byte as number) > (value.start_byte as number) && text(value.text));
}
export function copyRequest(value: unknown, snapshot: ReportTextSnapshot): ReviewRequest {
    try {
        safeBounded(value);
        exact(value, ["review_id", "reviewed_at", "previous_review_sha256", "target", "numeric_span", "operand", "rounding", "context_bindings"]);
        requireNumeric(uuid(value.review_id) && timestamp(value.reviewed_at) && /\.[0-9]{6}Z$/.test(value.reviewed_at) && stamp(value.reviewed_at) >= stamp(snapshot.captured_at) && (value.previous_review_sha256 === null || hash(value.previous_review_sha256)));
        exact(value.target, ["task_id", "version_id", "run_id", "report_snapshot_sha256", "section_key", "section_utf8_sha256"]);
        for (const key of ["task_id", "version_id"])
            requireNumeric(text(value.target[key]) && value.target[key] && rawBytes(value.target[key] as string).length <= 256);
        requireNumeric(value.target.run_id === snapshot.run_id && value.target.report_snapshot_sha256 === snapshot.snapshot_sha256 && sectionKeys.includes(String(value.target.section_key)) && hash(value.target.section_utf8_sha256), "reference_mismatch");
        const section = snapshot.report_sections[value.target.section_key as string];
        requireNumeric(typeof section === "string", "reference_mismatch");
        validateSpan(value.numeric_span);
        spanText(section, value.numeric_span);
        exact(value.operand, ["evidence_id", "source_index", "selector"]);
        requireNumeric(typeof value.operand.evidence_id === "string" && /^ev-[a-f0-9]{32}$/.test(value.operand.evidence_id) && Number.isSafeInteger(value.operand.source_index) && (value.operand.source_index as number) >= 0 && (value.operand.source_index as number) < 1024);
        exact(value.operand.selector, ["kind", "table_path", "row_date", "field"]);
        const selector = value.operand.selector;
        requireNumeric(selector.kind === "table_cell" && numericPolicy.table_paths.some((path) => same(path, selector.table_path)));
        for (const key of ["row_date", "field"])
            requireNumeric(text(value.operand.selector[key]) && value.operand.selector[key] && rawBytes(value.operand.selector[key] as string).length <= 256);
        exact(value.rounding, ["mode", "places"]);
        requireNumeric(value.rounding.mode === numericPolicy.rounding_mode && Number.isSafeInteger(value.rounding.places) && (value.rounding.places as number) >= 0 && (value.rounding.places as number) <= numericPolicy.max_decimal_places);
        exact(value.context_bindings, [...contextKeys]);
        for (const context of Object.values(value.context_bindings))
            if (context !== null) {
                validateSpan(context);
                spanText(section, context);
            }
        return clone(value) as ReviewRequest;
    }
    catch (error) {
        return fixed(error);
    }
}
export function requestFromReview(review: NumericReview): ReviewRequest {
    return { review_id: review.review_id, reviewed_at: review.reviewed_at, previous_review_sha256: review.previous_review_sha256, target: clone(review.target), numeric_span: clone(review.numeric_span), operand: { evidence_id: review.operand.evidence_id, source_index: review.operand.source_index, selector: clone(review.operand.selector) }, rounding: clone(review.rounding), context_bindings: clone(review.context_bindings) };
}
export function deriveReviewBody(snapshot: ReportTextSnapshot, evidence: EvidenceBundle, value: unknown): Omit<NumericReview, "review_sha256"> {
    const request = copyRequest(value, snapshot), section = snapshot.report_sections[request.target.section_key]!;
    const source = selectedSource(request, evidence), contexts: NumericResult["context_results"] = { instrument: "unreviewed", row_date: "unreviewed", units: "unreviewed" };
    const expectedContext = { instrument: snapshot.instrument, row_date: dateComponent(source.context.row_date), units: source.context.units };
    for (const key of contextKeys) {
        const binding = request.context_bindings[key];
        contexts[key] = binding === null ? "unreviewed" : expectedContext[key] === null || !fullLiteral(section, binding) ? "missing" : binding.text === expectedContext[key] ? "match" : "mismatch";
    }
    const supported = fullNumber(section, request.numeric_span), selected = request.numeric_span.text;
    let lexeme = source.lexeme, reason = source.reason;
    if (lexeme !== null && !parseDecimal(lexeme)) {
        lexeme = null;
        reason = "number_unsupported";
    }
    const rounded = lexeme === null ? null : roundedDecimal(lexeme, request.rounding.places);
    const comparable = supported && parseDecimal(selected) !== null && rounded !== null;
    let status: NumericResult["status"], resultReason: NumericResult["reason"];
    if (Object.values(contexts).includes("mismatch")) {
        status = "mismatch";
        resultReason = "context_mismatch";
    }
    else if (comparable && !decimalEqual(selected, rounded)) {
        status = "mismatch";
        resultReason = "value_mismatch";
    }
    else if (Object.values(contexts).includes("missing")) {
        status = "missing";
        resultReason = "context_missing";
    }
    else if (reason && reason !== "number_unsupported") {
        status = "missing";
        resultReason = reason;
    }
    else if (!supported) {
        status = "manual_inference";
        resultReason = "selection_unsupported";
    }
    else if (!comparable) {
        status = "manual_inference";
        resultReason = "number_unsupported";
    }
    else {
        status = "match";
        resultReason = "value_match";
    }
    return { schema_version: 1, ...request, operand: { ...request.operand, provider: source.context.provider, data_sha256: source.dataHash, raw_number_lexeme: lexeme }, policy_version: numericPolicy.policy_version, policy_sha256: numericPolicyHash, scope: "selected_saved_numeric_field", result: { status, reason: resultReason, rounded_decimal: rounded, context_results: contexts, unreviewed_dimensions: [...numericPolicy.unreviewed_dimensions, ...contextKeys.filter((key) => ["unreviewed", "missing"].includes(contexts[key]))], source_context: source.context } };
}
