import type { AnalysisEvent, AnalysisTask, SystemLanguage } from "@/lib/types";
import type { OutputQuality, OutputQualityAgent, OutputQualityReason, OutputQualityView } from "../types";

const schemas = {
  sentiment: "SentimentReport",
  research_manager: "ResearchPlan",
  trader: "TraderProposal",
  portfolio_manager: "PortfolioDecision",
} as const;
const reasons: OutputQualityReason[] = ["structured_unavailable", "no_tool_call", "schema_validation_failed", "unsupported_format"];

export function normalizeOutputQuality(value: unknown): OutputQuality | undefined {
  if (!isRecord(value)) return undefined;
  const safe: OutputQuality = {};
  for (const agent of Object.keys(schemas) as OutputQualityAgent[]) {
    const record = value[agent];
    if (!isRecord(record) || record.schema !== schemas[agent]) continue;
    if (record.status === "validated_schema" && record.source === "structured" && record.reason === undefined) {
      safe[agent] = { status: "validated_schema", schema: schemas[agent], source: "structured" };
    } else if (
      record.status === "unvalidated_text"
      && (record.source === "raw_response" || record.source === "plain_generation")
      && reasons.includes(record.reason as OutputQualityReason)
    ) {
      safe[agent] = {
        status: "unvalidated_text", schema: schemas[agent], source: record.source,
        reason: record.reason as OutputQualityReason,
      };
    }
  }
  return Object.keys(safe).length ? safe : undefined;
}

export function mergeEventOutputQuality(previous: unknown, event: AnalysisEvent): OutputQuality | undefined {
  const current = normalizeOutputQuality(event.outputQuality ?? event.finalState?.output_quality);
  return normalizeOutputQuality({ ...normalizeOutputQuality(previous), ...current });
}

export function normalizeTaskOutputQuality(task: AnalysisTask): AnalysisTask {
  return {
    ...task,
    outputQuality: normalizeOutputQuality(task.outputQuality),
    ...(Array.isArray(task.reportVersions) ? {
      reportVersions: task.reportVersions.map((version) => ({
        ...version,
        outputQuality: normalizeOutputQuality(version.outputQuality),
      })),
    } : {}),
  };
}

export function buildOutputQualityView(value: unknown, language: SystemLanguage): OutputQualityView {
  const quality = normalizeOutputQuality(value);
  const zh = language === "zh";
  const agents = zh
    ? { sentiment: "情绪分析师", research_manager: "研究经理", trader: "交易员", portfolio_manager: "组合经理" }
    : { sentiment: "Sentiment Analyst", research_manager: "Research Manager", trader: "Trader", portfolio_manager: "Portfolio Manager" };
  const reasonLabels: Record<OutputQualityReason, string> = zh ? {
    structured_unavailable: "模型未提供可用的结构化输出。",
    no_tool_call: "模型没有返回结构化结果。",
    schema_validation_failed: "输出未通过字段和类型校验。",
    unsupported_format: "响应格式不受支持。",
  } : {
    structured_unavailable: "Structured output was unavailable.",
    no_tool_call: "The model returned no structured result.",
    schema_validation_failed: "The output failed field and type validation.",
    unsupported_format: "The response format was unsupported.",
  };
  const entries = (Object.keys(schemas) as OutputQualityAgent[]).flatMap((agent) => {
    const record = quality?.[agent];
    if (!record) return [];
    const validated = record.status === "validated_schema";
    return [{
      agent: agents[agent], schema: record.schema, validated,
      status: validated ? (zh ? "格式已验证" : "Format validated") : (zh ? "文本回退 · 格式未验证" : "Text fallback · format unvalidated"),
      source: record.source === "structured" ? (zh ? "结构化输出" : "Structured output")
        : record.source === "raw_response" ? (zh ? "保留原始响应" : "Original response retained")
          : (zh ? "自由文本生成" : "Free-text generation"),
      reason: record.reason ? reasonLabels[record.reason] : "",
    }];
  });
  return {
    title: zh ? "输出格式质量" : "Output format quality",
    disclaimer: zh
      ? "格式验证仅检查输出字段和类型，不证明事实、数据来源或研究结论准确。文本回退的评级和字段不具备结构化保证，请人工审阅。仅展示有记录的角色输出；未记录的输出无法确认结构化验证状态。"
      : "Format validation checks output fields and types. It does not establish the accuracy of facts, sources, or research conclusions. Text fallback has no structured guarantees for ratings or fields and requires review. Only outputs with recorded metadata are shown; structured validation cannot be confirmed for missing records.",
    emptyMessage: zh
      ? "这份报告未记录输出格式质量，无法确认是否经过结构化验证。"
      : "Output format quality was not recorded for this report; structured validation cannot be confirmed.",
    hasUnvalidatedText: entries.some((entry) => !entry.validated),
    entries,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
