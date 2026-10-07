import type { AnalysisTask } from "@/lib/types";
import type { TaskDisplayStatus } from "../queue/task-display-status";

export function workspaceSummary(tasks: AnalysisTask[], status: (task: AnalysisTask) => TaskDisplayStatus) {
  const result = { total: tasks.length, completed: 0, running: 0, queued: 0, failed: 0 };
  for (const task of tasks) {
    const current = status(task);
    if (current === "completed") result.completed++;
    if (current === "running") result.running++;
    if (current === "queued") result.queued++;
    if (current === "error") result.failed++;
  }
  return result;
}

export function workspaceOpenLabel(task: AnalysisTask, status: TaskDisplayStatus) {
  if (status === "stopping" || status === "result_pending" || status === "cleanup_failed") return "workspaceOpenResearch";
  if (status === "starting") return "workspaceViewProgress";
  if (task.reportVersions.length > 0) return "workspaceOpenSavedReport";
  if (status === "running" || status === "queued") return "workspaceViewProgress";
  return "workspaceOpenResearch";
}
