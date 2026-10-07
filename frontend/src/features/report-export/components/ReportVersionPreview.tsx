"use client";

import type { ReportVersion, SystemLanguage, TaskOrigin } from "@/lib/types";
import { ReportMarkdown } from "@/components/task-center/components/ReportMarkdown";
import { buildReportDocument } from "../lib/report-document";
import { useSavedReportCitations } from "../hooks/useSavedReportCitations";
import { navigateSavedEvidence, remarkSavedReportCitations, savedEvidenceHref } from "../lib/saved-report-citations";

export function ReportVersionPreview({
  version, taskId, origin, language,
}: {
  version: ReportVersion;
  taskId: string;
  origin: TaskOrigin;
  language: SystemLanguage;
}) {
  const document = buildReportDocument(taskId, origin, version, language);
  const citations = useSavedReportCitations(taskId, version);
  return (
    <div className="mt-4 space-y-5" aria-label={language === "zh" ? `报告版本 v${version.versionNumber} 预览` : `Report version v${version.versionNumber} preview`}>
      <p className="text-sm leading-6 text-zinc-300">{document.disclaimer}</p>
      {document.fictionalNotice && <p className="rounded-md border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-sm leading-6 text-amber-200">{document.fictionalNotice}</p>}
      <details className="rounded-lg border border-zinc-800 p-4">
        <summary className="cursor-pointer text-sm font-medium text-zinc-200 focus-visible:outline focus-visible:outline-offset-4">
          {language === "zh" ? "版本与运行配置" : "Version and run metadata"}
        </summary>
        <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
          {document.metadata.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-zinc-500">{label}</dt>
              <dd className="mt-1 break-words text-zinc-200">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
      {document.sections.map((section) => (
        <section key={section.id} className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4" aria-label={section.title}>
          <h3 className="mb-4 text-base font-semibold text-zinc-200">{section.title}</h3>
          <ReportMarkdown content={section.content} remarkPlugins={citations ? [[remarkSavedReportCitations, citations]] : []} components={citations ? {
            a: ({ node, href, children, ...props }) => {
              const recordId = node?.properties["dataSavedEvidenceId"] ?? node?.properties["data-saved-evidence-id"];
              const target = typeof recordId === "string" ? citations.targets.get(recordId) : undefined;
              if (typeof recordId !== "string" || !target || href !== savedEvidenceHref(target)) {
                return <a {...props} href={href}>{children}</a>;
              }
              return <a {...props} href={href} aria-label={language === "zh" ? `查看所选版本的证据 ${recordId}` : `View evidence in this saved version: ${recordId}`} onKeyDown={(event) => {
                if (event.key === "Enter") { event.preventDefault(); event.currentTarget.click(); }
              }} onClick={(event) => {
                event.preventDefault();
                if (event.currentTarget.isConnected) navigateSavedEvidence(citations, recordId, event.currentTarget.ownerDocument);
              }}>{children}</a>;
            },
          } : undefined} />
        </section>
      ))}
    </div>
  );
}
