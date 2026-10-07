import clsx from "clsx";
import { createTranslator } from "@/lib/i18n";
import type { TaskStatus } from "@/lib/types";
import { taskStatusStyle } from "../constants";
import { useTaskCenter } from "../context";
import type { TaskDisplayStatus } from "../queue/task-display-status";

const displayStatusStyle: Record<TaskDisplayStatus, string> = {
  ...taskStatusStyle,
  starting: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  stopping: "border-zinc-600 bg-zinc-900 text-zinc-300",
  result_pending: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  cleanup_failed: "border-rose-400/40 bg-rose-400/10 text-rose-200",
};

export function StatusPill({ status, taskId }: { status: TaskStatus; taskId?: string }) {
  const { settings, getTask, getTaskDisplayStatus } = useTaskCenter();
  const task = taskId ? getTask(taskId) : undefined;
  const displayStatus = task && getTaskDisplayStatus ? getTaskDisplayStatus(task) : status;
  const t = createTranslator(settings.systemLanguage);
  return <span className={clsx("inline-flex shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs capitalize", displayStatusStyle[displayStatus])}>{t(displayStatus)}</span>;
}
