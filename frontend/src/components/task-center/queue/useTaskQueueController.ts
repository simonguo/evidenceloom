"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { buildRunForm, initialStats, validateTaskDraft } from "@/lib/analysis";
import { createRunContext } from "@/features/report-export/lib/versioning";
import { saveGlobalSettings } from "@/features/persistence/local-storage";
import { errorMessage } from "@/lib/errors";
import { createTranslator } from "@/lib/i18n";
import { getRuntimeAdapter, isTauriRuntime, type RuntimeAdapter } from "@/lib/runtime";
import type { AgentStatus, AnalysisEvent, AnalysisTask, GlobalSettings, RunContext } from "@/lib/types";
import { prependLog } from "../utils";
import { highestQueueOrder, queuePositionMap, sortQueuedTasks } from "./queue-utils";

type TaskQueueControllerOptions = {
  hydrated: boolean;
  tasks: AnalysisTask[];
  setTasks: Dispatch<SetStateAction<AnalysisTask[]>>;
  settings: GlobalSettings;
  runtimeAdapterRef: MutableRefObject<RuntimeAdapter | null>;
  persistTask: (task: AnalysisTask) => void;
  onEvent: (taskId: string, event: AnalysisEvent, runContext?: RunContext) => void;
  setNotice: (notice: string) => void;
};

