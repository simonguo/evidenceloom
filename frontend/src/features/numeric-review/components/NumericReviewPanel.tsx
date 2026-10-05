"use client";
import { useState } from "react";
import type { ReportVersion, SystemLanguage } from "@/lib/types";
import type { NumericReview } from "../types";
import { useNumericReview } from "../hooks/useNumericReview";
import { NumericReviewForm } from "./NumericReviewForm";
import { NumericResultView } from "./NumericResultView";
import { SavedNumericContext } from "./SavedNumericContext";
import { requestedIdentifierScope } from "../lib/presentation";
const buttonClass = "rounded border border-zinc-700 px-3 py-2 text-xs text-zinc-300 disabled:opacity-40";
export function NumericReviewPanel({ taskId, version, language, onSave, beginReview }: {
    taskId: string;
    version: ReportVersion;
    language: SystemLanguage;
    onSave?: (taskId: string, versionId: string, reviews: NumericReview[], action?: unknown) => Promise<void>;
  beginReview?: () => unknown;
}) {
    const zh = language === "zh", review = useNumericReview(taskId, version, language, onSave, beginReview);
    const snapshot = review.verified?.reportTextSnapshot, evidence = review.verified?.evidenceBundle;
    const [open, setOpen] = useState(false);
    return <section className="rounded-lg border border-zinc-800 p-4">
    <h4 className="font-medium text-zinc-200">{zh ? "保存数值字段审阅" : "Saved numeric field review"}</h4>
    <p className="mt-2 text-xs leading-5 text-zinc-500">{zh ? "只比较所选原文数值与保存字段。不认证周围文字、来源可靠性、历史版本、指标方法、预测或因果。选择来源和日期本身不会验证报告上下文。" : "Compare one original-text number with one saved field. Surrounding prose, source reliability, historical vintage, indicator method, predictions and causality remain unreviewed. Picking a source/date does not verify report context."}</p>
    <p className="mt-1 text-xs leading-5 text-zinc-500">{requestedIdentifierScope(zh)}</p>
    {review.reason ? <p role="alert" className="mt-3 text-sm text-amber-300">{zh ? "数值审阅附件无效；导出已阻止" : "Numeric review attachment invalid; export blocked"}: {review.reason}</p> : !version.reportTextSnapshot ? <p className="mt-3 text-sm text-zinc-500">{zh ? "此历史版本没有冻结原文快照，不能创建数值审阅。" : "This historical version has no frozen original-text snapshot and cannot receive numeric reviews."}</p> : !snapshot ? <p role="status" className="mt-3 text-xs text-zinc-500">{zh ? "正在验证冻结原文与保存证据…" : "Verifying original text and saved evidence…"}</p> : <>
      <p className="mt-3 break-all text-xs text-zinc-500">{zh ? "原文捕获时间" : "Original text captured"}: {snapshot.captured_at} · {snapshot.snapshot_sha256}</p>
      <details className="mt-3" onToggle={(event) => { setOpen(event.currentTarget.open); if (!event.currentTarget.open)
            review.clearPreview(); }}>
        <summary className="cursor-pointer text-sm text-zinc-300">{zh ? "选择原文数值并对照保存字段" : "Select an original number and compare a saved field"}</summary>
        {open && evidence && <>
          <NumericReviewForm snapshot={snapshot} evidence={evidence} versionId={version.id} zh={zh} pending={review.pending} onCompare={review.compare} onInvalidate={review.clearPreview}/>
          {review.preview && <>
    <NumericResultView review={review.preview} zh={zh}/>
    <button className={buttonClass} disabled={!onSave || review.pending} onClick={() => void review.save()}>{zh ? "追加并保存审阅" : "Append and save review"}</button>
    </>}
        </>}
      </details>
      <div className="mt-3 space-y-3">{(review.verified?.numericReviews ?? []).map((item) => <article key={item.review_id}>
    <p className="mb-1 text-xs text-zinc-500">{item.reviewed_at} · {item.target.section_key} · {item.review_id}</p>
    <NumericResultView review={item} zh={zh}/>
    <SavedNumericContext current={review.displayOwner} parent={review.verifiedParent} reviewId={item.review_id} zh={zh}/>
    </article>)}</div>
    </>}
    {review.message && <p role="status" className="mt-3 text-xs text-zinc-400">{review.message}</p>}
  </section>;
}
