import shared from "../../../../../tests/fixtures/effective_request_identity_v1.json";
import { createEmptyTask } from "@/lib/analysis";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import { copyEvidenceBundle } from "@/features/evidence/lib/validation";
import type { ReportTextSnapshot } from "@/features/numeric-review/types";
import type { EffectiveRequestIdentity } from "../types";
export function identityFixture(): AnalysisTask {
  const evidence = copyEvidenceBundle(shared.evidence),
    snapshot = structuredClone(shared.snapshot) as ReportTextSnapshot,
    assessment = structuredClone(shared.assessment) as EffectiveRequestIdentity;
  const task = createEmptyTask(
    {
      ticker: snapshot.instrument,
      instrumentName: "Fictional saved request alignment",
      analysisDate: snapshot.analysis_date,
      assetType: "stock",
      researchDepth: 1,
      analysts: ["market"],
      outputLanguage: "English",
    },
    "task-identity-fictional",
    snapshot.captured_at,
  );
  const version: ReportVersion = {
    id: "version-identity-fictional",
    runId: snapshot.run_id,
    versionNumber: 2,
    createdAt: snapshot.captured_at,
    legacy: false,
    task: {
      ticker: task.ticker,
      instrumentName: task.instrumentName,
      analysisDate: task.analysisDate,
      assetType: task.assetType,
      researchDepth: task.researchDepth,
      analysts: [...task.analysts],
      outputLanguage: task.outputLanguage,
    },
    run: null,
    decision: "REVIEW",
    stats: { ...task.stats },
    reportSections: structuredClone(snapshot.report_sections),
    evidenceBundle: structuredClone(evidence),
    reportTextSnapshot: structuredClone(snapshot),
    effectiveRequestIdentity: structuredClone(assessment),
    numericReviews: [],
    evaluationReviews: [],
  };
  const legacy: ReportVersion = {
    ...structuredClone(version),
    id: "version-identity-legacy",
    runId: "legacy-identity-run",
    versionNumber: 1,
    legacy: true,
    evidenceBundle: undefined,
    reportTextSnapshot: undefined,
    effectiveRequestIdentity: undefined,
    reportSections: { market_report: "Historical report without a saved request assessment." },
  };
  return {
    ...task,
    origin: "demo",
    status: "completed",
    decision: "REVIEW",
    evidenceBundle: evidence,
    reportTextSnapshot: snapshot,
    effectiveRequestIdentity: assessment,
    reportSections: structuredClone(snapshot.report_sections),
    reportVersions: [version, legacy],
  };
}
export { shared as identitySharedFixture };
