import { resolveTaskDecision } from "@/components/task-center/decisions";
import { mergeEventOutputQuality, normalizeOutputQuality } from "@/features/output-quality/lib/quality";
import { mergeRuntimeManifest } from "./runtime-settings";
import { normalizeTaskEvidence } from "@/features/evidence/lib/validation";
import packageMetadata from "../../../../package.json";
import type {
  AnalysisEvent,
  AnalysisForm,
  AnalysisTask,
  ReportTaskSnapshot,
  ReportVersion,
  RunContext,
} from "@/lib/types";

export function createRunContext(form: AnalysisForm, runId = crypto.randomUUID()): RunContext {
  return {
    runId,
    manifest: {
      appVersion: packageMetadata.version,
      llmProvider: form.llmProvider,
      quickThinkLlm: form.quickThinkLlm,
      deepThinkLlm: form.deepThinkLlm,
      coreStockApis: form.coreStockApis,
      technicalIndicators: form.technicalIndicators,
      fundamentalData: form.fundamentalData,
      newsData: form.newsData,
      maxDebateRounds: form.maxDebateRounds,
      maxRiskRounds: form.maxRiskRounds,
      benchmarkTicker: form.benchmarkTicker,
    },
  };
}

export function appendCompletedReportVersion(
  task: AnalysisTask,
  event: AnalysisEvent,
  runContext: RunContext,
  createdAt = new Date().toISOString(),
): AnalysisTask {
  if (event.type !== "completed" || task.origin === "demo") return task;
  const evidenceTask = normalizeTaskEvidence({ ...task, evidenceBundle: task.evidenceValidation ? undefined : event.evidenceBundle ?? task.evidenceBundle });
  const runId = evidenceTask.evidenceBundle?.run_id ?? runContext.runId;
  if (task.reportVersions.some((version) => version.runId === runId)) return task;

  const reportSections = event.reportSections ?? task.reportSections;
  if (!hasReportContent(reportSections)) return task;

  const nextVersionNumber = task.reportVersions.reduce(
    (maximum, version) => Math.max(maximum, version.versionNumber),
    0,
  ) + 1;
  const version: ReportVersion = {
    id: crypto.randomUUID(),
    runId,
    versionNumber: nextVersionNumber,
    createdAt,
    legacy: false,
    task: taskSnapshot(task),
    run: mergeRuntimeManifest(runContext.manifest, event.runSettings),
    decision: resolveTaskDecision(task.decision, reportSections.final_trade_decision, event),
    stats: { ...(event.stats ?? task.stats) },
    reportSections: { ...reportSections },
    outputQuality: mergeEventOutputQuality(task.outputQuality, event),
    evidenceBundle: evidenceTask.evidenceBundle,
    evidenceValidation: evidenceTask.evidenceValidation,
  };

  return normalizeTaskEvidence({ ...task, reportVersions: [...task.reportVersions, version] });
}

export function ensureLegacyReportVersion(task: AnalysisTask): AnalysisTask {
  if (
    task.status !== "completed"
    || task.reportVersions.length > 0
    || !hasReportContent(task.reportSections)
  ) {
    return task;
  }

  const version: ReportVersion = {
    id: `legacy-report-${task.id}`,
    runId: `legacy-run-${task.id}`,
    versionNumber: 1,
    createdAt: task.updatedAt || task.createdAt,
    legacy: true,
    task: taskSnapshot(task),
    run: null,
    decision: task.decision,
    stats: { ...task.stats },
    reportSections: { ...task.reportSections },
    outputQuality: normalizeOutputQuality(task.outputQuality),
    evidenceBundle: task.evidenceBundle,
    evidenceValidation: task.evidenceValidation,
  };
  return normalizeTaskEvidence({ ...task, reportVersions: [version] });
}

export function hasReportContent(sections: Record<string, string | null | undefined>) {
  return Object.values(sections).some((content) => Boolean(content?.trim()));
}

function taskSnapshot(task: AnalysisTask): ReportTaskSnapshot {
  return {
    ticker: task.ticker,
    instrumentName: task.instrumentName,
    analysisDate: task.analysisDate,
    assetType: task.assetType,
    researchDepth: task.researchDepth,
    analysts: [...task.analysts],
    outputLanguage: task.outputLanguage,
  };
}
