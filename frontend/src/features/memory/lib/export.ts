import type { ReportVersion, SystemLanguage } from "@/lib/types";
import type { DecisionSnapshot, MemoryBundle, ReviewAttachment } from "../types";
import { copyMemoryBundle, copyReviewAttachment, MemoryError, verifySavedMemory } from "./validation";
import { assertReviewHistory } from "./decision";

export const memoryNotice = (language: SystemLanguage) => language === "zh"
  ? "采用原生币种的供应商调整收盘价，比较匹配日标签的参考收益；不代表可执行成交、已实现策略损益或风险调整 alpha。价格版本、发表时间和独立交易所日历覆盖未知。"
  : "Provider-adjusted closes measure reference returns in native currencies on matched daily labels. They do not establish executable fills, realized strategy profit, or risk-adjusted alpha. Price vintage, publication time, and independent exchange-calendar coverage are unknown.";
export const memoryAbsent = (language: SystemLanguage) => language === "zh" ? "此版本未保存不可变记忆附件；决策、评估合约与历史可用性未知。" : "No immutable memory attachment was saved for this version; decision contracts and historical availability are unknown.";
export function memorySummary(bundle: MemoryBundle, snapshot = bundle.decision_snapshot, language: SystemLanguage): [string, string][] {
  const zh = language === "zh"; const { decision, contract, outcome, reflection } = snapshot;
  return [
    [zh ? "决策 ID" : "Decision ID", snapshot.run_id], [zh ? "研究开始（UTC）" : "Research started (UTC)", decision.research_started_at],
    [zh ? "实际决策完成（UTC）" : "Actual decision completion (UTC)", decision.recorded_at], [zh ? "主机日期策略" : "Host calendar policy", `${decision.analysis_calendar_date} (${decision.host_utc_offset}); host local, not market timezone`],
    [zh ? "冻结的基准" : "Frozen benchmark", contract.resolved_benchmark], [zh ? "冻结的评估期限" : "Frozen evaluation horizon", `${contract.holding_period_days} common complete provider daily rows`],
    [zh ? "评估模式" : "Evaluation mode", contract.evaluation_mode], [zh ? "评估器版本" : "Evaluator version", contract.evaluator_version],
    [zh ? "评估状态" : "Evaluation status", outcome ? `${outcome.status}${outcome.reason ? ` · ${outcome.reason}` : ""}` : (zh ? "未保存完整的评估事实；原因未知" : "No complete evaluation facts saved; cause unknown")],
    [zh ? "事实观测（UTC）" : "Facts observed (UTC)", outcome?.observed_at ?? (zh ? "未知" : "Unknown")],
    [zh ? "反思完成（UTC）" : "Reflection completed (UTC)", reflection?.reflected_at ?? (zh ? "未保存" : "Not saved")],
    [zh ? "持久化" : "Persistence", bundle.persistence_status === "durable" ? "durable" : "memory_only · not retained for later inventory"],
    [zh ? "记忆选择时间（UTC）" : "Memory selected (UTC)", bundle.input_snapshot.selected_at],
    [zh ? "研究截止（UTC）" : "Research cutoff (UTC)", bundle.input_snapshot.research_cutoff],
    [zh ? "记忆可用性截止（UTC）" : "Memory availability cutoff (UTC)", bundle.input_snapshot.availability_cutoff],
    [zh ? "使用的历史记录" : "Prior records used", String(bundle.input_snapshot.decisions.length)],
  ];
}
export function copyExportMemory(version: ReportVersion): { bundle?: MemoryBundle; reviews: ReviewAttachment[]; invalid?: string } {
  if (version.memoryValidation) return { invalid: version.memoryValidation.reason, reviews: [] };
  if (!version.memoryBundle) return version.evaluationReviews?.length ? { reviews: [], invalid: "reference_mismatch" } : { reviews: [] };
  try {
    const bundle = copyMemoryBundle(version.memoryBundle, version.evidenceBundle);
    const decision = bundle.decision_snapshot;
    if (bundle.run_id !== version.runId || bundle.instrument !== version.task.ticker || bundle.analysis_date !== version.task.analysisDate || decision.decision.asset_type !== version.task.assetType || decision.artifacts[decision.decision.decision_text_sha256].payload !== version.reportSections.final_trade_decision || decision.decision.rating !== version.decision) throw new MemoryError("reference_mismatch");
    const reviews = (version.evaluationReviews ?? []).map((item) => copyReviewAttachment(item, bundle));
    assertReviewHistory(reviews);
    return { bundle, reviews };
  } catch (error) { return { reviews: [], invalid: error instanceof MemoryError ? error.reason : "malformed" }; }
}
export async function verifiedExportVersion(version: ReportVersion): Promise<ReportVersion> {
  const verified = await verifySavedMemory(version);
  if (verified.memoryValidation) throw new MemoryError(verified.memoryValidation.reason);
  return verified;
}
export function snapshotCalculation(snapshot: DecisionSnapshot) { return snapshot.outcome?.calculation_sha256 ? snapshot.artifacts[snapshot.outcome.calculation_sha256].payload : ""; }
