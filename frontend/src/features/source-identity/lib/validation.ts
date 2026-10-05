import type { AnalysisEvent, AnalysisTask, ReportVersion } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import type { ReportTextSnapshot } from "@/features/numeric-review/types";
import {
  copyEvidenceBundle,
  sha256,
  verifyEvidenceBundle,
} from "@/features/evidence/lib/validation";
import {
  bindReportSnapshot,
  copySnapshotAgainstEvidence,
} from "@/features/numeric-review/lib/snapshot";
import { extractDecisionFromReport, normalizeRating } from "@/components/task-center/decisions";
import {
  bounded,
  clone,
  day,
  exact,
  hash,
  stamp,
  text,
  timestamp,
  uuid,
} from "@/features/memory/lib/guards";
import type { EffectiveRequestIdentity, IdentityFields } from "../types";
import { deriveIdentityRecords, identitySummary } from "./derive";
import {
  fixedIdentity,
  identityInvalidReasons,
  invalidIdentity,
  requireIdentity,
  sameIdentity,
} from "./guards";
import { identityPolicy, identityPolicySha256 } from "./policy";
export { IdentityError, invalidIdentity } from "./guards";
function capture(value: unknown, evidenceValue: unknown, snapshotValue: unknown) {
  try {
    bounded(value);
    exact(value, [
      "schema_version",
      "scope",
      "policy_version",
      "policy_sha256",
      "run_id",
      "instrument",
      "analysis_date",
      "evidence_bundle_sha256",
      "report_snapshot_sha256",
      "reviewed_at",
      "records",
      "summary",
      "assessment_sha256",
    ]);
    requireIdentity(
      value.schema_version === 1 &&
        value.scope === identityPolicy.scope &&
        value.policy_version === identityPolicy.policy_version &&
        value.policy_sha256 === identityPolicySha256,
    );
    requireIdentity(
      uuid(value.run_id) &&
        text(value.instrument) &&
        Boolean(value.instrument) &&
        day(value.analysis_date) &&
        timestamp(value.reviewed_at) &&
        /\.[0-9]{6}Z$/.test(value.reviewed_at),
    );
    requireIdentity(
      hash(value.evidence_bundle_sha256) &&
        hash(value.report_snapshot_sha256) &&
        hash(value.assessment_sha256),
    );
    const evidence = copyEvidenceBundle(evidenceValue),
      snapshot = copySnapshotAgainstEvidence(snapshotValue, evidence);
    if (evidence.manifest.effective_request_identity_policy_sha256 !== undefined)
      requireIdentity(
        evidence.manifest.effective_request_identity_policy_sha256 === identityPolicySha256,
        "reference_mismatch",
      );
    requireIdentity(
      value.run_id === evidence.run_id &&
        value.instrument === evidence.instrument &&
        value.analysis_date === evidence.analysis_date &&
        value.evidence_bundle_sha256 === evidence.bundle_sha256 &&
        value.report_snapshot_sha256 === snapshot.snapshot_sha256,
      "reference_mismatch",
    );
    requireIdentity(
      [
        snapshot.captured_at,
        evidence.created_at,
        ...evidence.records.map((record) => record.fetched_at),
      ].every((at) => stamp(value.reviewed_at as string) >= stamp(at)),
      "reference_mismatch",
    );
    const records = deriveIdentityRecords(evidence);
    requireIdentity(
      sameIdentity(value.records, records) && sameIdentity(value.summary, identitySummary(records)),
      "reference_mismatch",
    );
    if (
      evidence.manifest.effective_request_identity_policy_sha256 !== undefined &&
      identitySummary(records).unsafe_record_ids.length
    )
      requireIdentity(
        normalizeRating(
          extractDecisionFromReport(snapshot.report_sections.final_trade_decision),
        ) === "REVIEW",
        "reference_mismatch",
      );
    return { assessment: clone(value) as EffectiveRequestIdentity, evidence, snapshot };
  } catch (error) {
    return fixedIdentity(error);
  }
}
export function copyEffectiveRequestIdentity(
  value: unknown,
  evidence: unknown,
  snapshot: unknown,
): EffectiveRequestIdentity {
  return capture(value, evidence, snapshot).assessment;
}
export async function verifyEffectiveRequestIdentity(
  value: unknown,
  evidenceValue: unknown,
  snapshotValue: unknown,
): Promise<EffectiveRequestIdentity> {
  const { assessment, evidence, snapshot } = capture(value, evidenceValue, snapshotValue);
  try {
    const body = Object.fromEntries(
      Object.entries(assessment).filter(([key]) => key !== "assessment_sha256"),
    );
    const snapshotBody = Object.fromEntries(
      Object.entries(snapshot).filter(([key]) => key !== "snapshot_sha256"),
    );
    const [, policyHash, assessmentHash, snapshotHash] = await Promise.all([
      verifyEvidenceBundle(evidence, snapshot.report_sections),
      sha256(identityPolicy),
      sha256(body),
      sha256(snapshotBody),
    ]);
    requireIdentity(
      policyHash === identityPolicySha256 &&
        assessmentHash === assessment.assessment_sha256 &&
        snapshotHash === snapshot.snapshot_sha256,
      "hash_mismatch",
    );
    return assessment;
  } catch (error) {
    return fixedIdentity(error);
  }
}
type Owner = AnalysisTask | ReportVersion;
export function bindIdentityOwner<T extends Owner>(owner: T): T {
  if (owner.effectiveRequestIdentity === undefined) {
    requireIdentity(
      !(
        owner.evidenceBundle?.manifest.effective_request_identity_policy_sha256 !== undefined &&
        ("task" in owner || owner.status === "completed")
      ) || owner.identityValidation !== undefined,
      "reference_mismatch",
    );
    return owner;
  }
  requireIdentity(
    !owner.identityValidation &&
      !owner.evidenceValidation &&
      !owner.numericValidation &&
      owner.reportTextSnapshot &&
      owner.evidenceBundle,
    "reference_mismatch",
  );
  requireIdentity(!("status" in owner && "task" in owner), "reference_mismatch");
  requireIdentity(
    typeof owner.id === "string" &&
      owner.id.length > 0 &&
      new TextEncoder().encode(owner.id).length <= 256,
    "reference_mismatch",
  );
  if ("status" in owner) {
    requireIdentity(owner.status === "completed", "reference_mismatch");
    requireIdentity(
      owner.ticker === owner.reportTextSnapshot!.instrument &&
        owner.analysisDate === owner.reportTextSnapshot!.analysis_date,
      "reference_mismatch",
    );
  } else
    requireIdentity(
      Number.isSafeInteger(owner.versionNumber) &&
        owner.versionNumber > 0 &&
        timestamp(owner.createdAt),
      "reference_mismatch",
    );
  bindReportSnapshot(owner, owner.reportTextSnapshot!);
  const identity = owner.effectiveRequestIdentity;
  requireIdentity(
    identity.run_id === owner.reportTextSnapshot!.run_id &&
      identity.report_snapshot_sha256 === owner.reportTextSnapshot!.snapshot_sha256 &&
      identity.evidence_bundle_sha256 === owner.evidenceBundle!.bundle_sha256,
    "reference_mismatch",
  );
  if (
    owner.evidenceBundle!.manifest.effective_request_identity_policy_sha256 !== undefined &&
    identity.summary.unsafe_record_ids.length
  ) {
    requireIdentity(
      owner.decision === "REVIEW" &&
        (!owner.memoryBundle || owner.memoryBundle.decision_snapshot.decision.rating === "REVIEW"),
      "reference_mismatch",
    );
  }
  return owner;
}
export function normalizeIdentityOwner<T extends Owner>(owner: T): T {
  try {
    if (owner.identityValidation !== undefined) {
      exact(owner.identityValidation, ["status", "reason"]);
      requireIdentity(
        owner.identityValidation.status === "invalid" &&
          identityInvalidReasons.includes(owner.identityValidation.reason) &&
          owner.effectiveRequestIdentity === undefined,
      );
      return { ...owner, identityValidation: clone(owner.identityValidation) };
    }
    if (owner.effectiveRequestIdentity === undefined) return bindIdentityOwner(owner);
    return bindIdentityOwner({
      ...owner,
      effectiveRequestIdentity: copyEffectiveRequestIdentity(
        owner.effectiveRequestIdentity,
        owner.evidenceBundle,
        owner.reportTextSnapshot,
      ),
      identityValidation: undefined,
    });
  } catch (error) {
    return {
      ...owner,
      effectiveRequestIdentity: undefined,
      identityValidation: invalidIdentity(error),
    };
  }
}
export async function verifyIdentityOwner<T extends Owner>(owner: T): Promise<T> {
  const safe = normalizeIdentityOwner(clone(owner));
  if (!safe.effectiveRequestIdentity || safe.identityValidation) return safe;
  try {
    return bindIdentityOwner({
      ...safe,
      effectiveRequestIdentity: await verifyEffectiveRequestIdentity(
        safe.effectiveRequestIdentity,
        safe.evidenceBundle,
        safe.reportTextSnapshot,
      ),
    });
  } catch (error) {
    return {
      ...safe,
      effectiveRequestIdentity: undefined,
      identityValidation: invalidIdentity(error),
    };
  }
}
export function copyIdentityFromEvent(
  event: AnalysisEvent,
  evidence: EvidenceBundle | undefined,
  snapshot: ReportTextSnapshot | undefined,
): IdentityFields | undefined {
  const top = event.effectiveRequestIdentity,
    nested = event.finalState?.effective_request_identity;
  if (top === undefined && nested === undefined) return undefined;
  try {
    const assessment = copyEffectiveRequestIdentity(
      top === undefined ? nested : top,
      evidence,
      snapshot,
    );
    if (top !== undefined && nested !== undefined)
      requireIdentity(
        sameIdentity(copyEffectiveRequestIdentity(nested, evidence, snapshot), assessment),
        "reference_mismatch",
      );
    return { effectiveRequestIdentity: assessment, identityValidation: undefined };
  } catch (error) {
    return { effectiveRequestIdentity: undefined, identityValidation: invalidIdentity(error) };
  }
}
export async function identityFromEvent(
  event: AnalysisEvent,
  evidence: EvidenceBundle | undefined,
  snapshot: ReportTextSnapshot | undefined,
): Promise<IdentityFields | undefined> {
  if (
    event.effectiveRequestIdentity === undefined &&
    event.finalState?.effective_request_identity === undefined
  )
    return undefined;
  try {
    const captured = clone({
      top: event.effectiveRequestIdentity,
      nested: event.finalState?.effective_request_identity,
      evidence,
      snapshot,
    });
    const copied = copyIdentityFromEvent(
      {
        type: event.type,
        effectiveRequestIdentity: captured.top,
        finalState: { effective_request_identity: captured.nested },
      },
      captured.evidence,
      captured.snapshot,
    );
    if (copied?.identityValidation) return copied;
    const assessment = await verifyEffectiveRequestIdentity(
      copied?.effectiveRequestIdentity,
      captured.evidence,
      captured.snapshot,
    );
    return { effectiveRequestIdentity: assessment, identityValidation: undefined };
  } catch (error) {
    return { effectiveRequestIdentity: undefined, identityValidation: invalidIdentity(error) };
  }
}
