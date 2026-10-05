import type { SystemLanguage } from "@/lib/types";
import type { ResearchReadiness } from "../types";

export const readinessNotice = (language: SystemLanguage) => language === "zh"
  ? "输入检查只确认已记录的来源、数据完整性与时间条件；不证明报告事实、数字陈述、投资结论或预测价值。来源日期与价格版本未知时，不能推断历史可用性或独立交易所日历覆盖。"
  : "Input checks establish recorded source, integrity and timing conditions only. They do not prove factual claims, numerical statements, investment conclusions or predictive value. Unknown source dates and price vintage do not establish historical availability or independent exchange-calendar coverage.";
export const readinessAbsent = (language: SystemLanguage) => language === "zh" ? "此版本未保存研究输入检查合同；就绪状态未知。" : "No research input-check contract was saved for this version; readiness is unknown.";
export function readinessStatus(bundle: ResearchReadiness, language: SystemLanguage) {
  const zh = language === "zh";
  return bundle.status === "ready" ? (zh ? "已满足记录的必需输入条件" : "Recorded required input conditions passed")
    : bundle.status === "insufficient_evidence" ? (zh ? "必需证据不足 · 评级待复核" : "Required evidence insufficient · REVIEW")
      : (zh ? "输入条件需复核 · 评级待复核" : "Input conditions require review · REVIEW");
}
export function checkLabel(key: string, language: SystemLanguage) {
  const labels: Record<string, [string, string]> = {
    temporal_availability: ["时间可用性", "Temporal availability"], market_verification: ["市场数据检查", "Market data checks"], indicator_warmup: ["指标历史长度", "Indicator input history"],
    price_vintage: ["价格版本", "Price vintage"], exchange_calendar_coverage: ["交易所日历覆盖", "Exchange-calendar coverage"],
    "selected_sources.market": ["行情来源观测", "Market source observations"], "selected_sources.social": ["情绪来源观测", "Sentiment source observations"],
    "selected_sources.news": ["新闻来源观测", "News source observations"], "selected_sources.fundamentals": ["基本面来源观测", "Fundamentals source observations"],
  };
  return labels[key]?.[language === "zh" ? 0 : 1] ?? key;
}
export function readinessSummary(bundle: ResearchReadiness, language: SystemLanguage): [string, string][] {
  const zh = language === "zh";
  return [[zh ? "输入检查结果" : "Input-check result", readinessStatus(bundle, language)], [zh ? "运行 ID" : "Run ID", bundle.run_id],
    [zh ? "允许方向评级" : "Directional recommendation allowed", String(bundle.recommendation_allowed)], [zh ? "冻结政策" : "Frozen policy", bundle.policy.policy_version],
    [zh ? "实际研究开始（UTC）" : "Actual research start (UTC)", bundle.policy.research_started_at], [zh ? "研究截止（UTC）" : "Research cutoff (UTC)", bundle.policy.research_as_of],
    [zh ? "主机日期 / 偏移" : "Host date / offset", `${bundle.policy.research_calendar_date} ${bundle.policy.host_utc_offset} (host local, not market timezone)`],
    [zh ? "时间模式" : "Temporal mode", bundle.policy.temporal_mode], [zh ? "选定分析师" : "Selected analyst scope", bundle.policy.selected_analysts.join(", ")],
    [zh ? "冻结工具轮数上限" : "Frozen tool-round limit", String(bundle.policy.max_tool_rounds)], [zh ? "证据记录数" : "Evidence records checked", String(bundle.evidence_inputs.length)],
    [zh ? "合同 SHA-256" : "Assessment SHA-256", bundle.assessment_sha256]];
}
