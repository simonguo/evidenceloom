import type { AnalysisTask, ReportVersion } from "@/lib/types";
import { clone, exact } from "@/features/memory/lib/guards";
import type { NumericInvalidReason } from "../types";
import { copyNumericHistory, immutableVersionCore, verifyNumericHistory } from "./history";
import { bindReportSnapshot, copyReportTextSnapshot, invalidNumeric, verifyReportTextSnapshot } from "./snapshot";
import { NumericError, requireNumeric, same } from "./guards";
const reasons: NumericInvalidReason[] = ["malformed", "hash_mismatch", "reference_mismatch", "unsafe_content", "verification_unavailable"];
function reject<T extends AnalysisTask | ReportVersion>(row: T, error: unknown): T {
    return { ...row, reportTextSnapshot: undefined, numericValidation: invalidNumeric(error), ...("task" in row ? { numericReviews: [] } : {}) };
}
function normalizeOwner<T extends AnalysisTask | ReportVersion>(row: T, taskId: string): T {
    try {
        if (row.numericValidation !== undefined) {
            exact(row.numericValidation, ["status", "reason"]);
            requireNumeric(row.numericValidation.status === "invalid" && reasons.includes(row.numericValidation.reason) && row.reportTextSnapshot === undefined && (!("task" in row) || !(row.numericReviews?.length)));
            return { ...row, numericValidation: clone(row.numericValidation), ...("task" in row ? { numericReviews: [] } : {}) };
        }
        if (row.reportTextSnapshot === undefined) {
            requireNumeric(!("task" in row) || !(row.numericReviews?.length), "reference_mismatch");
            return "task" in row ? { ...row, numericReviews: [] } : row;
        }
        const snapshot = copyReportTextSnapshot(row.reportTextSnapshot, row.evidenceBundle);
        const safe = bindReportSnapshot(row, snapshot);
        if ("task" in safe)
            return { ...safe, numericReviews: copyNumericHistory(safe.numericReviews ?? [], snapshot, safe.evidenceBundle!, { taskId, versionId: safe.id }) };
        return safe;
    }
    catch (error) {
        return reject(row, error);
    }
}
/** Collect global UUID conflicts before clearing any affected owner's attachment. */
export function normalizeNumericTasks(tasks: AnalysisTask[]): AnalysisTask[] {
    const normalized = tasks.map(normalizeNumericTaskFields);
    const snapshots = new Map<string, string>(), reviews = new Map<string, string>(), versions = new Map<string, { taskId: string; core: unknown }>(), runConflicts = new Set<string>(), reviewConflicts = new Set<string>(), versionConflicts = new Set<string>();
    for (const task of normalized)
        for (const row of [task, ...(task.reportVersions ?? [])]) {
            if (row.reportTextSnapshot) {
                const snapshot = row.reportTextSnapshot, body = JSON.stringify(snapshot);
                if (snapshots.has(snapshot.run_id) && !same(JSON.parse(snapshots.get(snapshot.run_id)!), snapshot))
                    runConflicts.add(snapshot.run_id);
                snapshots.set(snapshot.run_id, body);
            }
            if ("task" in row) {
                if (row.reportTextSnapshot || row.numericReviews?.length) {
                    const previous = versions.get(row.id), core = immutableVersionCore(row);
                    if (previous && (previous.taskId !== task.id || !same(previous.core, core))) versionConflicts.add(row.id);
                    versions.set(row.id, { taskId: task.id, core });
                }
                for (const review of row.numericReviews ?? []) {
                    if (reviews.has(review.review_id) && !same(JSON.parse(reviews.get(review.review_id)!), review))
                        reviewConflicts.add(review.review_id);
                    reviews.set(review.review_id, JSON.stringify(review));
                }
            }
        }
    const apply = <T extends AnalysisTask | ReportVersion>(row: T): T => (row.reportTextSnapshot && runConflicts.has(row.reportTextSnapshot.run_id)) || ("task" in row && (versionConflicts.has(row.id) || row.numericReviews?.some((review) => reviewConflicts.has(review.review_id))))
        ? reject(row, new NumericError("reference_mismatch")) : row;
    return normalized.map((task) => ({ ...apply(task), ...(Array.isArray(task.reportVersions) ? { reportVersions: task.reportVersions.map(apply) } : {}) }));
}
export function normalizeNumericTaskFields(task: AnalysisTask): AnalysisTask {
    return { ...normalizeOwner(task, task.id), ...(Array.isArray(task.reportVersions) ? { reportVersions: task.reportVersions.map((version) => normalizeOwner(version, task.id)) } : {}) };
}
async function verifyOwner<T extends AnalysisTask | ReportVersion>(row: T, taskId: string): Promise<T> {
    if (!row.reportTextSnapshot || row.numericValidation)
        return row;
    try {
        const snapshot = await verifyReportTextSnapshot(row.reportTextSnapshot, clone(row.evidenceBundle));
        const safe = bindReportSnapshot(row, snapshot);
        return "task" in safe ? { ...safe, numericReviews: await verifyNumericHistory(safe.numericReviews ?? [], snapshot, safe.evidenceBundle!, { taskId, versionId: safe.id }) } : safe;
    }
    catch (error) {
        return reject(row, error);
    }
}
export async function verifyNumericTasks(tasks: AnalysisTask[]): Promise<AnalysisTask[]> {
    return normalizeNumericTasks(await Promise.all(normalizeNumericTasks(tasks).map(async (task) => ({ ...await verifyOwner(task, task.id), reportVersions: await Promise.all(task.reportVersions.map((version) => verifyOwner(version, task.id))) }))));
}
export async function verifyNumericTask(task: AnalysisTask) { return (await verifyNumericTasks([task]))[0]; }