export function useTaskQueueController({
  hydrated,
  tasks,
  setTasks,
  settings,
  runtimeAdapterRef,
  persistTask,
  onEvent,
  setNotice,
}: TaskQueueControllerOptions) {
  const abortRef = useRef<AbortController | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const stoppingTaskIdRef = useRef<string | null>(null);
  const dispatchingRef = useRef(false);
  const tasksRef = useRef(tasks);
  const queueSequenceRef = useRef(highestQueueOrder(tasks));
  const queueInitializedRef = useRef(false);
  const [schedulerVersion, setSchedulerVersion] = useState(0);
  const [executionActive, setExecutionActive] = useState(false);
  tasksRef.current = tasks;
  queueSequenceRef.current = Math.max(queueSequenceRef.current, highestQueueOrder(tasks));

  const queuedTasks = useMemo(() => sortQueuedTasks(tasks), [tasks]);
  const positions = useMemo(() => queuePositionMap(tasks), [tasks]);
  const runningTask = tasks.find((task) => task.status === "running") ?? null;

  const mutateTasks = useCallback((updater: (current: AnalysisTask[]) => AnalysisTask[]) => {
    setTasks((current) => {
      const next = updater(current);
      tasksRef.current = next;
      const previousById = new Map(current.map((task) => [task.id, task]));
      next.forEach((task) => {
        if (previousById.get(task.id) !== task) persistTask(task);
      });
      return next;
    });
  }, [persistTask, setTasks]);

  const patchTask = useCallback((taskId: string, updater: (task: AnalysisTask) => AnalysisTask) => {
    mutateTasks((current) => current.map((task) => task.id === taskId ? updater(task) : task));
  }, [mutateTasks]);

  const failTask = useCallback((taskId: string, message: string) => {
    patchTask(taskId, (task) => ({
      ...task,
      status: "error",
      updatedAt: new Date().toISOString(),
      error: message,
      agentStatuses: finalizeAgentStatuses(task.agentStatuses),
      logs: prependLog(task.logs, "error", message),
    }));
  }, [patchTask]);

  const startQueuedTask = useCallback(async (taskId: string) => {
    if (activeTaskIdRef.current || dispatchingRef.current) return false;
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (!task || task.status !== "queued") return false;

    dispatchingRef.current = true;
    activeTaskIdRef.current = taskId;
    setExecutionActive(true);
    let terminalEventObserved = false;
    const t = createTranslator(settings.systemLanguage);
    const runForm = buildRunForm(task, settings);
    const runContext = createRunContext(runForm);
    const validationErrors = validateTaskDraft(
      { ticker: runForm.ticker, analysisDate: runForm.analysisDate, analysts: runForm.analysts },
      runForm.assetType,
      settings.systemLanguage,
    );

    if (validationErrors.length > 0) {
      failTask(taskId, validationErrors.join(" "));
      activeTaskIdRef.current = null;
      dispatchingRef.current = false;
      setExecutionActive(false);
      setSchedulerVersion((version) => version + 1);
      return false;
    }

    if (!isTauriRuntime()) saveGlobalSettings(settings);
    abortRef.current = new AbortController();
    patchTask(taskId, (current) => resetTaskForRun(current));
    setNotice("");

    try {
      const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
      await adapter.runAnalysis(taskId, runForm, (event) => {
        if (stoppingTaskIdRef.current === taskId) return;
        if (event.type === "completed" || event.type === "error") terminalEventObserved = true;
        onEvent(taskId, event, runContext);
      }, abortRef.current.signal);

      if (!terminalEventObserved) {
        failTask(taskId, t("runnerEndedWithoutTerminalEvent"));
        return false;
      }
      return true;
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        failTask(taskId, errorMessage(error, t("analysisRequestFailed")));
      }
      return false;
    } finally {
      activeTaskIdRef.current = null;
      stoppingTaskIdRef.current = null;
      abortRef.current = null;
      dispatchingRef.current = false;
      setExecutionActive(false);
      setSchedulerVersion((version) => version + 1);
    }
  }, [failTask, onEvent, patchTask, runtimeAdapterRef, setNotice, settings]);

  useEffect(() => {
    if (!hydrated || queueInitializedRef.current) return;
    queueInitializedRef.current = true;
    const ordered = sortQueuedTasks(tasksRef.current);
    queueSequenceRef.current = ordered.length;
    if (ordered.every((task, index) => task.queueOrder === index + 1)) return;
    const orderById = new Map(ordered.map((task, index) => [task.id, index + 1]));
    mutateTasks((current) => current.map((task) => {
      const queueOrder = orderById.get(task.id);
      return queueOrder === undefined || task.queueOrder === queueOrder ? task : { ...task, queueOrder };
    }));
  }, [hydrated, mutateTasks]);

  useEffect(() => {
    if (!hydrated || activeTaskIdRef.current || dispatchingRef.current) return;
    if (tasks.some((task) => task.status === "running")) return;
    const nextTask = sortQueuedTasks(tasks)[0];
    if (nextTask) void startQueuedTask(nextTask.id);
  }, [hydrated, schedulerVersion, startQueuedTask, tasks]);

  const queueTask = useCallback((taskId: string, taskOverride?: AnalysisTask) => {
    const task = taskOverride ?? tasksRef.current.find((item) => item.id === taskId);
    if (!task || task.status === "running") return false;
    if (task.origin === "demo") {
      setNotice(createTranslator(settings.systemLanguage)("demoCannotRun"));
      return false;
    }
    if (task.status === "queued") return true;

    const runForm = buildRunForm(task, settings);
    const validationErrors = validateTaskDraft(
      { ticker: runForm.ticker, analysisDate: runForm.analysisDate, analysts: runForm.analysts },
      runForm.assetType,
      settings.systemLanguage,
    );
    if (validationErrors.length > 0) {
      setNotice(validationErrors.join(" "));
      return false;
    }

    queueSequenceRef.current += 1;
    const queueOrder = queueSequenceRef.current;
    const queuedAt = new Date().toISOString();
    patchTask(taskId, (current) => resetTaskForQueue(current, queuedAt, queueOrder));
    return true;
  }, [patchTask, setNotice, settings]);

  const cancelQueuedTask = useCallback((taskId: string) => {
    patchTask(taskId, (task) => task.status !== "queued" ? task : {
      ...task,
      status: "idle",
      queuedAt: "",
      queueOrder: null,
      updatedAt: new Date().toISOString(),
    });
  }, [patchTask]);

  const moveQueuedTask = useCallback((taskId: string, direction: "up" | "down") => {
    const ordered = sortQueuedTasks(tasksRef.current);
    const currentIndex = ordered.findIndex((task) => task.id === taskId);
    const targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= ordered.length) return;
    const reordered = [...ordered];
    [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[currentIndex]];
    const orderById = new Map(reordered.map((task, index) => [task.id, index + 1]));
    queueSequenceRef.current = reordered.length;
    mutateTasks((current) => current.map((task) => {
      const queueOrder = orderById.get(task.id);
      return queueOrder === undefined || task.queueOrder === queueOrder ? task : { ...task, queueOrder };
    }));
  }, [mutateTasks]);

  const stopRunningTask = useCallback(() => {
    const taskId = activeTaskIdRef.current ?? tasksRef.current.find((task) => task.status === "running")?.id;
    if (!taskId) return;
    stoppingTaskIdRef.current = taskId;
    patchTask(taskId, (task) => ({
      ...task,
      status: "stopped",
      updatedAt: new Date().toISOString(),
      logs: prependLog(task.logs, createTranslator(settings.systemLanguage)("system"), createTranslator(settings.systemLanguage)("taskStopped")),
    }));
    abortRef.current?.abort();
  }, [patchTask, settings.systemLanguage]);

  const getQueuePosition = useCallback((taskId: string) => positions.get(taskId) ?? null, [positions]);

  return {
    runningTask,
    queuedTasks,
    queueTask,
    cancelQueuedTask,
    moveQueuedTask,
    stopRunningTask,
    getQueuePosition,
    executionActive,
  };
}

function resetTaskForQueue(task: AnalysisTask, queuedAt: string, queueOrder: number): AnalysisTask {
  return {
    ...task,
    status: "queued",
    queuedAt,
    queueOrder,
    updatedAt: queuedAt,
    decision: "",
    stats: initialStats,
    agentStatuses: {},
    reportSections: {},
    logs: [],
    error: "",
  };
}

function resetTaskForRun(task: AnalysisTask): AnalysisTask {
  return {
    ...task,
    status: "running",
    queuedAt: "",
    queueOrder: null,
    updatedAt: new Date().toISOString(),
    decision: "",
    stats: initialStats,
    agentStatuses: {},
    reportSections: {},
    logs: [],
    error: "",
  };
}

function finalizeAgentStatuses(agentStatuses: Record<string, AgentStatus>) {
  return Object.fromEntries(
    Object.entries(agentStatuses).map(([agent, status]) => [agent, status === "in_progress" ? "error" : status]),
  ) as Record<string, AgentStatus>;
}
