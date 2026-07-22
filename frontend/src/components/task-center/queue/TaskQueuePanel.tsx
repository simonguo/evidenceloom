import Link from "next/link";
import { Activity, ArrowDown, ArrowUp, Clock3, Square, X } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import type { AnalysisTask, SystemLanguage } from "@/lib/types";
import { taskDetailHref } from "../utils";

type TaskQueuePanelProps = {
  runningTask: AnalysisTask | null;
  queuedTasks: AnalysisTask[];
  language: SystemLanguage;
  onStop: () => void;
  onCancel: (taskId: string) => void;
  onMove: (taskId: string, direction: "up" | "down") => void;
};

export function TaskQueuePanel({ runningTask, queuedTasks, language, onStop, onCancel, onMove }: TaskQueuePanelProps) {
  const t = createTranslator(language);

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-900 bg-black">
      <div className="flex items-center justify-between gap-4 border-b border-zinc-900 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold text-white">{t("taskQueue")}</h2>
          <p className="mt-1 text-xs text-zinc-500">{t("taskQueueHint")}</p>
        </div>
        <span className="whitespace-nowrap text-xs text-zinc-500">{t("queuedCount", { count: queuedTasks.length })}</span>
      </div>

      {runningTask && (
        <div className="flex items-center gap-3 border-b border-zinc-900 px-5 py-3">
          <Activity className="size-4 shrink-0 animate-pulse text-sky-300" />
          <Link href={taskDetailHref(runningTask.id)} className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-white">{runningTask.ticker}</span>
              <span className="text-xs text-sky-300">{t("queueCurrent")}</span>
            </div>
            {runningTask.instrumentName && <div className="mt-0.5 truncate text-xs text-zinc-500">{runningTask.instrumentName}</div>}
          </Link>
          <button type="button" onClick={onStop} title={t("stopTask")} aria-label={t("stopTask")} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 text-rose-300 transition hover:border-zinc-600 hover:bg-rose-950/30">
            <Square className="size-3.5" />
          </button>
        </div>
      )}

      <div className="divide-y divide-zinc-900">
        {queuedTasks.map((task, index) => (
          <div key={task.id} className="flex items-center gap-3 px-5 py-3">
            <Clock3 className="size-4 shrink-0 text-amber-300" />
            <Link href={taskDetailHref(task.id)} className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-zinc-200">{task.ticker}</span>
                <span className="text-xs text-amber-200">{t("queuePosition", { position: index + 1 })}</span>
              </div>
              {task.instrumentName && <div className="mt-0.5 truncate text-xs text-zinc-500">{task.instrumentName}</div>}
            </Link>
            <div className="flex shrink-0 items-center gap-1">
              <QueueIconButton label={t("moveUp")} disabled={index === 0} onClick={() => onMove(task.id, "up")} icon={<ArrowUp className="size-3.5" />} />
              <QueueIconButton label={t("moveDown")} disabled={index === queuedTasks.length - 1} onClick={() => onMove(task.id, "down")} icon={<ArrowDown className="size-3.5" />} />
              <QueueIconButton label={t("cancelQueue")} onClick={() => onCancel(task.id)} icon={<X className="size-3.5" />} danger />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function QueueIconButton({ label, icon, disabled = false, danger = false, onClick }: { label: string; icon: React.ReactNode; disabled?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex size-8 items-center justify-center rounded-md border border-transparent transition disabled:cursor-not-allowed disabled:opacity-25 ${danger ? "text-rose-300 hover:border-rose-900 hover:bg-rose-950/30" : "text-zinc-400 hover:border-zinc-800 hover:bg-zinc-900 hover:text-white"}`}
    >
      {icon}
    </button>
  );
}
