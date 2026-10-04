import shared from "../../../../../tests/fixtures/numeric_review_v1.json";
import { createEmptyTask } from "@/lib/analysis";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import type { NumericReview, ReportTextSnapshot } from "../types";
export function numericFixture(includeReviews = true): AnalysisTask {
    const evidence = structuredClone(shared.evidence) as EvidenceBundle;
    const snapshot = structuredClone(shared.snapshot) as ReportTextSnapshot;
    const task = createEmptyTask({ ticker: "FICT", instrumentName: "Fictional numeric review", analysisDate: snapshot.analysis_date, assetType: "stock", researchDepth: 1, analysts: ["market"], outputLanguage: "English" }, "task-fictional", snapshot.captured_at);
    const version: ReportVersion = { id: "version-fictional", runId: snapshot.run_id, versionNumber: 2, createdAt: snapshot.captured_at, legacy: false, task: { ticker: task.ticker, instrumentName: task.instrumentName, analysisDate: task.analysisDate, assetType: task.assetType, researchDepth: task.researchDepth, analysts: task.analysts, outputLanguage: task.outputLanguage }, run: null, decision: "REVIEW", stats: { ...task.stats }, reportSections: structuredClone(snapshot.report_sections), evidenceBundle: structuredClone(evidence), reportTextSnapshot: structuredClone(snapshot), numericReviews: includeReviews ? structuredClone(shared.reviews) as NumericReview[] : [], evaluationReviews: [] };
    const legacy: ReportVersion = { ...structuredClone(version), id: "version-legacy-numeric", runId: "legacy-run-numeric", versionNumber: 1, legacy: true, evidenceBundle: undefined, reportTextSnapshot: undefined, numericReviews: [], reportSections: { market_report: "Historical prose without a frozen completion snapshot." } };
    return { ...task, status: "completed", decision: "REVIEW", reportSections: structuredClone(snapshot.report_sections), evidenceBundle: evidence, reportTextSnapshot: snapshot, reportVersions: [version, legacy] };
}
export { shared as numericSharedFixture };
