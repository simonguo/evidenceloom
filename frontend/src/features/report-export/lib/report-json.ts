import { copyExportIdentity } from "@/features/source-identity/lib/export";
import { copyNumericExport } from "@/features/numeric-review/lib/export";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import { normalizeOutputQuality } from "@/features/output-quality/lib/quality";
import { copyExportReadiness } from "@/features/research-readiness/lib/export";
import { sanitizeRuntimeSettings } from "./runtime-settings";
import { memoryExportVerificationScope } from "@/features/memory/lib/export";

/** Export the report protocol's public fields, never arbitrary saved metadata. */
export function reportJson(taskId: string, origin: AnalysisTask["origin"], version: ReportVersion, { memoryHashesVerified = false } = {}) {
  const { task, run, stats } = version;
  const report = {
    task_id: taskId, origin, id: version.id, runId: version.runId, versionNumber: version.versionNumber,
    createdAt: version.createdAt, legacy: version.legacy, decision: version.decision,
    task: { ticker: task.ticker, instrumentName: task.instrumentName, analysisDate: task.analysisDate, assetType: task.assetType,
      researchDepth: task.researchDepth, analysts: [...task.analysts], outputLanguage: task.outputLanguage },
    run: run ? { appVersion: run.appVersion, coreVersion: run.coreVersion, llmProvider: run.llmProvider,
      quickThinkLlm: run.quickThinkLlm, deepThinkLlm: run.deepThinkLlm, coreStockApis: run.coreStockApis,
      technicalIndicators: run.technicalIndicators, fundamentalData: run.fundamentalData, newsData: run.newsData,
      maxDebateRounds: run.maxDebateRounds, maxRiskRounds: run.maxRiskRounds, benchmarkTicker: run.benchmarkTicker,
      holdingPeriodDays: run.holdingPeriodDays,
      toolVendors: run.toolVendors ? sanitizeRuntimeSettings({ tool_vendors: run.toolVendors }).tool_vendors : undefined,
      runtimeRunSettings: run.runtimeRunSettings ? sanitizeRuntimeSettings(run.runtimeRunSettings) : undefined } : null,
    stats: { llmCalls: stats.llmCalls, toolCalls: stats.toolCalls, tokensIn: stats.tokensIn, tokensOut: stats.tokensOut, elapsedSeconds: stats.elapsedSeconds },
    reportSections: Object.fromEntries(["market_report", "sentiment_report", "news_report", "fundamentals_report", "investment_plan", "trader_investment_plan", "final_trade_decision"].filter((key) => Object.hasOwn(version.reportSections, key)).map((key) => [key, version.reportSections[key]])),
    outputQuality: normalizeOutputQuality(version.outputQuality),
  };
  return { ...copyNumericExport(taskId, version), schema_version: 1, kind: "research_report", report, evidence_bundle: version.evidenceBundle ?? null,
    ...(version.memoryBundle && memoryHashesVerified ? { memory_verification_scope: memoryExportVerificationScope } : {}),
    memory_bundle: version.memoryBundle ?? null, evaluation_reviews: version.evaluationReviews ?? [], research_readiness: copyExportReadiness(version) ?? null, effective_request_identity: copyExportIdentity(version) };
}
