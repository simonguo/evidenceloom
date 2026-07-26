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
  if (task.reportVersions.some((version) => version.runId === runContext.runId)) return task;

  const reportSections = event.reportSections ?? task.reportSections;
  if (!hasReportContent(reportSections)) return task;

  const nextVersionNumber = task.reportVersions.reduce(
    (maximum, version) => Math.max(maximum, version.versionNumber),
    0,
  ) + 1;
  const version: ReportVersion = {
    id: crypto.randomUUID(),
    runId: runContext.runId,
    versionNumber: nextVersionNumber,
    createdAt,
    legacy: false,
    task: taskSnapshot(task),
    run: { ...runContext.manifest },
    decision: event.decision || task.decision,
    stats: { ...(event.stats ?? task.stats) },
    reportSections: { ...reportSections },
  };

  return { ...task, reportVersions: [...task.reportVersions, version] };
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
  };
  return { ...task, reportVersions: [version] };
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
