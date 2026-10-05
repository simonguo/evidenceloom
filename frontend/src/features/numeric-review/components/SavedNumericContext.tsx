"use client";
import { useState } from "react";
import { hasNumericDisplayOwner, inspectSavedNumeric, rawCellPresentation, type NumericDisplayOwner, type VerifiedNumericParent } from "../lib/inspection";
import { numericContextLabels } from "../lib/presentation";
import type { NumericReason } from "../types";

function sourceReason(reason: NumericReason | undefined, zh: boolean) {
    const messages: Partial<Record<NumericReason, [string, string]>> = {
        source_withheld: ["来源内容未提供，无法显示保存行。", "Source content is withheld; the saved row cannot be shown."],
        source_unavailable: ["保存来源不可用。", "The saved source is unavailable."],
        table_missing: ["完整保存表缺失或格式不符合要求。", "The complete saved table is missing or malformed."],
        table_ambiguous: ["保存表存在重复列，无法唯一定位。", "Duplicate columns prevent an unambiguous table selection."],
        row_ambiguous: ["保存表存在重复日期，无法唯一定位。", "Duplicate date labels prevent an unambiguous row selection."],
        row_missing: ["所选保存日期行不存在或日期标记无效。", "The selected saved row is absent or its date label is invalid."],
        field_missing: ["所选字段不存在；保存行不代表替代字段已审阅。", "The selected field is absent; other row cells are not substitute reviewed fields."],
        field_not_numeric: ["所选保存单元格不是数值 token。", "The selected saved cell is not a numeric token."],
    };
    return reason ? `${messages[reason]?.[zh ? 0 : 1] ?? (zh ? "此字段不能用于数值对照。" : "This field cannot be used for numeric comparison.")} (${reason})` : "";
}
const cellTypes = { number: ["数值 token", "number token"], string: ["字符串", "string"], null: ["空值", "null"], boolean: ["布尔值", "boolean"], array: ["数组（非数值）", "array (not numeric)"], object: ["对象（非数值）", "object (not numeric)"] };
export function SavedNumericContext({ current, parent, reviewId, zh }: { current: NumericDisplayOwner; parent?: VerifiedNumericParent; reviewId: string; zh: boolean }) {
    const [opened, setOpened] = useState<{ parent: VerifiedNumericParent; reviewId: string } | null>(null);
    if (!hasNumericDisplayOwner(current, parent)) return null;
    const expanded = opened?.parent === parent && opened.reviewId === reviewId;
    const inspected = expanded ? inspectSavedNumeric(current, parent, reviewId) : null;
    const labels = numericContextLabels(zh);
    return <details className="mt-2 rounded border border-zinc-800 p-3" open={expanded} onToggle={(event) => setOpened(event.currentTarget.open ? { parent, reviewId } : null)}>
        <summary className="cursor-pointer text-sm text-zinc-300">{zh ? "定位保存原文与数据行" : "Locate saved original text and data row"}</summary>
        {expanded && (!inspected ? <p role="status" className="mt-2 text-xs text-amber-300">{zh ? "当前版本的保存定位尚未确认。" : "Saved context for the current version is not confirmed."}</p> : <div className="mt-3 space-y-3 text-xs text-zinc-400">
            <p>{zh ? "只读保存内容；不重新取数，也不扩大原审阅结论。" : "Read-only saved content; no new source fetch and no extension of the recorded review conclusion."}</p>
            <p className="break-all">{zh ? "原文章节" : "Original section"}: {inspected.review.target.section_key} · {zh ? "数值 UTF8 字节范围" : "Numeric UTF8 byte range"}: [{inspected.review.numeric_span.start_byte}, {inspected.review.numeric_span.end_byte})</p>
            <pre aria-label={zh ? "保存原文；标记所选数值与绑定上下文" : "Saved original text with selected number and bound context"} className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 text-zinc-300" data-original-section={inspected.review.target.section_key}>{inspected.segments.map((segment) => segment.numeric || segment.contexts.length ? <mark key={segment.startByte} data-numeric={segment.numeric || undefined} data-contexts={segment.contexts.join(" ") || undefined} title={[...(segment.numeric ? [zh ? "所选数值" : "Selected number"] : []), ...segment.contexts.map((key) => labels[key])].join(" · ")} className={segment.numeric ? "bg-amber-300/20 text-amber-200" : "bg-sky-300/10 text-sky-200"}>{segment.text}</mark> : segment.text)}</pre>
            <ul className="space-y-1">{Object.entries(inspected.review.context_bindings).map(([key, span]) => <li key={key}>{labels[key as keyof typeof labels]}: {span ? `${zh ? "绑定原文" : "Bound original text"} [${span.start_byte}, ${span.end_byte}) — ${span.text}` : (zh ? "未绑定，仍未审阅" : "Not bound; remains unreviewed")}</li>)}</ul>
            <p>{sourceReason(inspected.source.reason, zh)}</p>
            {inspected.source.columns && inspected.source.row ? <div className="overflow-x-auto"><table className="w-full text-left" aria-label={zh ? "保存数据行与原始单元格类型" : "Saved data row and original cell types"}>
                <caption className="mb-2 text-left">{zh ? "保存日期行" : "Saved date row"}: {inspected.review.operand.selector.row_date} · {zh ? "所选字段" : "Selected field"}: {inspected.review.operand.selector.field}</caption>
                <thead><tr>{inspected.source.columns.map((column, index) => <th scope="col" key={column} className="border border-zinc-800 p-2">{column}{index === inspected.source.fieldIndex ? ` (${zh ? "所选" : "selected"})` : ""}</th>)}</tr></thead>
                <tbody><tr>{inspected.source.row.map((cell, index) => { const displayed = rawCellPresentation(cell); return <td key={index} className="border border-zinc-800 p-2 align-top" data-selected-cell={index === inspected.source.fieldIndex || undefined}><code className="whitespace-pre-wrap break-all">{displayed.literal}</code><span className="mt-1 block text-zinc-500">{cellTypes[displayed.type][zh ? 0 : 1]}</span></td>; })}</tr></tbody>
            </table></div> : <p>{zh ? "没有可唯一验证的保存行；不展示推测位置。" : "No unambiguously validated saved row; no inferred location is displayed."}</p>}
            {inspected.source.lexeme !== null && <p className="break-all">{zh ? "保存的原始数值 token" : "Saved original numeric token"}: <code>{inspected.source.lexeme}</code>{inspected.review.operand.raw_number_lexeme === null ? ` · ${zh ? "原审阅未接受为可比较数值；不推导新的数值相符结论" : "Not accepted as a comparable number in the recorded review; no numeric match is inferred"}` : ""}</p>}
            <p className="break-all">{zh ? "提供方" : "Provider"}: {inspected.source.context.provider} · {zh ? "历史可用性" : "Historical availability"}: {inspected.source.context.historical_availability} · {zh ? "单位" : "Units"}: {inspected.source.context.units ?? (zh ? "未知" : "unknown")}</p>
            <p>{zh ? "调整" : "Adjustments"}: {inspected.source.context.adjustments ?? (zh ? "未知" : "unknown")} · {zh ? "变换" : "Transformations"}: {inspected.source.context.transformations.length ? inspected.source.context.transformations.join("; ") : (zh ? "无保存记录" : "none recorded")}</p>
        </div>)}
    </details>;
}
