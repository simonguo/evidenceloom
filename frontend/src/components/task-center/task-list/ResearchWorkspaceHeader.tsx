import Link from "next/link";
import { Plus } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import type { SystemLanguage } from "@/lib/types";
import type { workspaceSummary } from "./research-workspace";

type Props = { language: SystemLanguage; summary: ReturnType<typeof workspaceSummary> };

export function ResearchWorkspaceHeader({ language, summary }: Props) {
  const t = createTranslator(language);
  const counts = [
    ["tasks", summary.total], ["completed", summary.completed], ["running", summary.running],
    ["queued", summary.queued], ["error", summary.failed],
  ] as const;
  return (
    <section aria-labelledby="research-workspace-title" className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 id="research-workspace-title" className="text-2xl font-semibold tracking-tight text-white">{t("researchWorkspaceTitle")}</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-300">{t("researchWorkspaceHint")}</p>
        </div>
        <Link href="/tasks/new" className="vercel-button min-h-11 shrink-0 self-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950">
          <Plus className="size-4" aria-hidden="true" />{t("workspaceStartResearch")}
        </Link>
      </div>
      <dl aria-label={t("workspaceExecutionSummary")} className="flex flex-wrap gap-x-6 gap-y-2 border-t border-zinc-800 pt-4 text-sm">
        {counts.map(([label, value]) => (
          <div key={label} className="flex items-baseline gap-2">
            <dt className="text-zinc-400">{t(label)}</dt>
            <dd className="font-semibold tabular-nums text-zinc-100">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
