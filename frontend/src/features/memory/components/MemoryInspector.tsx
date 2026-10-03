"use client";
import { useState, type ReactNode } from "react";
import type { AnalysisTask, ReportVersion, SystemLanguage } from "@/lib/types";
import type { DecisionSnapshot, MemoryBundle } from "../types";
import { memoryAbsent, memoryNotice, memorySummary, snapshotCalculation } from "../lib/export";
import { useMemoryCheck } from "../hooks/useMemoryCheck";

export function MemoryInspector({ snapshot, language }: { snapshot: AnalysisTask | ReportVersion; language: SystemLanguage }) {
  const check = useMemoryCheck(snapshot); const bundle = check.saved?.memoryBundle; const zh = language === "zh";
  return <section aria-label={zh ? "不可变研究记忆" : "Immutable research memory"} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
    <h3 className="text-sm font-semibold text-zinc-200">{zh ? "不可变研究记忆与评估" : "Immutable research memory and evaluation"}</h3>
    <p className="mt-2 text-xs leading-5 text-zinc-500">{memoryNotice(language)}</p>
    {check.status === "checking" && <p role="status" className="mt-2 text-xs text-zinc-400">{zh ? "正在核验保存的记忆" : "Checking saved memory"}</p>}
    {check.status === "invalid" && <p role="alert" className="mt-2 text-xs text-amber-400">{zh ? "记忆附件无效" : "Invalid memory attachment"}: {check.reason}</p>}
    {check.status === "unknown" && <p className="mt-2 text-xs text-zinc-500">{memoryAbsent(language)}</p>}
    {bundle && check.status === "verified" && <div className="mt-4 space-y-3">
      <p className="text-xs text-zinc-400">{zh ? "内容哈希已核验；原始输入保持冻结" : "Content hashes verified; original input remains frozen"}</p>
      <Snapshot bundle={bundle} item={bundle.decision_snapshot} language={language} title={zh ? "生成时保存的决策" : "Decision saved at generation"} />
      <LazyDetails title={zh ? "确切的历史记忆输入与可用性" : "Exact prior memory input and availability"}>{() => <><Payload text={bundle.input_snapshot.context_artifact.payload || (zh ? "未选择历史记录" : "No prior records selected")} /><Payload text={JSON.stringify(bundle.input_snapshot, null, 2)} /></>}</LazyDetails>
      {(check.saved?.evaluationReviews ?? []).map((review) => <Snapshot key={review.attachment_sha256} bundle={bundle} item={review.snapshot} language={language} title={`${zh ? "后续评估审阅" : "Later evaluation review"} · ${review.reviewed_at}`} />)}
      <LazyDetails title={zh ? "完整记忆包与后续附件" : "Complete memory bundle and later attachments"}>{() => <Payload text={JSON.stringify({ memory_bundle: bundle, evaluation_reviews: check.saved?.evaluationReviews ?? [] }, null, 2)} />}</LazyDetails>
    </div>}
  </section>;
}
function LazyDetails({ title, children }: { title: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="rounded border border-zinc-800 p-3" onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-xs text-zinc-300">{title}</summary>{open && children()}</details>;
}
function Payload({ text }: { text: string }) {
  const limit = 100_000;
  return <><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-400">{text.slice(0, limit)}</pre>{text.length > limit && <p className="mt-2 text-xs text-zinc-500">Preview limited to {limit.toLocaleString()} characters; full exact content is included in report exports.</p>}</>;
}
function Snapshot({ bundle, item, language, title }: { bundle: MemoryBundle; item: DecisionSnapshot; language: SystemLanguage; title: string }) {
  const calculation = snapshotCalculation(item);
  return <details open className="rounded border border-zinc-800 p-3"><summary className="cursor-pointer text-xs font-medium text-zinc-300">{title}</summary><dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">{memorySummary(bundle, item, language).map(([label, value]) => <div key={label}><dt className="text-zinc-500">{label}</dt><dd className="mt-1 break-all text-zinc-300">{value}</dd></div>)}</dl>{calculation && <Payload text={calculation} />}</details>;
}
