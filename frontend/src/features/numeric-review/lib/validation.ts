import type { EvidenceBundle } from "@/features/evidence/types";
import { sha256 } from "@/features/evidence/lib/validation";
import { clone, exact, hash } from "@/features/memory/lib/guards";
import type { NumericReview, ReportTextSnapshot } from "../types";
import { deriveReviewBody, requestFromReview } from "./derive";
import { fixed, requireNumeric, safeBounded, same } from "./guards";
import { assertPreparedNumericInput, prepareNumericInput, type PreparedNumericInput } from "./prepared";
export function copyNumericReview(value: unknown, snapshotValue: unknown, evidenceValue: unknown, owner?: {
    taskId: string;
    versionId: string;
}): NumericReview {
    return copyPreparedNumericReview(value, prepareNumericInput(snapshotValue, evidenceValue), owner);
}
/** Internal per-receipt checks against the one captured batch envelope. */
export function copyPreparedNumericReview(value: unknown, prepared: PreparedNumericInput, owner?: {
    taskId: string;
    versionId: string;
}): NumericReview {
    try {
        assertPreparedNumericInput(prepared);
        safeBounded(value);
        exact(value, ["schema_version", "review_id", "reviewed_at", "previous_review_sha256", "policy_version", "policy_sha256", "scope", "target", "numeric_span", "operand", "rounding", "context_bindings", "result", "review_sha256"]);
        exact(value.operand, ["evidence_id", "source_index", "provider", "data_sha256", "selector", "raw_number_lexeme"]);
        requireNumeric(hash(value.review_sha256));
        const { evidence, snapshot } = prepared, review = clone(value) as NumericReview;
        const { review_sha256: _hash, ...body } = review;
        void _hash;
        requireNumeric(same(body, deriveReviewBody(snapshot, evidence, requestFromReview(review), prepared)), "reference_mismatch");
        if (owner)
            requireNumeric(review.target.task_id === owner.taskId && review.target.version_id === owner.versionId, "reference_mismatch");
        return review;
    }
    catch (error) {
        return fixed(error);
    }
}
export async function verifyNumericReview(value: unknown, snapshotValue: unknown, evidenceValue: unknown, owner?: {
    taskId: string;
    versionId: string;
}) {
    const prepared = prepareNumericInput(snapshotValue, evidenceValue), review = copyPreparedNumericReview(value, prepared, owner);
    await prepared.verify();
    await prepared.verifyReceipt(review);
    return review;
}
export async function createNumericReview(snapshotValue: ReportTextSnapshot, evidenceValue: EvidenceBundle, request: unknown) {
    const prepared = prepareNumericInput(snapshotValue, evidenceValue), capturedRequest = clone(request);
    await prepared.verify();
    const body = deriveReviewBody(prepared.snapshot, prepared.evidence, capturedRequest, prepared);
    requireNumeric(body.target.section_utf8_sha256 === await prepared.sectionHash(body.target.section_key), "reference_mismatch");
    return { ...body, review_sha256: await sha256(body) };
}
