import type { NumericReview } from "../types";
import { numericContextLabels, requestedIdentifierScope } from "../lib/presentation";
export function NumericResultView({ review, zh }: {
    review: NumericReview;
    zh: boolean;
}) {
    const labels = { match: zh ? "所选数值相符" : "Selected value matches", mismatch: zh ? "所选数值或绑定文本不符" : "Selected value or bound text differs", missing: zh ? "所选字段或绑定上下文缺失" : "Selected field or bound context missing", manual_inference: zh ? "所选形式需人工判断" : "Selected form requires manual judgment" };
    const contextLabels = numericContextLabels(zh);
    const dimensions: Record<string, string> = { surrounding_prose: "周围文字", source_reliability: "来源可靠性", historical_vintage: "历史版本", indicator_method: "指标方法", prediction: "预测", causality: "因果", ...contextLabels };
    const contextStatuses = { unreviewed: "未审阅", match: "字面量相符", mismatch: "字面量不符", missing: "缺失" };
    return <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-400">
    <p className="font-medium text-zinc-200">{labels[review.result.status]} · {review.result.reason}</p>
    <p>{zh ? "所选原文" : "Selected original text"}: <code>{review.numeric_span.text}</code> · {zh ? "保存字段的原始数值" : "Saved field original number"}: <code>{review.operand.raw_number_lexeme ?? "unknown"}</code> · HALF-UP({review.rounding.places}): <code>{review.result.rounded_decimal ?? "unknown"}</code>
    </p>
    <p>{zh ? "绑定文本对照" : "Bound literal comparisons"}: {Object.entries(review.result.context_results).map(([key, value]) => `${contextLabels[key as keyof typeof contextLabels]}: ${zh ? contextStatuses[value] : value}`).join(" · ")}</p>
    <p>{requestedIdentifierScope(zh)}</p>
    <p>{zh ? "仍未审阅" : "Still unreviewed"}: {review.result.unreviewed_dimensions.map((key) => zh ? dimensions[key] ?? key : contextLabels[key as keyof typeof contextLabels] ?? key).join(" · ")}</p>
    <p className="break-all">{zh ? "证据 ID" : "Evidence ID"}: <code>{review.operand.evidence_id}</code> · {zh ? "来源序号" : "Source index"}: {review.operand.source_index} · {zh ? "保存表位置" : "Saved table path"}: <code>{review.operand.selector.table_path.length ? review.operand.selector.table_path.join(".") : "root"}</code> · {zh ? "所选保存日期标记" : "Selected saved date label"}: <code>{review.operand.selector.row_date}</code> · {zh ? "保存字段" : "Saved field"}: <code>{review.operand.selector.field}</code></p>
    <p>{zh ? "保存的日期标记" : "Saved date label"}: {review.result.source_context.row_date ?? "unknown"} · {zh ? "保存单位" : "Saved units"}: {review.result.source_context.units ?? "unknown"} · {review.result.source_context.provider} · {review.result.source_context.historical_availability}</p>
    <p>{zh ? "调整/转换" : "Adjustments / transformations"}: {review.result.source_context.adjustments ?? "unknown"} · {review.result.source_context.transformations.join("; ") || "—"}</p>
    <details className="break-all"><summary className="cursor-pointer">{zh ? "完整哈希绑定" : "Full hash bindings"}</summary>
    <p>{zh ? "保存数据 SHA-256" : "Saved data SHA-256"}: <code>{review.operand.data_sha256 ?? "unknown"}</code></p>
    <p>{zh ? "原文快照 SHA-256" : "Text snapshot SHA-256"}: <code>{review.target.report_snapshot_sha256}</code></p>
    <p>{zh ? "审阅凭据 SHA-256" : "Review receipt SHA-256"}: <code>{review.review_sha256}</code></p>
    </details>
  </div>;
}
