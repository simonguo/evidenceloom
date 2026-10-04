import type { AnalysisEvent, AnalysisTask, ReportVersion } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import { copyEvidenceBundle, verifyEvidenceBundle } from "@/features/evidence/lib/validation";
import { clone, day, exact, hash, stamp, text, timestamp, uuid } from "@/features/memory/lib/guards";
import type { NumericValidation, ReportTextSnapshot } from "../types";
import { checkHash, fixed, NumericError, rawBytes, requireNumeric, safeBounded, same } from "./guards";
import { numericPolicy, sectionKeys } from "./policy";
export function copyReportTextSnapshot(value: unknown, evidenceValue: unknown): ReportTextSnapshot {
    try {
        return copySnapshotAgainstEvidence(value, copyEvidenceBundle(evidenceValue));
    }
    catch (error) {
        return fixed(error);
    }
}
/** Internal batch entry point; evidence has already been copied and validated. */
export function copySnapshotAgainstEvidence(value: unknown, evidence: EvidenceBundle): ReportTextSnapshot {
    try {
        safeBounded(value);
        exact(value, ["schema_version", "run_id", "instrument", "analysis_date", "captured_at", "evidence_bundle_sha256", "report_sections", "snapshot_sha256"]);
        requireNumeric(value.schema_version === 1 && uuid(value.run_id) && text(value.instrument) && value.instrument && day(value.analysis_date) && timestamp(value.captured_at) && /\.[0-9]{6}Z$/.test(value.captured_at) && hash(value.evidence_bundle_sha256) && hash(value.snapshot_sha256));
        exact(value.report_sections, sectionKeys);
        for (const section of Object.values(value.report_sections))
            requireNumeric(section === null || (text(section) && rawBytes(section).length <= numericPolicy.max_section_bytes));
        requireNumeric(value.run_id === evidence.run_id && value.instrument === evidence.instrument && value.analysis_date === evidence.analysis_date && value.evidence_bundle_sha256 === evidence.bundle_sha256, "reference_mismatch");
        requireNumeric([evidence.created_at, ...evidence.records.map((record) => record.fetched_at)].every((at) => stamp(value.captured_at as string) >= stamp(at)), "reference_mismatch");
        return clone(value) as ReportTextSnapshot;
    }
    catch (error) {
        return fixed(error);
    }
}
export async function verifyReportTextSnapshot(value: unknown, evidenceValue: unknown): Promise<ReportTextSnapshot> {
    const snapshot = copyReportTextSnapshot(value, evidenceValue);
    try {
        await verifyEvidenceBundle(clone(evidenceValue), snapshot.report_sections);
        await checkHash(snapshot as unknown as Record<string, unknown>, "snapshot_sha256");
        return snapshot;
    }
    catch (error) {
        return fixed(error);
    }
}
export function bindReportSnapshot<T extends AnalysisTask | ReportVersion>(value: T, snapshot: ReportTextSnapshot): T {
    const identity = "task" in value ? (value as ReportVersion).task : value as AnalysisTask;
    requireNumeric(snapshot.instrument === identity.ticker && snapshot.analysis_date === identity.analysisDate && (!("task" in value) || value.runId === snapshot.run_id), "reference_mismatch");
    const sections = Object.fromEntries(sectionKeys.map((key) => [key, value.reportSections[key] ?? null]));
    requireNumeric(same(sections, snapshot.report_sections), "reference_mismatch");
    if (value.memoryBundle)
        requireNumeric(stamp(snapshot.captured_at) >= stamp(value.memoryBundle.decision_snapshot.decision.recorded_at), "reference_mismatch");
    return { ...value, reportTextSnapshot: snapshot };
}
export function invalidNumeric(error: unknown): NumericValidation { return { status: "invalid", reason: error instanceof NumericError ? error.reason : "malformed" }; }
export function copySnapshotFromEvent(event: AnalysisEvent, evidence: EvidenceBundle | undefined) {
    const top = event.reportTextSnapshot, nested = event.finalState?.report_text_snapshot;
    if (top === undefined && nested === undefined)
        return undefined;
    try {
        const snapshot = copyReportTextSnapshot(top === undefined ? nested : top, evidence);
        if (top !== undefined && nested !== undefined)
            requireNumeric(copyReportTextSnapshot(nested, evidence).snapshot_sha256 === snapshot.snapshot_sha256, "reference_mismatch");
        return { reportTextSnapshot: snapshot, numericValidation: undefined };
    }
    catch (error) {
        return { reportTextSnapshot: undefined, numericValidation: invalidNumeric(error) };
    }
}
export async function reportSnapshotFromEvent(event: AnalysisEvent, evidence: EvidenceBundle | undefined) {
    const top = event.reportTextSnapshot, nested = event.finalState?.report_text_snapshot;
    if (top === undefined && nested === undefined)
        return undefined;
    try {
        const snapshot = await verifyReportTextSnapshot(top === undefined ? nested : top, evidence);
        if (top !== undefined && nested !== undefined)
            requireNumeric((await verifyReportTextSnapshot(nested, evidence)).snapshot_sha256 === snapshot.snapshot_sha256, "reference_mismatch");
        return { reportTextSnapshot: snapshot, numericValidation: undefined };
    }
    catch (error) {
        return { reportTextSnapshot: undefined, numericValidation: invalidNumeric(error) };
    }
}
