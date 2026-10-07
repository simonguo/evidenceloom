import type { AgentStatus, AnalysisTask, TaskStatus } from "@/lib/types";

export type TaskDisplayStatus = TaskStatus | "starting" | "stopping" | "result_pending" | "cleanup_failed";
export type AgentDisplayStatus = AgentStatus | "sync_pending" | "stopped";

export function agentDisplayStatus(status: AgentStatus, taskStatus: TaskDisplayStatus): AgentDisplayStatus {
  if (status !== "in_progress") return status;
  if (taskStatus === "running") return status;
  if (taskStatus === "stopped") return "stopped";
  if (taskStatus === "error") return "error";
  if (taskStatus === "idle" || taskStatus === "queued" || taskStatus === "starting") return "pending";
  return "sync_pending";
}

export function taskDisplayStatus(task: AnalysisTask, execution: {
  runningTask?: AnalysisTask | null;
  startingTask?: AnalysisTask | null;
  resultPendingTask?: AnalysisTask | null;
  cleanupFailedTask?: AnalysisTask | null;
  stopping: boolean;
}): TaskDisplayStatus {
  if (execution.cleanupFailedTask?.id === task.id) return "cleanup_failed";
  if (execution.resultPendingTask?.id === task.id) return "result_pending";
  if (execution.startingTask?.id === task.id) return execution.stopping ? "stopping" : "starting";
  if (execution.runningTask?.id === task.id) return execution.stopping ? "stopping" : "running";
  return task.status;
}
