import type { ReportVersion, SystemLanguage, TaskOrigin } from "@/lib/types";
import { ReportMarkdown } from "@/components/task-center/components/ReportMarkdown";
import { buildReportDocument } from "../lib/report-document";

export function ReportVersionPreview({
  version, taskId, origin, language,
}: {
  version: ReportVersion;
  taskId: string;
  origin: TaskOrigin;
  language: SystemLanguage;
}) {
  const document = buildReportDocument(taskId, origin, version, language);
  return (
    <div className="mt-4 space-y-5" aria-label={language === "zh" ? `报告版本 v${version.versionNumber} 预览` : `Report version v${version.versionNumber} preview`}>
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
          <ReportMarkdown content={section.content} />
        </section>
      ))}
    </div>
  );
}
