import { sha256 } from "@/features/evidence/lib/validation";
import { identityFixture } from "./fictional-identity";
import { deriveIdentityRecords, identitySummary } from "../lib/derive";
import { identityPolicySha256 } from "../lib/policy";
export async function rehash<T extends object>(value: T, key: string) {
  (value as Record<string, unknown>)[key] = await sha256(
    Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)),
  );
  return value;
}
export async function changeFixture(
  mutator: (task: ReturnType<typeof identityFixture>) => void,
  marked = false,
) {
  const task = identityFixture();
  mutator(task);
  if (marked)
    task.evidenceBundle!.manifest.effective_request_identity_policy_sha256 = identityPolicySha256;
  task.evidenceBundle!.manifest_sha256 = await sha256(task.evidenceBundle!.manifest);
  await rehash(task.evidenceBundle!, "bundle_sha256");
  task.reportTextSnapshot!.evidence_bundle_sha256 = task.evidenceBundle!.bundle_sha256;
  task.reportTextSnapshot!.report_sections = structuredClone(task.reportSections);
  await rehash(task.reportTextSnapshot!, "snapshot_sha256");
  const assessment = task.effectiveRequestIdentity!;
  assessment.evidence_bundle_sha256 = task.evidenceBundle!.bundle_sha256;
  assessment.report_snapshot_sha256 = task.reportTextSnapshot!.snapshot_sha256;
  assessment.records = deriveIdentityRecords(task.evidenceBundle!);
  assessment.summary = identitySummary(assessment.records);
  await rehash(assessment, "assessment_sha256");
  Object.assign(task.reportVersions[0], {
    evidenceBundle: structuredClone(task.evidenceBundle),
    reportTextSnapshot: structuredClone(task.reportTextSnapshot),
    reportSections: structuredClone(task.reportSections),
    effectiveRequestIdentity: structuredClone(assessment),
    decision: task.decision,
  });
  return task;
}
