"use client";

import { useEffect, useMemo, useState } from "react";
import { getRuntimeAdapter } from "@/lib/runtime";
import type { AnalysisTask, ReportVersion, SystemLanguage } from "@/lib/types";
import type { ExportFormat } from "../types";
import { buildReportDocument } from "../lib/report-document";
import { reportExportFilename } from "../lib/filename";
import { renderReportHtml } from "../lib/render-html";
import { renderReportMarkdown } from "../lib/render-markdown";
import { verifyEvidenceBundle } from "@/features/evidence/lib/validation";
import { verifiedExportVersion } from "@/features/memory/lib/export";
import { verifiedReadinessExport } from "@/features/research-readiness/lib/export";
import { verifiedNumericExport } from "@/features/numeric-review/lib/export";
import { reportJson } from "../lib/report-json";

export function useReportExport(task: AnalysisTask, language: SystemLanguage) {
  const versions = useMemo(
    () => [...task.reportVersions].sort((a, b) => b.versionNumber - a.versionNumber),
    [task.reportVersions],
  );
  const [selectedVersionId, setSelectedVersionId] = useState(versions[0]?.id ?? "");
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!versions.some((version) => version.id === selectedVersionId)) {
      setSelectedVersionId(versions[0]?.id ?? "");
    }
  }, [selectedVersionId, versions]);

  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions[0];

  async function exportVersion(format: ExportFormat) {
    if (!selectedVersion || exporting) return;
    setExporting(format);
    setMessage("");
    try {
      let frozenVersion = JSON.parse(JSON.stringify(selectedVersion)) as ReportVersion;
      const taskId = task.id;
      const origin = task.origin;
      if (frozenVersion.evidenceValidation) throw new Error(`Evidence bundle is invalid: ${frozenVersion.evidenceValidation.reason}`);
      if (frozenVersion.evidenceBundle) frozenVersion.evidenceBundle = await verifyEvidenceBundle(frozenVersion.evidenceBundle, frozenVersion.reportSections);
      frozenVersion = await verifiedExportVersion(frozenVersion);
      frozenVersion = await verifiedReadinessExport(frozenVersion);
      frozenVersion = await verifiedNumericExport(taskId, frozenVersion);
      const document = buildReportDocument(taskId, origin, frozenVersion, language);
      const content = format === "json" ? JSON.stringify(reportJson(taskId, origin, frozenVersion), null, 2) : format === "html"
        ? renderReportHtml(document)
        : renderReportMarkdown(document);
      const result = await getRuntimeAdapter().saveTextExport({
        suggestedName: reportExportFilename(frozenVersion, format),
        format,
        content,
      });
      setMessage(result.status === "cancelled"
        ? (language === "zh" ? "已取消保存。" : "Save cancelled.")
        : result.path
          ? (language === "zh" ? `已保存到 ${result.path}` : `Saved to ${result.path}`)
          : (language === "zh" ? "报告已下载。" : "Report downloaded."));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setMessage(language === "zh" ? `导出失败：${detail}` : `Export failed: ${detail}`);
    } finally {
      setExporting(null);
    }
  }

  return {
    versions,
    selectedVersion,
    selectedVersionId,
    setSelectedVersionId,
    exporting,
    message,
    exportVersion,
  };
}
