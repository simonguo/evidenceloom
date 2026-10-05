import readinessFixture from "../../../../../tests/fixtures/research_readiness_v1.json";
import evidenceFixture from "../../../../../tests/fixtures/research_readiness_evidence_v1.json";
import type { AnalysisTask, SystemLanguage } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import { createFictionalDemoTask } from "@/features/report-export/fixtures/fictional-demo";
import type { ResearchReadiness } from "../types";

/** Python-generated provider-row checks, with an explicitly fictional report. */
export function createFictionalReadinessDemoTask(language: SystemLanguage): AnalysisTask {
  const original = createFictionalDemoTask(language);
  const readiness = structuredClone(readinessFixture) as ResearchReadiness;
  const evidence = structuredClone(evidenceFixture) as EvidenceBundle;
  const zh = language === "zh";
  const reports = {
    market_report: zh ? "完全虚构的离线示例：保存了供应商日标签、完整精度的输入和指标历史检查。输入检查不证明市场事实或预测价值。" : "Entirely fictional offline example: provider daily labels, full-precision inputs and indicator history checks were saved. Input checks do not establish market facts or predictive value.",
    final_trade_decision: zh ? "**Rating**: Hold\n\n**Executive Summary**: 此完全虚构示例采用均衡观点，仅用于审阅保存的输入合同。\n\n**Investment Thesis**: 不构成任何真实标的的投资建议。" : "**Rating**: Hold\n\n**Executive Summary**: This entirely fictional example uses a balanced view solely to demonstrate a saved input contract.\n\n**Investment Thesis**: It is not an investment recommendation for a real instrument.",
  };
  const instrumentName = zh ? "完全虚构的输入检查示例" : "Entirely fictional input-check example";
  const stats = { llmCalls: 0, toolCalls: 1, tokensIn: 0, tokensOut: 0, elapsedSeconds: 0 };
  const task = { ...original, id: "evidenceloom-fictional-readiness-demo", ticker: evidence.instrument, instrumentName, analysisDate: evidence.analysis_date, stats,
    analysts: [...readiness.policy.selected_analysts], reportSections: reports, evidenceBundle: evidence, researchReadiness: readiness,
    createdAt: readiness.policy.research_started_at, updatedAt: readiness.policy.research_started_at };
  const version = { ...original.reportVersions[0], id: "fictional-readiness-version", runId: evidence.run_id,
    createdAt: readiness.policy.research_started_at, stats: { ...stats }, task: { ...original.reportVersions[0].task, ticker: evidence.instrument, instrumentName, analysisDate: evidence.analysis_date, analysts: [...readiness.policy.selected_analysts] },
    reportSections: { ...reports }, evidenceBundle: structuredClone(evidence), researchReadiness: structuredClone(readiness),
    run: original.reportVersions[0].run ? { ...original.reportVersions[0].run, runtimeRunSettings: { analysts: [...readiness.policy.selected_analysts], max_tool_rounds: readiness.policy.max_tool_rounds, research_readiness_policy_sha256: readiness.policy.policy_sha256 } } : null };
  return { ...task, reportVersions: [version] };
}
