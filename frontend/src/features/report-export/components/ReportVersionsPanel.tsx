"use client";

import { Download, FileCode2, FileText, Loader2 } from "lucide-react";
import type { AnalysisTask, SystemLanguage } from "@/lib/types";
import { useReportExport } from "../hooks/useReportExport";

export function ReportVersionsPanel({
  task,
  language,
}: {
  task: AnalysisTask;
  language: SystemLanguage;
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

  return (
    <section className="rounded-xl border border-zinc-900 bg-black p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="size-5 text-zinc-400" />
            <h3 className="text-base font-semibold text-white">{zh ? "报告版本" : "Report Versions"}</h3>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-500">
            {zh
              ? "每次成功完成的分析都会冻结为只读版本。导出文件会离开本机，分享前请检查内容。"
              : "Every successful run is frozen as a read-only version. Exported files leave this device; review them before sharing."}
          </p>
        </div>

        {selectedVersion && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="report-version-select">{zh ? "报告版本" : "Report version"}</label>
            <select
              id="report-version-select"
              value={selectedVersionId}
              onChange={(event) => setSelectedVersionId(event.target.value)}
              className="h-10 rounded-md border border-zinc-800 bg-zinc-950 px-3 text-sm text-zinc-200 outline-none focus:border-zinc-600"
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
          </div>
        )}
      </div>

      {selectedVersion ? (
        <div className="mt-4 grid gap-3 border-t border-zinc-900 pt-4 sm:grid-cols-3">
          <VersionFact label={zh ? "版本 ID" : "Version ID"} value={selectedVersion.id} />
          <VersionFact label={zh ? "分析日期" : "Analysis Date"} value={selectedVersion.task.analysisDate} />
          <VersionFact
            label={zh ? "运行配置" : "Run Manifest"}
            value={selectedVersion.run
              ? `${selectedVersion.run.llmProvider} · ${selectedVersion.run.quickThinkLlm} / ${selectedVersion.run.deepThinkLlm}`
              : (zh ? "历史版本未记录" : "Not recorded for this historical version")}
          />
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
          {zh ? "任务成功完成后即可导出只读报告。" : "A read-only report becomes available after a successful run."}
        </div>
      )}

      {message && <p className="mt-3 break-words text-xs text-zinc-400">{message}</p>}
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
