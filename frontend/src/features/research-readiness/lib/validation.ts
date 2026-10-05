import type { AnalysisEvent, AnalysisTask, ReportVersion } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import { canonicalJson, copyEvidenceBundle, sha256, verifyEvidenceBundle } from "@/features/evidence/lib/validation";
import { extractDecisionFromReport, normalizeRating } from "@/components/task-center/decisions";
import { bounded, clone, day, exact, hash, stamp, text, uuid } from "@/features/memory/lib/guards";
import { readinessReasons, type InputCheck, type ReadinessFields, type ResearchReadiness } from "../types";
import { advisoryChecks, requiredChecks, validatePolicy } from "./policy";
import { assert, fixedError, invalidReadiness, ReadinessError } from "./validation-guards";
import { deriveChecks } from "./checks";

export { invalidReadiness, ReadinessError } from "./validation-guards";
const validationReasons = ["malformed", "hash_mismatch", "unsafe_content", "reference_mismatch", "temporal_mismatch", "verification_unavailable"];
const statuses = ["passed", "missing", "unavailable", "partial", "invalid", "not_selected", "unknown"];
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const sortedUnique = (value: unknown, predicate: (item: unknown) => boolean): value is string[] => Array.isArray(value) && value.every(predicate) && new Set(value).size === value.length && same(value, [...value].sort());
const evidenceId = (value: unknown) => typeof value === "string" && /^ev-[a-f0-9]{32}$/.test(value);

