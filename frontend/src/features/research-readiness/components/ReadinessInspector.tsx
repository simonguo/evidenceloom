"use client";
import { useState } from "react";
import type { AnalysisTask, ReportVersion, SystemLanguage } from "@/lib/types";
import { useReadinessCheck } from "../hooks/useReadinessCheck";
import { checkLabel, readinessAbsent, readinessNotice, readinessStatus, readinessSummary } from "../lib/display";

export function ReadinessInspector({ snapshot, language }: { snapshot: AnalysisTask | ReportVersion; language: SystemLanguage }) {
  const check = useReadinessCheck(snapshot); const zh = language === "zh";
  const bundle = check.saved?.researchReadiness;
  const [openHash, setOpenHash] = useState<string>();
  return <section aria-label={zh ? "研究输入检查" : "Research input checks"} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
    <h3 className="text-sm font-semibold text-zinc-200">{zh ? "研究输入检查" : "Research input checks"}</h3>
    <p className="mt-2 text-xs leading-5 text-zinc-500">{readinessNotice(language)}</p>
    <p aria-live="polite" className={`mt-3 text-xs ${check.status === "invalid" || bundle?.status !== "ready" ? "text-amber-400" : "text-zinc-300"}`}>
      {check.status === "checking" ? (zh ? "正在核验保存的输入合同" : "Checking the saved input contract")
        : check.status === "invalid" ? (zh ? "输入合同无效；导出被阻止" : "Invalid input contract; export blocked")
          : bundle ? readinessStatus(bundle, language) : readinessAbsent(language)}
    </p>
    {check.reason && <p role="alert" className="mt-2 text-xs text-amber-400">{check.reason}</p>}
    {bundle && check.status === "verified" && <div className="mt-4 space-y-3">
      <dl className="grid gap-3 text-xs sm:grid-cols-2">{readinessSummary(bundle, language).map(([label, value]) => <div key={label}><dt className="text-zinc-500">{label}</dt><dd className="mt-1 break-words text-zinc-300">{value}</dd></div>)}</dl>
      {bundle.checks.map((input) => <details key={input.key} className="rounded-md border border-zinc-800 p-3 text-xs">
        <summary className="cursor-pointer text-zinc-300">{checkLabel(input.key, language)} · {input.status} · {input.required ? (zh ? "必需" : "Required") : (zh ? "提示" : "Advisory")}</summary>
        <div className="mt-3 space-y-2 break-words text-zinc-400"><p>{zh ? "原因" : "Reasons"}: {input.reason_codes.join(", ") || (zh ? "无记录缺口" : "No recorded gap")}</p><p>{zh ? "来源记录" : "Source records"}: {input.evidence_ids.join(", ") || (zh ? "未引用来源" : "No source referenced")}</p><p>{zh ? "原始内容哈希" : "Input artifact hashes"}: {input.artifact_sha256s.join(", ") || (zh ? "未引用内容" : "No artifact referenced")}</p></div>
      </details>)}
      <details key={bundle.assessment_sha256} onToggle={(event) => setOpenHash(event.currentTarget.open ? bundle.assessment_sha256 : undefined)} className="rounded-md border border-zinc-800 p-3">
        <summary className="cursor-pointer text-xs text-zinc-300">{zh ? "完整冻结的输入检查合同" : "Complete frozen input-check contract"}</summary>
        {openHash === bundle.assessment_sha256 && <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-400">{JSON.stringify(bundle, null, 2)}</pre>}
      </details>
    </div>}
  </section>;
}
