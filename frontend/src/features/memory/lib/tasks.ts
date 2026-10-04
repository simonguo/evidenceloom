import { canonicalJson } from "@/features/evidence/lib/validation";
import { immutableVersionCore } from "@/features/numeric-review/lib/history";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import type { DecisionSnapshot, MemoryFields } from "../types";
import { assertSnapshotCompatibility } from "./decision";
import { assert, clone } from "./guards";
import { normalizeMemoryTaskFields, verifyTaskMemory } from "./validation";

const snapshots = (row: Partial<MemoryFields>): DecisionSnapshot[] => row.memoryBundle
  ? [row.memoryBundle.decision_snapshot, ...row.memoryBundle.input_snapshot.decisions, ...(row.evaluationReviews ?? []).map((review) => review.snapshot)] : [];
const same = (first: unknown, second: unknown) => canonicalJson(first) === canonicalJson(second);

export function normalizeMemoryTasks(tasks: AnalysisTask[]): AnalysisTask[] {
  const captured = tasks.map(normalizeMemoryTaskFields);
  const completions = new Map<string, string>();
  const decisions = new Map<string, DecisionSnapshot>();
  const conflicts = new Set<string>();
  const versions = new Map<string, { taskId: string; core: unknown; memoryBearing: boolean }>();
  const versionConflicts = new Set<string>();
  for (const task of captured) for (const version of task.reportVersions ?? []) {
    const memoryBearing = Boolean(version.memoryBundle || version.memoryValidation || version.evaluationReviews?.length);
    const old = versions.get(version.id), core = immutableVersionCore(version);
    if (old && (old.memoryBearing || memoryBearing) && (old.taskId !== task.id || !same(old.core, core))) versionConflicts.add(version.id);
    versions.set(version.id, { taskId: task.id, core, memoryBearing: memoryBearing || Boolean(old?.memoryBearing) });
  }
  for (const task of captured) for (const row of [task, ...(task.reportVersions ?? [])]) {
    if (row.memoryBundle) {
      const old = completions.get(row.memoryBundle.run_id);
      if (old && old !== row.memoryBundle.bundle_sha256) conflicts.add(row.memoryBundle.run_id);
      completions.set(row.memoryBundle.run_id, row.memoryBundle.bundle_sha256);
    }
    for (const snapshot of snapshots(row)) {
      const old = decisions.get(snapshot.run_id);
      try { if (old) assertSnapshotCompatibility(old, snapshot); }
      catch { conflicts.add(snapshot.run_id); }
      if (!old || (!old.outcome && snapshot.outcome) || (!old.reflection && snapshot.reflection)) decisions.set(snapshot.run_id, snapshot);
    }
  }
  const reject = <T extends AnalysisTask | ReportVersion>(row: T): T => ("task" in row && versionConflicts.has(row.id)) || snapshots(row).some((snapshot) => conflicts.has(snapshot.run_id))
    ? { ...row, memoryBundle: undefined, memoryValidation: { status: "invalid", reason: "reference_mismatch" }, evaluationReviews: [] }
    : row;
  return captured.map((task) => Array.isArray(task.reportVersions)
    ? { ...reject(task), reportVersions: task.reportVersions.map(reject) }
    : reject(task));
}

export async function verifyMemoryTasks(tasks: AnalysisTask[]): Promise<AnalysisTask[]> {
  const captured = normalizeMemoryTasks(clone(tasks));
  return normalizeMemoryTasks(await Promise.all(captured.map(verifyTaskMemory)));
}

/** Retained versions remain immutable; whole-task delete/clear releases orphan authority. */
export function assertRetainedMemoryAuthority(prior: AnalysisTask[], incoming: AnalysisTask[]): void {
  const retainedIds = new Set(incoming.map((task) => task.id));
  const retained = prior.filter((task) => retainedIds.has(task.id));
  const completions = new Map<string, string>();
  const decisions = new Map<string, DecisionSnapshot>();
  const versions = new Map<string, { taskId: string; version: ReportVersion }>();
  for (const task of retained) for (const version of task.reportVersions ?? []) {
    versions.set(version.id, { taskId: task.id, version });
  }
  for (const task of retained) for (const row of [task, ...(task.reportVersions ?? [])]) {
    if (row.memoryBundle) completions.set(row.memoryBundle.run_id, row.memoryBundle.bundle_sha256);
    for (const snapshot of snapshots(row)) {
      const old = decisions.get(snapshot.run_id);
      if (old) assertSnapshotCompatibility(old, snapshot);
      if (!old || (!old.outcome && snapshot.outcome) || (!old.reflection && snapshot.reflection)) {
        decisions.set(snapshot.run_id, snapshot);
      }
    }
  }
  for (const task of incoming) {
    for (const version of task.reportVersions ?? []) {
      const old = versions.get(version.id);
      if (old && (old.version.memoryBundle || old.version.memoryValidation || version.memoryBundle || version.memoryValidation || old.version.evaluationReviews?.length || version.evaluationReviews?.length)) {
        assert(old.taskId === task.id && same(immutableVersionCore(old.version), immutableVersionCore(version)), "reference_mismatch");
      }
    }
    for (const row of [task, ...(task.reportVersions ?? [])]) {
      if (row.memoryBundle && completions.has(row.memoryBundle.run_id)) assert(completions.get(row.memoryBundle.run_id) === row.memoryBundle.bundle_sha256, "reference_mismatch");
      for (const snapshot of snapshots(row)) {
        const old = decisions.get(snapshot.run_id);
        if (old) assertSnapshotCompatibility(old, snapshot);
      }
    }
    const old = retained.find((item) => item.id === task.id);
    if (!old) continue;
    for (const version of old.reportVersions ?? []) {
      if (!version.memoryBundle && !version.memoryValidation && !(version.evaluationReviews?.length)) continue;
      const next = task.reportVersions?.find((item) => item.id === version.id);
      assert(next && same(immutableVersionCore(version), immutableVersionCore(next)), "reference_mismatch");
      const prefix = version.evaluationReviews ?? [], reviews = next.evaluationReviews ?? [];
      assert(reviews.length >= prefix.length && prefix.every((review, index) => same(review, reviews[index])), "reference_mismatch");
    }
  }
}
