"use client";

import { useRef } from "react";
import { IdentityInspector } from "@/features/source-identity/components/IdentityInspector";
import { Download, FileCode2, FileText, Loader2 } from "lucide-react";
import type { AnalysisTask, GlobalSettings, SystemLanguage } from "@/lib/types";
import { NumericReviewPanel } from "@/features/numeric-review/components/NumericReviewPanel";
import type { NumericReview } from "@/features/numeric-review/types";
import type { ReviewAttachment } from "@/features/memory/types";
import { ReadinessInspector } from "@/features/research-readiness/components/ReadinessInspector";
import { MemoryInspector } from "@/features/memory/components/MemoryInspector";
import { useEvaluationReview } from "@/features/memory/hooks/useEvaluationReview";
import { useReportExport } from "../hooks/useReportExport";
import { OutputQualityPanel } from "@/features/output-quality/components/OutputQualityPanel";
import { ReportVersionPreview } from "./ReportVersionPreview";
import { EvidenceInspector } from "@/features/evidence/components/EvidenceInspector";
import { ReportVersionComparison } from "./ReportVersionComparison";
import { savedEvidenceScope } from "../lib/saved-report-citations";

export function ReportVersionsPanel({
  task,
  language,
  settings,
  onReviews,
  onNumericReviews,
  beginReview,
}: {
  task: AnalysisTask;
  language: SystemLanguage;
  settings?: GlobalSettings;
  onNumericReviews?: (taskId: string, versionId: string, reviews: NumericReview[], action?: unknown) => Promise<void>;
  onReviews?: (taskId: string, versionId: string, reviews: ReviewAttachment[], action?: unknown) => Promise<void>;
  beginReview?: (task: AnalysisTask, versionId: string) => unknown;
}) {
  const {
    versions,
    selectedVersion,
    selectedVersionId,
    setSelectedVersionId,
    exporting,
    message,
    exportVersion,
  } = useReportExport(task, language);
  const zh = language === "zh";
  const previewRef = useRef<HTMLDetailsElement>(null);
  const captureReview = beginReview && selectedVersion ? () => beginReview(task, selectedVersion.id) : undefined;
  const saveReviews = onReviews ? captureReview ? (versionId: string, attachments: ReviewAttachment[], action?: unknown) => onReviews(task.id, versionId, attachments, action)
    : (versionId: string, attachments: ReviewAttachment[]) => onReviews(task.id, versionId, attachments) : undefined;
  const review = useEvaluationReview(selectedVersion, language, settings, saveReviews, captureReview);

  return (
    <section id="saved-report-versions" aria-label={zh ? "已存报告版本" : "Saved report versions"} tabIndex={-1} className="scroll-mt-24 rounded-xl border border-zinc-800 bg-zinc-950/50 p-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="size-5 text-zinc-400" />
            <h3 className="text-base font-semibold text-white">{zh ? "已存报告版本" : "Saved Report Versions"}</h3>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">
            {zh
              ? "已保存的报告正文按版本保留，输入检查独立于任务完成状态。导出文件包含研究内容，请在分享前检查。"
              : "Saved report text is retained by version; input checks are separate from task completion. Exported files contain research content; review them before sharing."}
          </p>
        </div>

        {selectedVersion && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="report-version-select">{zh ? "报告版本" : "Report version"}</label>
            <select
              id="report-version-select"
              value={selectedVersionId}
              onChange={(event) => setSelectedVersionId(event.target.value)}
              className="h-10 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.versionNumber} · {formatTimestamp(version.createdAt, language)}
                  {version.legacy ? (zh ? " · 历史" : " · Legacy") : ""}
                </option>
              ))}
            </select>
            <ExportButton
              label="HTML"
              icon={<FileCode2 className="size-4" />}
              loading={exporting === "html"}
              disabled={Boolean(exporting)}
              onClick={() => void exportVersion("html")}
            />
            <ExportButton
              label="Markdown"
              icon={<Download className="size-4" />}
              loading={exporting === "md"}
              disabled={Boolean(exporting)}
              onClick={() => void exportVersion("md")}
            />
            <ExportButton label={zh ? "报告 JSON" : "Report JSON"} icon={<Download className="size-4" />} loading={exporting === "json"} disabled={Boolean(exporting)} onClick={() => void exportVersion("json")} />
            {selectedVersion.memoryBundle && onReviews && <ExportButton label={zh ? "读取保存的评估" : "Load saved evaluation"} icon={<FileText className="size-4" />} loading={review.loading} disabled={review.loading || Boolean(exporting) || Boolean(selectedVersion.memoryValidation)} onClick={() => void review.refresh()} />}
          </div>
        )}
      </div>

      {selectedVersion ? (
        <div className="mt-4 space-y-5">
          <div aria-label={zh ? `所选已存报告 v${selectedVersion.versionNumber}` : `Selected saved report v${selectedVersion.versionNumber}`} className="rounded-lg border border-sky-900/60 bg-sky-950/10 p-4">
            <h4 className="text-lg font-semibold text-white">
              {zh ? `所选已存报告 v${selectedVersion.versionNumber}` : `Selected saved report v${selectedVersion.versionNumber}`}
              {selectedVersion.legacy && <span className="ml-2 text-xs font-normal text-zinc-400">{zh ? "历史版本" : "Legacy version"}</span>}
            </h4>
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <div><dt className="text-zinc-400">{zh ? "生成时间" : "Generated at"}</dt><dd className="mt-1 text-zinc-200"><time dateTime={selectedVersion.createdAt}>{formatTimestamp(selectedVersion.createdAt, language)}</time></dd></div>
              <div><dt className="text-zinc-400">{zh ? "研究日期" : "Research date"}</dt><dd className="mt-1 text-zinc-200"><time dateTime={selectedVersion.task.analysisDate}>{selectedVersion.task.analysisDate}</time></dd></div>
            </dl>
            <p className="mt-3 text-xs leading-5 text-zinc-400">{zh ? "以下正文与检查对应所选冻结版本；当前任务状态显示在上方。" : "The report and checks below belong to this selected frozen version. Current task status appears above."}</p>
          </div>

          <nav aria-label={zh ? "所选报告导览" : "Selected report navigation"} className="flex flex-wrap gap-2">
            <a href="#selected-report-body" onClick={() => {
              if (previewRef.current) { previewRef.current.open = true; previewRef.current.focus(); }
            }} className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">{zh ? "报告正文" : "Report text"}</a>
            <a href="#selected-report-evidence" className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">{zh ? "证据与限制" : "Evidence and limitations"}</a>
            <a href="#selected-report-review" className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 hover:border-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">{zh ? "数值审阅" : "Numeric review"}</a>
          </nav>

          <details id="selected-report-body" key={`preview:${selectedVersion.id}`} ref={previewRef} tabIndex={-1} className="scroll-mt-24 rounded-lg border border-zinc-800 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
            <summary className="cursor-pointer text-sm font-medium text-zinc-200 focus-visible:outline focus-visible:outline-offset-4">
              {zh ? `审阅选中的报告 v${selectedVersion.versionNumber}` : `Review selected report v${selectedVersion.versionNumber}`}
            </summary>
            <ReportVersionPreview version={selectedVersion} taskId={task.id} origin={task.origin} language={language} />
          </details>

          <section id="selected-report-evidence" aria-label={zh ? "所选版本的证据与限制" : "Evidence and limitations for the selected version"} tabIndex={-1} className="scroll-mt-24 space-y-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
            <h4 className="text-base font-semibold text-zinc-100">{zh ? "证据与限制" : "Evidence and limitations"}</h4>
            <div className="grid gap-3 sm:grid-cols-3">
              <VersionFact label={zh ? "版本 ID" : "Version ID"} value={selectedVersion.id} />
              <VersionFact label={zh ? "分析日期" : "Analysis Date"} value={selectedVersion.task.analysisDate} />
              <VersionFact label={zh ? "运行配置" : "Run Manifest"} value={selectedVersion.run
                ? `${selectedVersion.run.llmProvider} · ${selectedVersion.run.quickThinkLlm} / ${selectedVersion.run.deepThinkLlm}`
                : (zh ? "历史版本未记录" : "Not recorded for this historical version")} />
            </div>
            <OutputQualityPanel quality={selectedVersion.outputQuality} language={language} />
            <EvidenceInspector key={`evidence:${selectedVersion.id}`} recordScope={savedEvidenceScope(task.id, selectedVersion.id)} bundle={selectedVersion.evidenceBundle} invalid={selectedVersion.evidenceValidation} reports={selectedVersion.reportSections} language={language} />
            <IdentityInspector key={`identity:${selectedVersion.id}`} snapshot={selectedVersion} language={language} />
            <ReadinessInspector snapshot={selectedVersion} language={language} />
            <MemoryInspector snapshot={selectedVersion} language={language} />
          </section>

          <section id="selected-report-review" aria-label={zh ? "所选版本的数值审阅" : "Numeric review for the selected version"} tabIndex={-1} className="scroll-mt-24 space-y-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
            <h4 className="text-base font-semibold text-zinc-100">{zh ? "数值审阅" : "Numeric review"}</h4>
            <NumericReviewPanel key={`numeric:${selectedVersion.id}`} taskId={task.id} version={selectedVersion} language={language} onSave={onNumericReviews} beginReview={captureReview} />
          </section>
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
          {zh ? "暂无已保存报告版本" : "No saved report versions yet."}
        </div>
      )}
      <ReportVersionComparison taskId={task.id} reportVersions={task.reportVersions} language={language} />
      {message && <p role="status" className="mt-3 break-words text-xs text-zinc-400">{message}</p>}
      {review.message && <p role="status" className="mt-3 break-words text-xs text-zinc-400">{review.message}</p>}
    </section>
  );
}

function ExportButton({
  label,
  icon,
  loading,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-10 items-center gap-2 rounded-md border border-zinc-800 px-3 text-sm text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {label}
    </button>
  );
}

function VersionFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-zinc-900 bg-zinc-950/50 p-3">
      <div className="text-xs text-zinc-600">{label}</div>
      <div className="mt-1 truncate text-sm text-zinc-300" title={value}>{value}</div>
    </div>
  );
}

function formatTimestamp(value: string, language: SystemLanguage) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
