import type { EvidenceBundle } from "@/features/evidence/types";
import { copyEvidenceBundle, sha256 } from "@/features/evidence/lib/validation";
import { clone, exact, hash } from "@/features/memory/lib/guards";
import type { NumericReview, ReportTextSnapshot } from "../types";
import { deriveReviewBody, requestFromReview } from "./derive";
import { checkHash, fixed, requireNumeric, safeBounded, same, utf8Sha } from "./guards";
import { numericPolicy, numericPolicyHash } from "./policy";
import { copyReportTextSnapshot, verifyReportTextSnapshot } from "./snapshot";
export function copyNumericReview(value: unknown, snapshotValue: unknown, evidenceValue: unknown, owner?: {
    taskId: string;
    versionId: string;
}): NumericReview {
    try {
        safeBounded(value);
        exact(value, ["schema_version", "review_id", "reviewed_at", "previous_review_sha256", "policy_version", "policy_sha256", "scope", "target", "numeric_span", "operand", "rounding", "context_bindings", "result", "review_sha256"]);
        exact(value.operand, ["evidence_id", "source_index", "provider", "data_sha256", "selector", "raw_number_lexeme"]);
        requireNumeric(hash(value.review_sha256));
        const evidence = copyEvidenceBundle(evidenceValue), snapshot = copyReportTextSnapshot(snapshotValue, evidence), review = clone(value) as NumericReview;
        const { review_sha256: _hash, ...body } = review;
        void _hash;
        requireNumeric(same(body, deriveReviewBody(snapshot, evidence, requestFromReview(review))), "reference_mismatch");
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
    const review = copyNumericReview(value, snapshotValue, evidenceValue, owner), snapshot = await verifyReportTextSnapshot(clone(snapshotValue), clone(evidenceValue));
    await checkHash(review as unknown as Record<string, unknown>, "review_sha256");
    requireNumeric(await sha256(numericPolicy) === numericPolicyHash && review.target.section_utf8_sha256 === await utf8Sha(snapshot.report_sections[review.target.section_key]!), "reference_mismatch");
    return review;
}
export async function createNumericReview(snapshotValue: ReportTextSnapshot, evidenceValue: EvidenceBundle, request: unknown) {
    const evidence = clone(evidenceValue), snapshot = await verifyReportTextSnapshot(clone(snapshotValue), evidence), body = deriveReviewBody(snapshot, evidence, clone(request));
    requireNumeric(body.target.section_utf8_sha256 === await utf8Sha(snapshot.report_sections[body.target.section_key]!), "reference_mismatch");
    return { ...body, review_sha256: await sha256(body) };
}
