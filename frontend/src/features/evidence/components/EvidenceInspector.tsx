"use client";

import type { SystemLanguage } from "@/lib/types";
import type { EvidenceBundle, EvidenceValidation } from "../types";
import { useEvidenceCheck } from "../hooks/useEvidenceCheck";

export function EvidenceInspector({ bundle, invalid, reports, language, checkReportCitations = true }: {
  bundle?: EvidenceBundle;
  invalid?: EvidenceValidation;
  reports: Record<string, string | null>;
  language: SystemLanguage;
  checkReportCitations?: boolean;
}) {
  const zh = language === "zh";
  const check = useEvidenceCheck(bundle, invalid, checkReportCitations ? reports : undefined);
  const unknown = zh ? "未知 / 未观测" : "Unknown / not observed";
  const status = check.status === "verified" ? (zh ? "内容哈希已核验" : "Content hashes verified")
    : check.status === "checking" ? (zh ? "正在核验保存内容" : "Checking saved content")
      : check.status === "invalid" ? (zh ? "证据包无效，无法核验" : "Invalid evidence bundle; verification failed")
        : (zh ? "此版本未保存证据，来源状态未知" : "No evidence saved for this version; provenance unknown");
  return (
    <section aria-label={zh ? "研究证据" : "Research evidence"} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-200">{zh ? "研究证据" : "Research evidence"}</h3>
        <span aria-live="polite" className={`text-xs ${check.status === "invalid" ? "text-amber-400" : "text-zinc-400"}`}>{status}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-zinc-500">{zh
        ? "引用解析仅确认引用 ID 对应已保存的来源；不证明事实支持、数据准确性或研究结论。来源日期未知时不可推断历史可用性。"
        : "Citation resolution confirms that an ID maps to a saved source. It does not prove factual support, data accuracy, or research conclusions. Unknown source dates do not establish historical availability."}</p>
      {check.status === "invalid" && <p role="alert" className="mt-2 text-xs text-amber-400">{check.reason}</p>}
      {bundle && check.status === "verified" && <div className="mt-4 space-y-3">
        <dl className="grid gap-3 text-xs sm:grid-cols-2">
          <Fact label={zh ? "运行 ID" : "Run ID"} value={bundle.run_id} />
          <Fact label={zh ? "研究截止时间（UTC）" : "Research as of (UTC)"} value={bundle.research_as_of} />
          <Fact label={zh ? "截止策略" : "Cutoff policy"} value={`${bundle.as_of_policy} · ${bundle.market_timezone ?? unknown}`} />
          <Fact label={zh ? "证据包 SHA-256" : "Bundle SHA-256"} value={bundle.bundle_sha256} />
        </dl>
        <div className="rounded-md border border-zinc-800 p-3 text-xs">
          <h4 className="font-medium text-zinc-300">{zh ? "引用解析" : "Citation resolution"}</h4>
          {Object.entries(bundle.citation_audit).map(([key, audit]) => <p className="mt-2 break-words text-zinc-400" key={key}>
            {key}: {audit.status} · {audit.referenced_ids.length} {zh ? "引用" : "references"}
            {audit.unresolved_ids.length > 0 && <span className="text-amber-400"> · {zh ? "缺失" : "missing"}: {audit.unresolved_ids.join(", ")}</span>}
          </p>)}
          {!Object.keys(bundle.citation_audit).length && <p className="mt-2 text-zinc-500">{zh ? "未记录报告引用审计。" : "No report citation audit recorded."}</p>}
        </div>
        {bundle.records.map((record) => <details key={record.id} id={record.id} className="rounded-md border border-zinc-800 p-3">
          <summary className="cursor-pointer text-xs font-medium text-zinc-300">{record.tool} · {record.status} · {record.id}</summary>
          <div className="mt-3 space-y-3 text-xs text-zinc-400">
            <Fact label={zh ? "有效请求参数" : "Effective request parameters"} value={JSON.stringify(record.parameters)} />
            <Fact label={zh ? "获取时间" : "Fetched at"} value={record.fetched_at} />
            {record.sources.map((source, index) => <div key={index} className="rounded bg-zinc-900/50 p-3 leading-6">
              <p>{zh ? "实际来源" : "Observed source"}: {source.provider}{source.url && <> · <a href={source.url} target="_blank" rel="noreferrer noopener" className="break-all underline">{source.url}</a></>}</p>
              <p>{zh ? "观测覆盖窗口" : "Observed coverage window"}: {source.observed_window ? `${source.observed_window.start} → ${source.observed_window.end}` : unknown}</p>
              <p>{zh ? "历史可用性" : "Historical availability"}: {source.historical_availability}</p>
              <p>{zh ? "发表日期" : "Publication dates"}: {source.publication_dates?.length ? source.publication_dates.join(", ") : unknown}</p>
              <p>{zh ? "单位 / 调整" : "Units / adjustments"}: {source.units ?? unknown} / {source.adjustments ?? unknown}</p>
              <p>{zh ? "转换" : "Transformations"}: {source.transformations.length ? source.transformations.join("; ") : unknown}</p>
              {source.data_sha256 && <Artifact hash={source.data_sha256} bundle={bundle} label={zh ? "完整精度的标准化数据" : "Full-precision normalized data"} />}
            </div>)}
            <p>{zh ? "来源尝试" : "Provider attempts"}: {record.attempts.map((attempt) => `${attempt.provider}: ${attempt.status} (${attempt.elapsed_ms} ms)`).join(" · ") || unknown}</p>
            <Artifact hash={record.output_sha256} bundle={bundle} label={zh ? "确切的模型输入" : "Exact model input"} />
          </div>
        </details>)}
        <details className="rounded-md border border-zinc-800 p-3"><summary className="cursor-pointer text-xs text-zinc-300">{zh ? "完整保存证据包与所有内容" : "Complete saved bundle and all payloads"}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-zinc-400">{JSON.stringify(bundle, null, 2)}</pre></details>
      </div>}
    </section>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><dt className="text-zinc-500">{label}</dt><dd className="mt-1 break-all text-zinc-300">{value}</dd></div>;
}
function Artifact({ hash, bundle, label }: { hash: string; bundle: EvidenceBundle; label: string }) {
  const artifact = bundle.artifacts[hash];
  return <details className="mt-2"><summary className="cursor-pointer break-all">{label} · SHA-256 {hash}</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-black p-3 text-xs">{artifact.payload}</pre></details>;
}
