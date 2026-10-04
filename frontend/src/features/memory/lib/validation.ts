import type { AnalysisEvent, AnalysisTask, ReportVersion } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import { copyEvidenceBundle, verifyEvidenceBundle } from "@/features/evidence/lib/validation";
import type { DecisionSnapshot, MemoryBundle, MemoryFields, MemoryInventory, MemoryValidation } from "../types";
import { copyContextSnapshot, verifyContextSnapshot } from "./context";
import { assertReviewHistory, assertSnapshotCompatibility, copyDecisionSnapshot, copyReviewAttachment, verifyDecisionSnapshot, verifyReviewAttachment } from "./decision";
import { assert, bounded, clone, day, exact, hash, MemoryError, object, stamp, text, uuid, verifyHash } from "./guards";

export { MemoryError } from "./guards";
export { copyDecisionSnapshot, copyReviewAttachment, verifyDecisionSnapshot, verifyReviewAttachment } from "./decision";

function bindEvidence(bundle: MemoryBundle, evidence: EvidenceBundle) {
  const contract = bundle.decision_snapshot.contract;
  assert(bundle.run_id === evidence.run_id && bundle.instrument === evidence.instrument && bundle.analysis_date === evidence.analysis_date && bundle.evidence_bundle_sha256 === evidence.bundle_sha256, "reference_mismatch");
  assert(evidence.manifest.memory_input_sha256 === bundle.input_snapshot.context_sha256 && evidence.manifest.holding_period_days === contract.holding_period_days && evidence.manifest.benchmark_ticker === contract.resolved_benchmark, "reference_mismatch");
  if (evidence.manifest.asset_type !== undefined) assert(bundle.decision_snapshot.decision.asset_type === evidence.manifest.asset_type, "reference_mismatch");
}
export function copyMemoryBundle(value: unknown, evidence: unknown): MemoryBundle {
  bounded(value); exact(value, ["schema_version", "run_id", "instrument", "analysis_date", "evidence_bundle_sha256", "persistence_status", "input_snapshot", "decision_snapshot", "bundle_sha256"]);
  assert(value.schema_version === 1 && uuid(value.run_id) && text(value.instrument) && value.instrument && day(value.analysis_date) && hash(value.evidence_bundle_sha256) && hash(value.bundle_sha256) && ["durable", "memory_only"].includes(String(value.persistence_status)));
  const context = copyContextSnapshot(value.input_snapshot); const snapshot = copyDecisionSnapshot(value.decision_snapshot);
  assert(snapshot.run_id === value.run_id && snapshot.decision.instrument === value.instrument && context.instrument === value.instrument && snapshot.decision.analysis_date === value.analysis_date && snapshot.decision.evidence_bundle_sha256 === value.evidence_bundle_sha256 && snapshot.decision.research_as_of === context.research_cutoff && !context.decisions.some((item) => item.run_id === value.run_id), "reference_mismatch");
  assert(stamp(context.selected_at) >= stamp(snapshot.decision.research_started_at) && stamp(context.selected_at) <= stamp(snapshot.decision.recorded_at), "temporal_mismatch");
  const bundle = clone(value) as unknown as MemoryBundle;
  assert(evidence !== undefined, "reference_mismatch"); bindEvidence(bundle, copyEvidenceBundle(evidence)); return bundle;
}
export async function verifyMemoryBundle(value: unknown, evidence: unknown): Promise<MemoryBundle> {
  const bundle = copyMemoryBundle(value, evidence); const verifiedEvidence = await verifyEvidenceBundle(evidence);
  await Promise.all([verifyContextSnapshot(bundle.input_snapshot), verifyDecisionSnapshot(bundle.decision_snapshot), verifyHash(bundle as unknown as Record<string, unknown>, "bundle_sha256")]);
  bindEvidence(bundle, verifiedEvidence); return bundle;
}
export function invalidMemory(error: unknown): MemoryValidation { return { status: "invalid", reason: error instanceof MemoryError ? error.reason : "malformed" }; }
const reasons = ["malformed", "hash_mismatch", "unsafe_content", "reference_mismatch", "temporal_mismatch", "verification_unavailable"];
function normalized<T extends Partial<MemoryFields> & { evidenceBundle?: EvidenceBundle }>(value: T): T & MemoryFields {
  try {
    if (value.evaluationReviews !== undefined) assert(Array.isArray(value.evaluationReviews));
    if (value.memoryValidation !== undefined) {
      const marker = value.memoryValidation; exact(marker, ["status", "reason"]);
      assert(marker.status === "invalid" && reasons.includes(String(marker.reason)) && value.memoryBundle === undefined && !(value.evaluationReviews?.length));
      return { ...value, memoryBundle: undefined, memoryValidation: clone(marker) as MemoryValidation, evaluationReviews: [] };
    }
    if (value.memoryBundle === undefined) { assert(!value.evaluationReviews?.length, "reference_mismatch"); return Object.hasOwn(value, "evaluationReviews") ? { ...value, evaluationReviews: [] } : value as T & MemoryFields; }
    const bundle = copyMemoryBundle(value.memoryBundle, value.evidenceBundle);
    assert(Array.isArray(value.evaluationReviews ?? [])); const seen = new Set<string>();
    const reviews = (value.evaluationReviews ?? []).map((review) => copyReviewAttachment(review, bundle));
    assertReviewHistory(reviews);
    reviews.forEach((review) => { assert(!seen.has(review.snapshot.snapshot_sha256)); seen.add(review.snapshot.snapshot_sha256); });
    return { ...value, memoryBundle: bundle, memoryValidation: undefined, evaluationReviews: reviews };
  } catch (error) { return { ...value, memoryBundle: undefined, memoryValidation: invalidMemory(error), evaluationReviews: [] }; }
}
function matches<T extends AnalysisTask | ReportVersion>(value: T): T {
  if (!value.memoryBundle) return value;
  const isTask = "status" in value;
  const identity: { ticker: string; analysisDate: string; assetType: string } = isTask ? value as AnalysisTask : (value as ReportVersion).task;
  const decision = value.memoryBundle.decision_snapshot;
  if ((isTask && "task" in value) || value.memoryBundle.instrument !== identity.ticker || value.memoryBundle.analysis_date !== identity.analysisDate || decision.decision.asset_type !== identity.assetType || (!isTask && value.memoryBundle.run_id !== (value as ReportVersion).runId) || decision.artifacts[decision.decision.decision_text_sha256].payload !== value.reportSections.final_trade_decision || decision.decision.rating !== value.decision) return { ...value, memoryBundle: undefined, memoryValidation: { status: "invalid", reason: "reference_mismatch" }, evaluationReviews: [] };
  return value;
}
export function normalizeTaskMemory(task: AnalysisTask): AnalysisTask {
  const safe = matches(normalized(task));
  if (!Array.isArray(task.reportVersions)) return safe;
  const versions = task.reportVersions.map((version) => matches(normalized(version)));
  const snapshots = (row: MemoryFields): DecisionSnapshot[] => row.memoryBundle ? [row.memoryBundle.decision_snapshot, ...row.memoryBundle.input_snapshot.decisions, ...row.evaluationReviews.map((review) => review.snapshot)] : [];
  const byId = new Map<string, DecisionSnapshot>(); const conflicts = new Set<string>(); const completionHashes = new Map<string, string>();
  for (const row of [safe, ...versions]) if (row.memoryBundle) {
    const previous = completionHashes.get(row.memoryBundle.run_id);
    if (previous && previous !== row.memoryBundle.bundle_sha256) conflicts.add(row.memoryBundle.run_id);
    completionHashes.set(row.memoryBundle.run_id, row.memoryBundle.bundle_sha256);
  }
  for (const row of [safe, ...versions]) for (const item of snapshots(row)) {
    const previous = byId.get(item.run_id);
    try { if (previous) assertSnapshotCompatibility(previous, item); else byId.set(item.run_id, item); }
    catch { conflicts.add(item.run_id); }
    if (previous && !previous.outcome && item.outcome) byId.set(item.run_id, item);
    else if (previous && !previous.reflection && item.reflection) byId.set(item.run_id, item);
  }
  const reject = <T extends AnalysisTask | ReportVersion>(row: T): T => snapshots(row).some((item) => conflicts.has(item.run_id)) ? { ...row, memoryBundle: undefined, memoryValidation: { status: "invalid", reason: "reference_mismatch" }, evaluationReviews: [] } : row;
  return { ...reject(safe), reportVersions: versions.map(reject) };
}
export async function verifySavedMemory<T extends AnalysisTask | ReportVersion>(value: T): Promise<T> {
    const safe = matches(normalized(value)); if (!safe.memoryBundle || safe.memoryValidation) return safe;
    try {
      const bundle = await verifyMemoryBundle(safe.memoryBundle, clone(safe.evidenceBundle));
      const reviews = await Promise.all(safe.evaluationReviews.map((review) => verifyReviewAttachment(review, bundle)));
      return { ...safe, memoryBundle: bundle, evaluationReviews: reviews };
    } catch (error) { return { ...safe, memoryBundle: undefined, memoryValidation: invalidMemory(error), evaluationReviews: [] }; }
}
export async function verifyTaskMemory(task: AnalysisTask): Promise<AnalysisTask> {
  const normalized = normalizeTaskMemory(task); const safe = await verifySavedMemory(normalized);
  return Array.isArray(normalized.reportVersions) ? { ...safe, reportVersions: await Promise.all(normalized.reportVersions.map(verifySavedMemory)) } : safe;
}
export async function memoryFromEvent(event: AnalysisEvent, evidence: EvidenceBundle | undefined): Promise<MemoryFields | undefined> {
  const top = event.memoryBundle; const nested = event.finalState?.memory_bundle;
  if (top === undefined && nested === undefined) return undefined;
  try {
    const bundle = await verifyMemoryBundle(top ?? nested, evidence);
    if (top !== undefined && nested !== undefined) assert((await verifyMemoryBundle(nested, evidence)).bundle_sha256 === bundle.bundle_sha256, "reference_mismatch");
    return { memoryBundle: bundle, evaluationReviews: [] };
  } catch (error) { return { memoryValidation: invalidMemory(error), evaluationReviews: [] }; }
}
export async function verifyMemoryInventory(value: unknown, requestedIds: string[]): Promise<MemoryInventory> {
  bounded(value); assert(object(value)); exact(value, ["type", "schema_version", "requested_ids", "reviews", "missing_ids", ...(Object.hasOwn(value, "timestamp") ? ["timestamp"] : [])]);
  assert(value.type === "memory_inventory" && value.schema_version === 1 && Array.isArray(value.requested_ids) && value.requested_ids.length >= 1 && value.requested_ids.length <= 20 && value.requested_ids.every(uuid) && new Set(value.requested_ids).size === value.requested_ids.length && JSON.stringify(value.requested_ids) === JSON.stringify(requestedIds));
  assert(Array.isArray(value.reviews) && Array.isArray(value.missing_ids) && value.missing_ids.every(uuid));
  if (value.timestamp !== undefined) assert(typeof value.timestamp === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value.timestamp));
  const reviews = await Promise.all(value.reviews.map((review) => verifyReviewAttachment(review)));
  const covered = [...reviews.map((review) => review.decision_id), ...value.missing_ids];
  assert(new Set(covered).size === covered.length && covered.length === requestedIds.length && covered.every((id) => requestedIds.includes(id)), "reference_mismatch");
  return clone({ ...value, reviews }) as unknown as MemoryInventory;
}
