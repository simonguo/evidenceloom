import type { AnalysisTask } from "@/lib/types";
import type { ReviewAttachment } from "../types";
import { assertReviewHistory, assertSnapshotCompatibility, copyReviewAttachment } from "./decision";
import { assert, clone } from "./guards";

export function appendEvaluationReviews(task: AnalysisTask, versionId: string, incoming: ReviewAttachment[]): AnalysisTask {
  const version = task.reportVersions.find((item) => item.id === versionId);
  assert(version?.memoryBundle && !version.memoryValidation, "reference_mismatch");
  const reviews = clone(version.evaluationReviews ?? []);
  for (const value of incoming) {
    const review = copyReviewAttachment(value, version.memoryBundle);
    if (!reviews.some((item) => item.snapshot.snapshot_sha256 === review.snapshot.snapshot_sha256)) reviews.push(review);
  }
  assertReviewHistory(reviews);
  for (const row of [task, ...task.reportVersions]) {
    if (!row.memoryBundle) continue;
    const existing = [row.memoryBundle.decision_snapshot, ...row.memoryBundle.input_snapshot.decisions, ...(row.evaluationReviews ?? []).map((review) => review.snapshot)];
    for (const review of reviews) for (const item of existing) if (review.decision_id === item.run_id) assertSnapshotCompatibility(review.snapshot, item);
  }
  const reportVersions = task.reportVersions.map((item) => item.id === versionId ? { ...item, evaluationReviews: reviews } : item);
  return { ...task, reportVersions, ...(task.memoryBundle?.run_id === version.runId ? { evaluationReviews: clone(reviews) } : {}) };
}
