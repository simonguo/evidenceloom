import type { AnalysisTask, ReportVersion } from "@/lib/types";
import { clone } from "@/features/memory/lib/guards";
import { immutableVersionCore } from "@/features/numeric-review/lib/history";
import { IdentityError, requireIdentity, sameIdentity } from "./guards";
import { normalizeIdentityOwner, verifyIdentityOwner } from "./validation";
export function normalizeIdentityTaskFields(task: AnalysisTask): AnalysisTask {
  return {
    ...normalizeIdentityOwner(task),
    ...(Array.isArray(task.reportVersions)
      ? { reportVersions: task.reportVersions.map(normalizeIdentityOwner) }
      : {}),
  };
}
/** Collect run and frozen-owner conflicts before removing any attachment. */
export function normalizeIdentityTasks(tasks: AnalysisTask[]): AnalysisTask[] {
  const safe = tasks.map(normalizeIdentityTaskFields),
    runs = new Map<string, unknown>(),
    versions = new Map<string, { taskId: string; core: unknown }>();
  const runConflicts = new Set<string>(),
    versionConflicts = new Set<string>();
  for (const task of safe)
    for (const owner of [task, ...(task.reportVersions ?? [])]) {
      const attachment = owner.effectiveRequestIdentity;
      if (!attachment) continue;
      if (runs.has(attachment.run_id) && !sameIdentity(runs.get(attachment.run_id), attachment))
        runConflicts.add(attachment.run_id);
      runs.set(attachment.run_id, attachment);
      if ("task" in owner) {
        const old = versions.get(owner.id),
          core = immutableVersionCore(owner);
        if (old && (old.taskId !== task.id || !sameIdentity(old.core, core)))
          versionConflicts.add(owner.id);
        versions.set(owner.id, { taskId: task.id, core });
      }
    }
  const apply = <T extends AnalysisTask | ReportVersion>(owner: T): T =>
    owner.effectiveRequestIdentity &&
    (runConflicts.has(owner.effectiveRequestIdentity.run_id) ||
      ("task" in owner && versionConflicts.has(owner.id)))
      ? {
          ...owner,
          effectiveRequestIdentity: undefined,
          identityValidation: { status: "invalid", reason: "reference_mismatch" },
        }
      : owner;
  return safe.map((task) => ({
    ...apply(task),
    ...(Array.isArray(task.reportVersions)
      ? { reportVersions: task.reportVersions.map(apply) }
      : {}),
  }));
}
export async function verifyIdentityTasks(tasks: AnalysisTask[]): Promise<AnalysisTask[]> {
  const captured = clone(tasks);
  return normalizeIdentityTasks(
    await Promise.all(
      normalizeIdentityTasks(captured).map(async (task) => ({
        ...(await verifyIdentityOwner(task)),
        reportVersions: await Promise.all(task.reportVersions.map(verifyIdentityOwner)),
      })),
    ),
  );
}
export async function verifyIdentityTask(task: AnalysisTask) {
  return (await verifyIdentityTasks([task]))[0];
}
const state = (owner: AnalysisTask | ReportVersion) =>
  clone({
    effectiveRequestIdentity: owner.effectiveRequestIdentity,
    identityValidation: owner.identityValidation,
  });
/** No posthoc mutation of retained frozen versions; whole-task deletion is explicit. */
export function assertRetainedIdentityAuthority(prior: AnalysisTask[], incoming: AnalysisTask[]) {
  const runs = new Map<string, unknown>(),
    versions = new Map<string, { taskId: string; owner: ReportVersion }>();
  for (const task of prior)
    for (const owner of [task, ...(task.reportVersions ?? [])]) {
      if (owner.effectiveRequestIdentity)
        runs.set(owner.effectiveRequestIdentity.run_id, owner.effectiveRequestIdentity);
      if ("task" in owner) versions.set(owner.id, { taskId: task.id, owner });
    }
  for (const task of incoming) {
    for (const owner of [task, ...(task.reportVersions ?? [])])
      if (owner.effectiveRequestIdentity && runs.has(owner.effectiveRequestIdentity.run_id))
        requireIdentity(
          sameIdentity(
            runs.get(owner.effectiveRequestIdentity.run_id),
            owner.effectiveRequestIdentity,
          ),
          "reference_mismatch",
        );
    for (const version of task.reportVersions ?? []) {
      const old = versions.get(version.id);
      if (!old) continue;
      if (
        old.owner.effectiveRequestIdentity ||
        old.owner.identityValidation ||
        version.effectiveRequestIdentity ||
        version.identityValidation
      ) {
        requireIdentity(
          old.taskId === task.id &&
            sameIdentity(state(old.owner), state(version)) &&
            sameIdentity(immutableVersionCore(old.owner), immutableVersionCore(version)),
          "reference_mismatch",
        );
      }
    }
    const retained = prior.find((old) => old.id === task.id);
    for (const old of retained?.reportVersions ?? [])
      if (old.effectiveRequestIdentity || old.identityValidation) {
        const next = task.reportVersions.find((version) => version.id === old.id);
        if (!next || !sameIdentity(state(old), state(next)))
          throw new IdentityError("reference_mismatch");
      }
  }
}
