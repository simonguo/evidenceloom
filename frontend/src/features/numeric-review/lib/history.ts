import type { AnalysisTask, ReportVersion } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import { clone, stamp } from "@/features/memory/lib/guards";
import type { NumericReview, ReportTextSnapshot } from "../types";
import { numericPolicy } from "./policy";
import { requireNumeric, same } from "./guards";
import { copyPreparedNumericReview } from "./validation";
import { prepareNumericInput, type PreparedNumericInput } from "./prepared";
export function copyNumericHistory(value: unknown, snapshot: ReportTextSnapshot, evidence: EvidenceBundle, owner: {
    taskId: string;
    versionId: string;
}): NumericReview[] {
    requireNumeric(Array.isArray(value) && value.length <= numericPolicy.max_reviews_per_version);
    return copyPreparedHistory(value, prepareNumericInput(snapshot, evidence), owner);
}
function copyPreparedHistory(value: unknown, prepared: PreparedNumericInput, owner: {
    taskId: string;
    versionId: string;
}): NumericReview[] {
    requireNumeric(Array.isArray(value) && value.length <= numericPolicy.max_reviews_per_version);
    const seen = new Set<string>();
    let previous: NumericReview | undefined;
    return value.map((item) => {
        const review = copyPreparedNumericReview(item, prepared, owner);
        requireNumeric(!seen.has(review.review_id) && review.previous_review_sha256 === (previous?.review_sha256 ?? null) && (!previous || stamp(review.reviewed_at) >= stamp(previous.reviewed_at)), "reference_mismatch");
        seen.add(review.review_id);
        previous = review;
        return review;
    });
}
export async function verifyNumericHistory(value: unknown, snapshot: ReportTextSnapshot, evidence: EvidenceBundle, owner: {
    taskId: string;
    versionId: string;
}) {
    requireNumeric(Array.isArray(value) && value.length <= numericPolicy.max_reviews_per_version);
    const prepared = prepareNumericInput(snapshot, evidence), history = copyPreparedHistory(value, prepared, { ...owner });
    await prepared.verify();
    await Promise.all(history.map((review) => prepared.verifyReceipt(review)));
    return history;
}
export function appendNumericReviews(task: AnalysisTask, versionId: string, incoming: NumericReview[]): AnalysisTask {
    const version = task.reportVersions.find((item) => item.id === versionId);
    requireNumeric(version && version.reportTextSnapshot && version.evidenceBundle && !version.numericValidation, "reference_mismatch");
    const history = copyNumericHistory(version.numericReviews ?? [], version.reportTextSnapshot, version.evidenceBundle, { taskId: task.id, versionId });
    for (const item of incoming) {
        const existing = history.find((review) => review.review_id === item.review_id);
        if (existing) {
            requireNumeric(same(existing, item), "reference_mismatch");
            continue;
        }
        history.push(clone(item));
    }
    const reviews = copyNumericHistory(history, version.reportTextSnapshot, version.evidenceBundle, { taskId: task.id, versionId });
    return { ...task, reportVersions: task.reportVersions.map((item) => item.id === versionId ? { ...item, numericReviews: reviews } : item) };
}
export function immutableVersionCore(version: ReportVersion) {
    return clone(Object.fromEntries(Object.entries(version).filter(([key]) => !["numericReviews", "evaluationReviews"].includes(key))));
}
/** Ordinary saves preserve retained owners; explicit whole-task deletion remains possible. */
export function assertRetainedNumericAuthority(prior: AnalysisTask[], incoming: AnalysisTask[]) {
    const snapshots = new Map<string, string>(), reviews = new Map<string, string>(), versions = new Map<string, {
        taskId: string;
        core: unknown;
    }>();
    for (const task of prior)
        for (const row of [task, ...(task.reportVersions ?? [])]) {
            if (row.reportTextSnapshot) {
                const value = row.reportTextSnapshot;
                snapshots.set(value.run_id, JSON.stringify(value));
            }
            if ("task" in row) {
                if (row.reportTextSnapshot || row.numericReviews?.length)
                    versions.set(row.id, { taskId: task.id, core: immutableVersionCore(row) });
                for (const review of row.numericReviews ?? [])
                    reviews.set(review.review_id, JSON.stringify(review));
            }
        }
    for (const task of incoming) {
        const old = prior.find((item) => item.id === task.id);
        for (const row of [task, ...(task.reportVersions ?? [])]) {
            if (row.reportTextSnapshot && snapshots.has(row.reportTextSnapshot.run_id))
                requireNumeric(same(JSON.parse(snapshots.get(row.reportTextSnapshot.run_id)!), row.reportTextSnapshot), "reference_mismatch");
            if ("task" in row) {
                const oldVersion = versions.get(row.id);
                if (oldVersion)
                    requireNumeric(oldVersion.taskId === task.id && same(oldVersion.core, immutableVersionCore(row)), "reference_mismatch");
                for (const review of row.numericReviews ?? [])
                    if (reviews.has(review.review_id))
                        requireNumeric(same(JSON.parse(reviews.get(review.review_id)!), review), "reference_mismatch");
            }
        }
        if (!old)
            continue;
        for (const previous of old.reportVersions ?? []) {
            if (!previous.reportTextSnapshot && !(previous.numericReviews?.length))
                continue;
            const next = task.reportVersions.find((item) => item.id === previous.id);
            requireNumeric(next && same(immutableVersionCore(previous), immutableVersionCore(next)), "reference_mismatch");
            const prefix = previous.numericReviews ?? [], current = next.numericReviews ?? [];
            requireNumeric(current.length >= prefix.length && prefix.every((review, index) => same(review, current[index])), "reference_mismatch");
        }
    }
}
