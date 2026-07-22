import type { AnalysisTask } from "@/lib/types";

export function sortQueuedTasks(tasks: AnalysisTask[]) {
  return tasks
    .filter((task) => task.status === "queued")
    .sort((a, b) => {
      const orderA = a.queueOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.queueOrder ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
      const queuedAtDifference = Date.parse(a.queuedAt || a.createdAt) - Date.parse(b.queuedAt || b.createdAt);
      if (queuedAtDifference !== 0) return queuedAtDifference;
      return a.id.localeCompare(b.id);
    });
}

export function queuePositionMap(tasks: AnalysisTask[]) {
  return new Map(sortQueuedTasks(tasks).map((task, index) => [task.id, index + 1]));
}

export function highestQueueOrder(tasks: AnalysisTask[]) {
  return tasks.reduce((highest, task) => Math.max(highest, task.queueOrder ?? 0), 0);
}
