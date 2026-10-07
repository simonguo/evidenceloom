import { ArrowUpRight } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import { analystOptions, type AnalysisTask, type SystemLanguage } from "@/lib/types";
import { formatDateTime, localizedDecision, taskDetailHref } from "../utils";
import { StatusPill } from "../components/StatusPill";
import type { TaskDisplayStatus } from "../queue/task-display-status";
import { workspaceOpenLabel } from "./research-workspace";

type Props = {
  tasks: AnalysisTask[];
  language: SystemLanguage;
  status: (task: AnalysisTask) => TaskDisplayStatus;
  getQueuePosition: (taskId: string) => number | null;
  onOpen: (href: string) => void;
  onPrefetch: (href: string) => void;
};

export function ResearchTaskTable({ tasks, language, status, getQueuePosition, onOpen, onPrefetch }: Props) {
  const t = createTranslator(language);
  return (
    <>
      <p className="border-b border-zinc-800 px-5 py-2 text-xs text-zinc-400 md:hidden">{t("workspaceScrollHint")}</p>
      <div role="region" aria-label={t("workspaceResearchLibrary")} tabIndex={0} className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-300">
        <table className="w-full min-w-[640px] border-collapse">
          <caption className="sr-only">{t("workspaceLibraryHint")}</caption>
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left text-sm text-zinc-300">
              <th scope="col" className="px-5 py-3 font-medium">{t("workspaceInstrument")}</th>
              <th scope="col" className="px-4 py-3 font-medium">{t("status")}</th>
              <th scope="col" className="px-4 py-3 font-medium">{t("workspaceResearchScope")}</th>
              <th scope="col" className="px-4 py-3 font-medium">{t("workspaceLatestConclusion")}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map(task => {
              const href = taskDetailHref(task.id), current = status(task);
              const position = current === "queued" ? getQueuePosition(task.id) : null;
              const action = t(workspaceOpenLabel(task, current));
              const scope = task.analysts.flatMap(key => { const option = analystOptions.find(item => item.key === key); return option ? [t(option.labelKey)] : []; }).join(" · ");
              return (
                <tr key={task.id} data-task-id={task.id} role="link" tabIndex={0}
                  aria-label={t("workspaceOpenRow", { ticker: task.ticker, date: task.analysisDate, action, status: t(current) })}
                  className="group cursor-pointer border-b border-zinc-800/70 transition last:border-b-0 hover:bg-zinc-900/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-300"
                  onPointerEnter={() => onPrefetch(href)} onFocus={() => onPrefetch(href)} onClick={() => onOpen(href)}
                  onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(href); } }}>
                  <td className="min-w-56 px-5 py-4 align-top">
                    <div className="font-semibold text-zinc-100">{task.ticker}</div>
                    {task.instrumentName && <div className="mt-1 max-w-64 break-words text-sm text-zinc-300">{task.instrumentName}</div>}
                    <div className="mt-2 text-xs text-zinc-400">{t("workspaceResearchDate")}: <time dateTime={task.analysisDate}>{task.analysisDate}</time></div>
                    {task.origin === "demo" && <div className="mt-1 text-xs text-amber-200">{t("fictionalDemoBadge")}</div>}
                    <div className="mt-3 inline-flex items-center gap-1 text-sm text-sky-300 group-hover:text-sky-200">{action}<ArrowUpRight className="size-3.5" aria-hidden="true" /></div>
                  </td>
                  <td className="px-4 py-4 align-top">
                    <div className="flex flex-col items-start gap-2">
                      <StatusPill status={task.status} taskId={task.id} />
                      {position !== null && Number.isSafeInteger(position) && position > 0 && <span className="text-xs text-amber-200">{t("queuePosition", { position })}</span>}
                    </div>
                  </td>
                  <td className="min-w-36 px-4 py-4 align-top text-sm leading-6 text-zinc-300">{scope || t("workspaceScopeNotSelected")}</td>
                  <td className="max-w-md px-4 py-4 align-top">
                    <div className="line-clamp-2 text-sm leading-6 text-zinc-300">{task.error || localizedDecision(task.decision, language) || t("noResultYet")}</div>
                    <div className="mt-2 text-xs text-zinc-400">{t("updated")}: {formatDateTime(task.updatedAt)}</div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
