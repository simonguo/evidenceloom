"use client";

import { useRouter } from "next/navigation";
import { SearchX } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import { useTaskCenter } from "@/components/task-center/context";
import { EmptyTasks } from "@/components/task-center/components/EmptyTasks";
import { TaskQueuePanel } from "@/components/task-center/queue/TaskQueuePanel";
import { TaskListFilters } from "@/components/task-center/task-list/TaskListFilters";
import { useTaskFilters } from "@/components/task-center/task-list/useTaskFilters";
import { ResearchWorkspaceHeader } from "@/components/task-center/task-list/ResearchWorkspaceHeader";
import { ResearchTaskTable } from "@/components/task-center/task-list/ResearchTaskTable";
import { workspaceSummary } from "@/components/task-center/task-list/research-workspace";

export default function Page() {
  const router = useRouter();
  const { settings, sortedTasks, runningTask, startingTask, queuedTasks, cleanupFailedTask, cleanupRetrying, cleanupUnconfirmed, retryCleanup, resultPendingTask, resultRetrying, retryResult, stopping, getQueuePosition, stopRunningTask, cancelQueuedTask, moveQueuedTask, getTaskDisplayStatus } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  const displayStatus = (task: (typeof sortedTasks)[number]) => getTaskDisplayStatus?.(task) ?? task.status;
  const summary = workspaceSummary(sortedTasks, displayStatus);
  const { query, setQuery, decisionFilter, setDecisionFilter, filteredTasks } = useTaskFilters(sortedTasks);

  return (
    <div className="space-y-6">
      <ResearchWorkspaceHeader language={settings.systemLanguage} summary={summary} />

      {(runningTask || startingTask || cleanupFailedTask || resultPendingTask || queuedTasks.length > 0) && (
        <TaskQueuePanel
          runningTask={runningTask}
          startingTask={startingTask}
          queuedTasks={queuedTasks}
          cleanupFailedTask={cleanupFailedTask}
          cleanupRetrying={cleanupRetrying}
          cleanupUnconfirmed={cleanupUnconfirmed}
          resultPendingTask={resultPendingTask}
          resultRetrying={resultRetrying}
          onRetryResult={() => { void retryResult(); }}
          stopping={stopping}
          onRetryCleanup={() => { void retryCleanup(); }}
          language={settings.systemLanguage}
          onStop={stopRunningTask}
          onCancel={cancelQueuedTask}
          onMove={moveQueuedTask}
        />
      )}

      <section aria-labelledby="research-library-title" className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/70">
        <div className="border-b border-zinc-800 px-5 py-4">
          <h2 id="research-library-title" className="text-base font-semibold text-white">{t("workspaceResearchLibrary")}</h2>
          <p className="mt-1 text-sm leading-6 text-zinc-400">{t("workspaceLibraryHint")}</p>
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
            <div className="mt-1 text-sm text-zinc-400">{t("adjustTaskFilters")}</div>
          </div>
        ) : (
          <ResearchTaskTable tasks={filteredTasks} language={settings.systemLanguage} status={displayStatus}
            getQueuePosition={getQueuePosition} onOpen={href => router.push(href)} onPrefetch={href => router.prefetch(href)} />
        )}
      </section>
    </div>
  );
}