export function deriveStatus(checks: InputCheck[]): ResearchReadiness["status"] {
  const unmet = checks.filter((check) => check.required && check.status !== "passed");
  return !unmet.length ? "ready" : unmet.some((check) => ["missing", "unavailable", "invalid"].includes(check.status)) ? "insufficient_evidence" : "review_required";
}
function bindEvidence(readiness: ResearchReadiness, evidence: EvidenceBundle) {
  assert(readiness.run_id === evidence.run_id && readiness.instrument === evidence.instrument && readiness.analysis_date === evidence.analysis_date && readiness.policy.research_as_of === evidence.research_as_of, "reference_mismatch");
  assert(evidence.manifest.research_readiness_policy_sha256 === readiness.policy.policy_sha256 && evidence.manifest.max_tool_rounds === readiness.policy.max_tool_rounds && same(evidence.manifest.analysts, readiness.policy.selected_analysts), "reference_mismatch");
  const expected = [...evidence.records].sort((left, right) => left.id.localeCompare(right.id)).map((record) => ({ record_id: record.id, output_sha256: record.output_sha256, data_sha256s: [...new Set(record.sources.flatMap((source) => source.data_sha256 ? [source.data_sha256] : []))].sort() }));
  assert(same(readiness.evidence_inputs, expected), "reference_mismatch");
  const records = new Map(evidence.records.map((record) => [record.id, record]));
  for (const check of readiness.checks) {
    assert(check.evidence_ids.every((id) => records.has(id)), "reference_mismatch");
    const available = new Set(check.evidence_ids.flatMap((id) => records.get(id)!.sources.flatMap((source) => source.data_sha256 ? [source.data_sha256] : [])));
    assert(check.artifact_sha256s.every((digest) => available.has(digest)), "reference_mismatch");
  }
  assert(same(readiness.checks, deriveChecks(evidence, readiness.policy)), "reference_mismatch");
}
export function copyResearchReadiness(value: unknown, evidence: unknown): ResearchReadiness {
  try {
    bounded(value); exact(value, ["schema_version", "run_id", "instrument", "analysis_date", "policy", "evidence_inputs", "checks", "status", "recommendation_allowed", "assessment_sha256"]);
    assert(value.schema_version === 1 && uuid(value.run_id) && text(value.instrument) && value.instrument && day(value.analysis_date) && hash(value.assessment_sha256));
    validatePolicy(value.policy, value.analysis_date);
    assert(Array.isArray(value.evidence_inputs));
    for (const input of value.evidence_inputs) {
      exact(input, ["record_id", "output_sha256", "data_sha256s"]);
      assert(evidenceId(input.record_id) && hash(input.output_sha256) && sortedUnique(input.data_sha256s, hash));
    }
    assert(sortedUnique(value.evidence_inputs.map((input) => input.record_id), evidenceId));
    assert(Array.isArray(value.checks));
    const expectedKeys = [...requiredChecks(value.policy.selected_analysts), ...advisoryChecks];
    assert(same(value.checks.map((check) => check.key), expectedKeys), "reference_mismatch");
    for (const check of value.checks) {
      exact(check, ["key", "required", "status", "reason_codes", "evidence_ids", "artifact_sha256s"]);
      assert(typeof check.key === "string" && typeof check.required === "boolean" && check.required === value.policy.required_checks.includes(check.key) && statuses.includes(String(check.status)));
      assert(sortedUnique(check.reason_codes, (item) => readinessReasons.includes(item as typeof readinessReasons[number])) && sortedUnique(check.evidence_ids, evidenceId) && sortedUnique(check.artifact_sha256s, hash));
    }
    const readiness = clone(value) as unknown as ResearchReadiness;
    assert(readiness.status === deriveStatus(readiness.checks) && readiness.recommendation_allowed === (readiness.status === "ready"), "reference_mismatch");
    assert(evidence !== undefined, "reference_mismatch"); bindEvidence(readiness, copyEvidenceBundle(evidence));
    return readiness;
  } catch (error) { return fixedError(error); }
}
export async function verifyResearchReadiness(value: unknown, evidence: unknown): Promise<ResearchReadiness> {
  const readiness = copyResearchReadiness(value, evidence);
  try {
    const verified = await verifyEvidenceBundle(evidence);
    for (const [object, key] of [[readiness.policy, "policy_sha256"], [readiness, "assessment_sha256"]] as const) {
      const body = Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
      assert(await sha256(body) === (object as unknown as Record<string, unknown>)[key], "hash_mismatch");
    }
    bindEvidence(readiness, verified);
    return readiness;
  } catch (error) { if (error instanceof ReadinessError) throw error; return fixedError(error); }
}
function bindSnapshot<T extends AnalysisTask | ReportVersion>(snapshot: T): T {
  const readiness = snapshot.researchReadiness;
  if (!readiness) return snapshot;
  const isTask = "status" in snapshot;
  assert(!(isTask && "task" in snapshot), "reference_mismatch");
  const identity = isTask ? snapshot as AnalysisTask : (snapshot as ReportVersion).task;
  assert(readiness.instrument === identity.ticker && readiness.analysis_date === identity.analysisDate && same(readiness.policy.selected_analysts, identity.analysts), "reference_mismatch");
  if (!isTask) {
    assert(readiness.run_id === (snapshot as ReportVersion).runId, "reference_mismatch");
    const settings = (snapshot as ReportVersion).run?.runtimeRunSettings;
    if (settings?.research_readiness_policy_sha256 !== undefined) assert(settings.research_readiness_policy_sha256 === readiness.policy.policy_sha256, "reference_mismatch");
    if (settings?.max_tool_rounds !== undefined) assert(settings.max_tool_rounds === readiness.policy.max_tool_rounds, "reference_mismatch");
    if (settings?.analysts !== undefined) assert(same(settings.analysts, readiness.policy.selected_analysts), "reference_mismatch");
  }
  if (snapshot.memoryBundle) {
    const decision = snapshot.memoryBundle.decision_snapshot.decision;
    assert(readiness.run_id === snapshot.memoryBundle.run_id && stamp(readiness.policy.research_started_at) === stamp(decision.research_started_at) && readiness.policy.research_calendar_date === decision.analysis_calendar_date && readiness.policy.host_utc_offset === decision.host_utc_offset, "reference_mismatch");
    if (!readiness.recommendation_allowed) assert(decision.rating === "REVIEW", "reference_mismatch");
  }
  if (!isTask || snapshot.status === "completed") {
    if (!readiness.recommendation_allowed) assert(snapshot.decision === "REVIEW" && normalizeRating(extractDecisionFromReport(snapshot.reportSections.final_trade_decision)) === "REVIEW", "reference_mismatch");
  }
  return snapshot;
}
function normalized<T extends Partial<ReadinessFields> & { evidenceBundle?: EvidenceBundle }>(value: T): T & ReadinessFields {
  try {
    if (value.readinessValidation !== undefined) {
      exact(value.readinessValidation, ["status", "reason"]);
      assert(value.readinessValidation.status === "invalid" && validationReasons.includes(value.readinessValidation.reason) && value.researchReadiness === undefined);
      return { ...value, researchReadiness: undefined, readinessValidation: clone(value.readinessValidation) };
    }
    if (value.researchReadiness === undefined) return value;
    return { ...value, researchReadiness: copyResearchReadiness(value.researchReadiness, value.evidenceBundle), readinessValidation: undefined };
  } catch (error) { return { ...value, researchReadiness: undefined, readinessValidation: invalidReadiness(error) }; }
}
function safeSnapshot<T extends AnalysisTask | ReportVersion>(value: T): T {
  const safe = normalized(value);
  try { return bindSnapshot(safe); }
  catch (error) { return { ...safe, researchReadiness: undefined, readinessValidation: invalidReadiness(error) }; }
}
/** Validate owners without discarding identity conflicts before a list scan. */
export function normalizeReadinessTaskFields(task: AnalysisTask): AnalysisTask {
  const current = safeSnapshot(task);
  if (!Array.isArray(task.reportVersions)) return current;
  return { ...current, reportVersions: task.reportVersions.map(safeSnapshot) };
}
export function normalizeTaskReadiness(task: AnalysisTask): AnalysisTask {
  return normalizeReadinessTasks([task])[0];
}
/** One run UUID has one assessment across every saved task and version. */
export function normalizeReadinessTasks(tasks: AnalysisTask[]): AnalysisTask[] {
  const normalized = tasks.map(normalizeReadinessTaskFields), hashes = new Map<string, string>(), conflicts = new Set<string>();
  for (const task of normalized) for (const snapshot of [task, ...(task.reportVersions ?? [])]) if (snapshot.researchReadiness) {
    const { run_id: runId, assessment_sha256: hash } = snapshot.researchReadiness;
    if (hashes.has(runId) && hashes.get(runId) !== hash) conflicts.add(runId);
    hashes.set(runId, hash);
  }
  const reject = <T extends AnalysisTask | ReportVersion>(snapshot: T): T => snapshot.researchReadiness && conflicts.has(snapshot.researchReadiness.run_id)
    ? { ...snapshot, researchReadiness: undefined, readinessValidation: { status: "invalid", reason: "reference_mismatch" } } : snapshot;
  return normalized.map((task) => Array.isArray(task.reportVersions) ? { ...reject(task), reportVersions: task.reportVersions.map(reject) } : reject(task));
}
export async function verifySavedReadiness<T extends AnalysisTask | ReportVersion>(value: T): Promise<T> {
  const safe = safeSnapshot(value);
  if (!safe.researchReadiness || safe.readinessValidation) return safe;
  try { return bindSnapshot({ ...safe, researchReadiness: await verifyResearchReadiness(safe.researchReadiness, clone(safe.evidenceBundle)) }); }
  catch (error) { return { ...safe, researchReadiness: undefined, readinessValidation: invalidReadiness(error) }; }
}
export async function verifyTaskReadiness(task: AnalysisTask): Promise<AnalysisTask> {
  const safe = normalizeTaskReadiness(task);
  return Array.isArray(safe.reportVersions) ? { ...await verifySavedReadiness(safe), reportVersions: await Promise.all(safe.reportVersions.map(verifySavedReadiness)) } : verifySavedReadiness(safe);
}
export async function verifyReadinessTasks(tasks: AnalysisTask[]): Promise<AnalysisTask[]> {
  return normalizeReadinessTasks(await Promise.all(normalizeReadinessTasks(tasks).map(verifyTaskReadiness)));
}
export async function readinessFromEvent(event: AnalysisEvent, evidence: EvidenceBundle | undefined): Promise<ReadinessFields | undefined> {
  const top = event.researchReadiness; const nested = event.finalState?.research_readiness;
  if (top === undefined && nested === undefined) return undefined;
  try {
    const readiness = await verifyResearchReadiness(top ?? nested, evidence);
    if (top !== undefined && nested !== undefined) assert((await verifyResearchReadiness(nested, evidence)).assessment_sha256 === readiness.assessment_sha256, "reference_mismatch");
    return { researchReadiness: readiness, readinessValidation: undefined };
  } catch (error) { return { researchReadiness: undefined, readinessValidation: invalidReadiness(error) }; }
}
