"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, SearchX } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import { useTaskCenter } from "@/components/task-center/context";
import { formatDateTime, localizedDecision, taskDetailHref } from "@/components/task-center/utils";
import { EmptyTasks } from "@/components/task-center/components/EmptyTasks";
import { SummaryTile } from "@/components/task-center/components/SummaryTile";
import { StatusPill } from "@/components/task-center/components/StatusPill";
import { TaskQueuePanel } from "@/components/task-center/queue/TaskQueuePanel";
import { TaskListFilters } from "@/components/task-center/task-list/TaskListFilters";
import { useTaskFilters } from "@/components/task-center/task-list/useTaskFilters";

export default function Page() {
  const router = useRouter();
  const { settings, sortedTasks, runningTask, queuedTasks, getQueuePosition, stopRunningTask, cancelQueuedTask, moveQueuedTask } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  const completed = sortedTasks.filter((task) => task.status === "completed").length;
  const failed = sortedTasks.filter((task) => task.status === "error").length;
  const running = sortedTasks.filter((task) => task.status === "running").length;
  const { query, setQuery, decisionFilter, setDecisionFilter, filteredTasks } = useTaskFilters(sortedTasks);

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryTile label={t("tasks")} value={sortedTasks.length.toString()} />
        <SummaryTile label={t("completed")} value={completed.toString()} />
        <SummaryTile label={t("running")} value={running.toString()} highlight={running > 0} />
        <SummaryTile label={t("queued")} value={queuedTasks.length.toString()} highlight={queuedTasks.length > 0} />
        <SummaryTile label={t("failed")} value={failed.toString()} />
      </section>

      {(runningTask || queuedTasks.length > 0) && (
        <TaskQueuePanel
          runningTask={runningTask}
          queuedTasks={queuedTasks}
          language={settings.systemLanguage}
          onStop={stopRunningTask}
          onCancel={cancelQueuedTask}
          onMove={moveQueuedTask}
        />
      )}

      <section className="overflow-hidden rounded-xl border border-zinc-900 bg-black">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-900 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">{t("tasks")}</h2>
            <p className="mt-1 text-sm text-zinc-500">{t("runHistoryHint")}</p>
          </div>
          <div className="flex items-center gap-2">
            {failed > 0 && <span className="rounded-full border border-red-900/70 px-2.5 py-1 text-xs text-red-300">{failed} {t("failedCount")}</span>}
            <Link href="/tasks/new" className="vercel-button"><Plus className="size-4" /> {t("newTask")}</Link>
          </div>
        </div>

        {sortedTasks.length > 0 && (
          <TaskListFilters
            query={query}
            decisionFilter={decisionFilter}
            resultCount={filteredTasks.length}
            totalCount={sortedTasks.length}
            language={settings.systemLanguage}
            onQueryChange={setQuery}
            onDecisionChange={setDecisionFilter}
          />
        )}

        {sortedTasks.length === 0 ? (
          <EmptyTasks />
        ) : filteredTasks.length === 0 ? (
          <div className="flex min-h-52 flex-col items-center justify-center px-5 py-10 text-center">
            <SearchX className="size-8 text-zinc-700" />
            <div className="mt-3 text-sm font-medium text-zinc-300">{t("noMatchingTasks")}</div>
            <div className="mt-1 text-xs text-zinc-600">{t("adjustTaskFilters")}</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr>
                  <th className="dashboard-table-header">{t("task")}</th>
                  <th className="dashboard-table-header w-28 whitespace-nowrap">{t("status")}</th>
                  <th className="dashboard-table-header">{t("analysts")}</th>
                  <th className="dashboard-table-header">{t("decision")}</th>
                  <th className="dashboard-table-header">{t("updated")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((task) => {
                  const href = taskDetailHref(task.id);
                  return (
                    <tr
                      key={task.id}
                      role="link"
                      tabIndex={0}
                      className="group cursor-pointer transition hover:bg-zinc-950/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-700"
                      onPointerEnter={() => router.prefetch(href)}
                      onFocus={() => router.prefetch(href)}
                      onClick={() => router.push(href)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          router.push(href);
                        }
                      }}
                    >
                      <td className="dashboard-table-cell">
                        <div className="font-medium text-white">{task.ticker}</div>
                        {task.instrumentName && <div className="mt-1 max-w-56 truncate text-xs text-zinc-400">{task.instrumentName}</div>}
                        <div className="mt-1 text-xs text-zinc-500">{task.analysisDate}</div>
                      </td>
                      <td className="dashboard-table-cell w-28 whitespace-nowrap">
                        <div className="flex flex-col items-start gap-1">
                          <StatusPill status={task.status} />
                          {task.status === "queued" && <span className="text-[11px] text-amber-200">{t("queuePosition", { position: getQueuePosition(task.id) ?? 1 })}</span>}
                        </div>
                      </td>
                      <td className="dashboard-table-cell">{task.analysts.length}</td>
                      <td className="dashboard-table-cell max-w-md">
                        <div className="line-clamp-2 text-zinc-400">{task.error || localizedDecision(task.decision, settings.systemLanguage) || t("noResultYet")}</div>
                      </td>
                      <td className="dashboard-table-cell whitespace-nowrap text-zinc-500">{formatDateTime(task.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
