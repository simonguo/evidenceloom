import type { ReportVersion, SystemLanguage } from "@/lib/types";
import type { DecisionSnapshot, MemoryBundle, ReviewAttachment } from "../types";
import { copyMemoryBundle, copyReviewAttachment, MemoryError, verifySavedMemory } from "./validation";
import { assertReviewHistory } from "./decision";

export const memoryNotice = (language: SystemLanguage) => language === "zh"
  ? "采用原生币种的供应商调整收盘价，比较匹配日标签的参考收益；不代表可执行成交、已实现策略损益或风险调整 alpha。价格版本、发表时间和独立交易所日历覆盖未知。保存的请求不证明供应商返回实体或证券身份；代理品种的参考收益不代表原请求资产的表现。结构、引用和内容哈希核验不代表独立重算，本查看器不确认历史输入是否适用于新的模型运行。"
  : "Provider-adjusted closes measure reference returns in native currencies on matched daily labels. They do not establish executable fills, realized strategy profit, or risk-adjusted alpha. Price vintage, publication time, and independent exchange-calendar coverage are unknown. Saved requests do not confirm the provider entity or security identity; proxy reference returns do not establish requested-asset performance. Structure, reference and content-hash checks are not independent arithmetic replay; this viewer does not establish eligibility of saved context for a new model run.";
export const memoryExportVerificationScope = {
  content_checks: "structure_references_and_hashes",
  arithmetic_replay: "not_performed_by_exporter",
  model_eligibility: "not_established_by_exporter",
} as const;
export const memoryAbsent = (language: SystemLanguage) => language === "zh" ? "此版本未保存不可变记忆附件；决策、评估合约与历史可用性未知。" : "No immutable memory attachment was saved for this version; decision contracts and historical availability are unknown.";
export function memorySummary(bundle: MemoryBundle, snapshot = bundle.decision_snapshot, language: SystemLanguage): [string, string][] {
  const zh = language === "zh"; const { decision, contract, outcome, reflection } = snapshot;
  return [
    [zh ? "决策 ID" : "Decision ID", snapshot.run_id], [zh ? "研究开始（UTC）" : "Research started (UTC)", decision.research_started_at],
    [zh ? "实际决策完成（UTC）" : "Actual decision completion (UTC)", decision.recorded_at], [zh ? "主机日期策略" : "Host calendar policy", `${decision.analysis_calendar_date} (${decision.host_utc_offset}); host local, not market timezone`],
    [zh ? "冻结的基准" : "Frozen benchmark", contract.resolved_benchmark], [zh ? "冻结的评估期限" : "Frozen evaluation horizon", `${contract.holding_period_days} common complete provider daily rows`],
    [zh ? "评估模式" : "Evaluation mode", contract.evaluation_mode], [zh ? "评估器版本" : "Evaluator version", contract.evaluator_version],
    [zh ? "合约版本" : "Contract version", String(contract.schema_version)],
    ...targetSummary(snapshot, language),
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
function targetSummary(snapshot: DecisionSnapshot, language: SystemLanguage): [string, string][] {
  const zh = language === "zh";
  if (snapshot.contract.schema_version === 1) {
    return [[zh ? "开始时的目标绑定" : "Start-time target binding", zh ? "未知；旧版合约未冻结供应商请求目标" : "Unknown; legacy contract did not freeze provider request targets"],
      ...(!snapshot.outcome ? [[zh ? "只读评估资格" : "Read-only evaluation eligibility", "unknown · legacy_target_not_frozen"] as [string, string]] : [])];
  }
  const binding = snapshot.contract.target_binding;
  const relations = {
    exact: zh ? "请求字面量原样" : "Exact request literal",
    venue_notation: zh ? "交易场所记法转换" : "Venue notation conversion",
    pair_notation: zh ? "币对记法转换" : "Pair notation conversion",
    proxy: zh ? "代理参考品种；不是原请求资产" : "Proxy reference; not the requested asset",
    unknown: zh ? "未知；没有可用的冻结请求" : "Unknown; no usable frozen request",
  };
  return binding.targets.map((target) => [
    target.role === "instrument" ? (zh ? "冻结的研究对象请求" : "Frozen instrument request") : (zh ? "冻结的基准请求" : "Frozen benchmark request"),
    `${target.requested_symbol} → ${target.request_symbol ?? (zh ? "未知" : "Unknown")} · ${binding.provider}/${binding.request_namespace} · ${relations[target.relation]}`,
  ]);
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
