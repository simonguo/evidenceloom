import type { ReportVersion, SystemLanguage } from "@/lib/types";
import { fencedJson } from "@/features/report-export/lib/markdown-fence";
import { copyNumericExport } from "./export";
import { requestedIdentifierScope } from "./presentation";
export function numericAppendix(taskId: string, version: ReportVersion, language: SystemLanguage) {
    const attachment = copyNumericExport(taskId, version), zh = language === "zh";
    const title = zh ? "保存数值字段审阅" : "Saved numeric field reviews";
    const scope = (zh ? "只比较所选数值与保存字段；不认证周围文字、来源可靠性、历史版本、指标方法、预测或因果。" : "Only the selected number is compared with a saved field; surrounding prose, source reliability, historical vintage, indicator method, predictions and causality remain unreviewed.") + " " + requestedIdentifierScope(zh);
    const lines = attachment.report_text_snapshot
        ? [`${zh ? "原文捕获时间" : "Original text captured"}: ${attachment.report_text_snapshot.captured_at}`, ...attachment.numeric_reviews.map((review) => `${review.reviewed_at} · ${review.result.status} / ${review.result.reason} · ${zh ? "所选原文" : "Selected text"}: ${review.numeric_span.text} · ${zh ? "未审阅" : "Unreviewed"}: ${review.result.unreviewed_dimensions.join(", ")}`)]
        : [zh ? "此历史版本没有冻结原文快照，不能创建数值审阅。" : "This historical version has no frozen text snapshot and cannot receive numeric reviews."];
    return { title, scope, lines, attachment };
}
export function numericMarkdown(taskId: string, version: ReportVersion, language: SystemLanguage) {
    const appendix = numericAppendix(taskId, version, language);
    return `## ${appendix.title}\n\n${appendix.scope}\n\n${appendix.lines.join("\n\n")}\n\n${fencedJson(appendix.attachment)}`;
}
export function numericHtml(taskId: string, version: ReportVersion, language: SystemLanguage, escape: (value: string) => string) {
    const appendix = numericAppendix(taskId, version, language);
    return `<section class="report-section"><h2>${escape(appendix.title)}</h2><p>${escape(appendix.scope)}</p>${appendix.lines.map((line) => `<p>${escape(line)}</p>`).join("")}<details><summary>${escape(language === "zh" ? "完整原文快照与审阅附件" : "Complete original text snapshot and review attachments")}</summary><pre id="numeric-review-attachments">${escape(JSON.stringify(appendix.attachment, null, 2))}</pre></details></section>`;
}
