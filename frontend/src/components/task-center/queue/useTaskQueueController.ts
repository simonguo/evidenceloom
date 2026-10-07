"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { buildRunForm, initialStats, validateTaskDraft } from "@/lib/analysis";
import { createRunContext } from "@/features/report-export/lib/versioning";
import { saveGlobalSettings } from "@/features/persistence/local-storage";
import { errorMessage } from "@/lib/errors";
import { isAnalysisCleanupError } from "@/lib/desktop-analysis";
import { createTranslator } from "@/lib/i18n";
import { getRuntimeAdapter, isTauriRuntime, type RuntimeAdapter } from "@/lib/runtime";
import type { AgentStatus, AnalysisEvent, AnalysisTask, GlobalSettings, RunContext } from "@/lib/types";
import { prependLog } from "../utils";
import { highestQueueOrder, queuePositionMap, sortQueuedTasks } from "./queue-utils";
import type { RunOwner, TaskAction } from "@/features/desktop-task-store/types";
import type { SameSessionConsumer } from "@/features/analysis-recovery/lib/consumer";
import { RecoveryAdmissionRejectedError } from "@/features/analysis-recovery/lib/transport";

type Execution = { taskId: string; controller: AbortController; adapter: RuntimeAdapter; stopPromise?: Promise<void>; owner?: RunOwner; recovery?: SameSessionConsumer };

type TaskQueueControllerOptions = {
  hydrated: boolean;
  tasks: AnalysisTask[];
  setTasks: Dispatch<SetStateAction<AnalysisTask[]>>;
  settings: GlobalSettings;
  runtimeAdapterRef: MutableRefObject<RuntimeAdapter | null>;
  persistTask: (task: AnalysisTask) => void;
  onEvent: (taskId: string, event: AnalysisEvent, runContext?: RunContext, owner?: RunOwner) => void;
  storageReady?: boolean;
  blockedQueueNotice?: string;
  mutateDesktopTask?: (task: AnalysisTask, updater: (task: AnalysisTask) => AnalysisTask, owner?: RunOwner) => TaskAction | undefined;
  beginDesktopRun?: (task: AnalysisTask) => Promise<RunOwner | undefined>;
  confirmDesktopAction?: (action: TaskAction) => Promise<unknown>;
  retireDesktopRun?: (owner: RunOwner) => void;
  prepareDesktopRun?: (task: AnalysisTask, form: ReturnType<typeof buildRunForm>, context: RunContext) => SameSessionConsumer;
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
  storageReady = true,
  blockedQueueNotice,
  mutateDesktopTask,
  retireDesktopRun,
  prepareDesktopRun,
}: TaskQueueControllerOptions) {
  const activeExecutionRef = useRef<Execution | null>(null);
  const cleanupBlockedRef = useRef<Execution | null>(null);
  const [cleanupTaskId, setCleanupTaskId] = useState<string | null>(null);
  const [cleanupRetrying, setCleanupRetrying] = useState(false);
  const cleanupRetryingRef = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [resultTaskId, setResultTaskId] = useState<string | null>(null);
  const [resultRetrying, setResultRetrying] = useState(false);
  const resultRetryingRef = useRef(false);
  const activeTaskIdRef = useRef<string | null>(null);
  const stoppingTaskIdRef = useRef<string | null>(null);
  const dispatchingRef = useRef(false);
  const rejectedAdmissionsRef = useRef(new Map<string, AnalysisTask>());
  const tasksRef = useRef(tasks);
  const queueSequenceRef = useRef(highestQueueOrder(tasks));
  const queueInitializedRef = useRef(false);
  const [schedulerVersion, setSchedulerVersion] = useState(0);
  const [executionActive, setExecutionActive] = useState(false);
  tasksRef.current = tasks;
  queueSequenceRef.current = Math.max(queueSequenceRef.current, highestQueueOrder(tasks));

  const queuedTasks = useMemo(() => sortQueuedTasks(tasks), [tasks]);
  const positions = useMemo(() => queuePositionMap(tasks), [tasks]);
  const runningTask = cleanupTaskId ? null : tasks.find((task) => task.id === activeExecutionRef.current?.taskId)
    ?? tasks.find((task) => task.status === "running") ?? null;

  const mutateTasks = useCallback((updater: (current: AnalysisTask[]) => AnalysisTask[]) => {
    const current = tasksRef.current, next = updater(current);
    const previousById = new Map(current.map((task) => [task.id, task]));
    if (isTauriRuntime() && mutateDesktopTask) {
      next.forEach((task) => { const previous = previousById.get(task.id); if (previous && previous !== task) { const captured = structuredClone(task); mutateDesktopTask(previous, () => captured, activeExecutionRef.current?.taskId === task.id ? activeExecutionRef.current.owner : undefined); } });
      return;
    }
    tasksRef.current = next; setTasks(next);
    next.forEach((task) => { if (previousById.get(task.id) !== task) persistTask(task); });
  }, [mutateDesktopTask, persistTask, setTasks]);

  const patchTask = useCallback((taskId: string, updater: (task: AnalysisTask) => AnalysisTask) => {
    if (isTauriRuntime() && mutateDesktopTask) {
      const task = tasksRef.current.find((item) => item.id === taskId);
      if (task) mutateDesktopTask(task, updater, activeExecutionRef.current?.taskId === taskId ? activeExecutionRef.current.owner : undefined);
      return;
    }
    mutateTasks((current) => current.map((task) => task.id === taskId ? updater(task) : task));
  }, [mutateDesktopTask, mutateTasks]);

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
    if (!storageReady || activeTaskIdRef.current || dispatchingRef.current || cleanupBlockedRef.current) return false;
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
    const execution: Execution = { taskId, controller: new AbortController(), adapter: runtimeAdapterRef.current ?? getRuntimeAdapter() };
    activeExecutionRef.current = execution;
    if (!isTauriRuntime()) patchTask(taskId, (current) => resetTaskForRun(current));
    setNotice("");

    try {
      if (isTauriRuntime()) {
        if (!prepareDesktopRun || !execution.adapter.runPreparedAnalysis) throw new Error("Native analysis authority is unavailable.");
        // Admission packet and transient execution input are captured before this first await.
        execution.recovery = prepareDesktopRun(task, runForm, runContext);
        await execution.adapter.runPreparedAnalysis(execution.recovery, taskId, execution.controller.signal);
        return execution.recovery.phase === "ready";
      }
      await execution.adapter.runAnalysis(taskId, runForm, (event) => {
        if (activeExecutionRef.current !== execution || stoppingTaskIdRef.current === taskId) return;
        if (event.type === "completed" || event.type === "error") terminalEventObserved = true;
        onEvent(taskId, event, runContext, execution.owner);
      }, execution.controller.signal);

      if (activeExecutionRef.current !== execution) return false;
      if (execution.controller.signal.aborted) {
        await execution.stopPromise;
        patchTask(taskId, (current) => ({ ...current, status: "stopped", updatedAt: new Date().toISOString() }));
        return false;
      }

      if (!terminalEventObserved) {
        failTask(taskId, t("runnerEndedWithoutTerminalEvent"));
        return false;
      }
      return true;
    } catch (error) {
      if (activeExecutionRef.current !== execution) return false;
      if (execution.recovery) {
        setStopping(false);
        if (error instanceof RecoveryAdmissionRejectedError && execution.recovery.phase === "ready") { rejectedAdmissionsRef.current.set(taskId, task); setNotice(t("analysisAdmissionRejected")); }
        else if (execution.recovery.phase === "cleanup_failed" || isAnalysisCleanupError(error)) { cleanupBlockedRef.current = execution; setCleanupTaskId(taskId); setNotice(t("analysisCleanupUnconfirmed")); }
        else { setResultTaskId(taskId); setNotice(t("analysisResultPending")); }
        return false;
      }
      if (isAnalysisCleanupError(error) || cleanupBlockedRef.current === execution) {
        cleanupBlockedRef.current = execution;
        setCleanupTaskId(taskId);
        failTask(taskId, t("analysisCleanupFailed"));
      } else if (execution.controller.signal.aborted && (error as Error)?.name === "AbortError") {
        try {
          await execution.stopPromise;
          patchTask(taskId, (current) => ({ ...current, status: "stopped", updatedAt: new Date().toISOString() }));
        } catch {
          cleanupBlockedRef.current = execution;
          setCleanupTaskId(taskId);
          failTask(taskId, t("analysisCleanupFailed"));
        }
      } else {
        try {
          await execution.stopPromise;
          failTask(taskId, errorMessage(error, t("analysisRequestFailed")));
        } catch {
          cleanupBlockedRef.current = execution;
          setCleanupTaskId(taskId);
          failTask(taskId, t("analysisCleanupFailed"));
        }
      }
      return false;
    } finally {
      if (activeExecutionRef.current === execution && cleanupBlockedRef.current !== execution && (!execution.recovery || execution.recovery.phase === "ready")) {
        if (execution.owner) retireDesktopRun?.(execution.owner);
        activeExecutionRef.current = null;
        activeTaskIdRef.current = null;
        stoppingTaskIdRef.current = null;
        dispatchingRef.current = false;
        setStopping(false);
        setExecutionActive(false);
        setSchedulerVersion((version) => version + 1);
      }
    }
  }, [failTask, onEvent, patchTask, prepareDesktopRun, retireDesktopRun, runtimeAdapterRef, setNotice, settings, storageReady]);

  useEffect(() => {
    if (!hydrated || !storageReady || queueInitializedRef.current) return;
    queueInitializedRef.current = true;
    const ordered = sortQueuedTasks(tasksRef.current);
    queueSequenceRef.current = ordered.length;
    if (ordered.every((task, index) => task.queueOrder === index + 1)) return;
    const orderById = new Map(ordered.map((task, index) => [task.id, index + 1]));
    mutateTasks((current) => current.map((task) => {
      const queueOrder = orderById.get(task.id);
      return queueOrder === undefined || task.queueOrder === queueOrder ? task : { ...task, queueOrder };
    }));
  }, [hydrated, mutateTasks, storageReady]);

  useEffect(() => {
    if (!hydrated || !storageReady || activeTaskIdRef.current || dispatchingRef.current || cleanupBlockedRef.current) return;
    if (tasks.some((task) => task.status === "running")) return;
    const nextTask = sortQueuedTasks(tasks).find((task) => rejectedAdmissionsRef.current.get(task.id) !== task);
    if (nextTask) void startQueuedTask(nextTask.id);
  }, [hydrated, schedulerVersion, startQueuedTask, storageReady, tasks]);

  const queueTask = useCallback((taskId: string, taskOverride?: AnalysisTask) => {
    if (!storageReady) {
      setNotice(blockedQueueNotice ?? createTranslator(settings.systemLanguage)("taskStorageUnconfirmed"));
      return false;
    }
    const task = taskOverride ?? tasksRef.current.find((item) => item.id === taskId);
    if (!task || task.status === "running" || activeExecutionRef.current?.taskId === taskId && !cleanupBlockedRef.current) return false;
    if (cleanupBlockedRef.current?.taskId === taskId) {
      setNotice(createTranslator(settings.systemLanguage)("analysisCleanupFailed"));
      return false;
    }
    if (task.origin === "demo") {
      setNotice(createTranslator(settings.systemLanguage)("demoCannotRun"));
      return false;
    }
    if (task.status === "queued") { rejectedAdmissionsRef.current.delete(taskId); setSchedulerVersion((version) => version + 1); return true; }

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
    if (isTauriRuntime() && mutateDesktopTask) return !!mutateDesktopTask(task, (current) => resetTaskForQueue(current, queuedAt, queueOrder));
    patchTask(taskId, (current) => resetTaskForQueue(current, queuedAt, queueOrder));
    return true;
  }, [blockedQueueNotice, mutateDesktopTask, patchTask, setNotice, settings, storageReady]);

  const cancelQueuedTask = useCallback((taskId: string, selectedTask?: AnalysisTask) => {
    if (isTauriRuntime() && mutateDesktopTask) {
      const task = selectedTask ?? tasksRef.current.find((item) => item.id === taskId);
      if (task && task.id === taskId) mutateDesktopTask(task, (original) => ({ ...original, status: "idle", queuedAt: "", queueOrder: null, updatedAt: new Date().toISOString() }));
      return;
    }
    patchTask(taskId, (task) => task.status !== "queued" ? task : {
      ...task,
      status: "idle",
      queuedAt: "",
      queueOrder: null,
      updatedAt: new Date().toISOString(),
    });
  }, [mutateDesktopTask, patchTask]);

  const moveQueuedTask = useCallback((taskId: string, direction: "up" | "down", selectedTask?: AnalysisTask) => {
    if (selectedTask && tasksRef.current.find((task) => task.id === taskId) !== selectedTask) return;
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
    const execution = activeExecutionRef.current;
    if (!execution || execution.stopPromise) return;
    stoppingTaskIdRef.current = execution.taskId;
    setStopping(true);
    execution.controller.abort();
    execution.stopPromise = execution.recovery ? execution.recovery.stop() : execution.adapter.stopAnalysis(execution.taskId);
    void execution.stopPromise.catch(() => {
      if (activeExecutionRef.current !== execution) return;
      cleanupBlockedRef.current = execution;
      setCleanupTaskId(execution.taskId);
      setStopping(false);
      if (execution.recovery) setNotice(createTranslator(settings.systemLanguage)("analysisCleanupUnconfirmed"));
      else failTask(execution.taskId, createTranslator(settings.systemLanguage)("analysisCleanupFailed"));
    });
  }, [failTask, settings.systemLanguage]);

  const retryCleanup = useCallback(async () => {
    const execution = cleanupBlockedRef.current;
    if (!execution || cleanupRetryingRef.current) return;
    cleanupRetryingRef.current = true;
    setCleanupRetrying(true);
    try {
      if (execution.recovery) {
        await execution.recovery.stop(true);
        await execution.adapter.runPreparedAnalysis?.(execution.recovery, execution.taskId, undefined, true);
        if (execution.recovery.phase !== "ready") throw new Error("Analysis gates remain unconfirmed.");
      } else {
      await execution.adapter.stopAnalysis(execution.taskId);
      if (cleanupBlockedRef.current !== execution) return;
      patchTask(execution.taskId, (task) => ({
        ...task, status: "stopped", error: "", updatedAt: new Date().toISOString(),
        logs: prependLog(task.logs, createTranslator(settings.systemLanguage)("system"), createTranslator(settings.systemLanguage)("taskStopped")),
      }));
      }
      cleanupBlockedRef.current = null;
      setCleanupTaskId(null);
      if (activeExecutionRef.current === execution) {
        if (execution.owner) retireDesktopRun?.(execution.owner);
        activeExecutionRef.current = null;
        activeTaskIdRef.current = null;
        stoppingTaskIdRef.current = null;
        dispatchingRef.current = false;
        setStopping(false);
        setExecutionActive(false);
      }
      setSchedulerVersion((version) => version + 1);
    } catch (error) {
      if (execution.recovery && (execution.recovery.phase === "cleanup_failed" || isAnalysisCleanupError(error))) { cleanupBlockedRef.current = execution; setCleanupTaskId(execution.taskId); setNotice(createTranslator(settings.systemLanguage)("analysisCleanupUnconfirmed")); }
      else if (execution.recovery) { cleanupBlockedRef.current = null; setCleanupTaskId(null); setResultTaskId(execution.taskId); setNotice(createTranslator(settings.systemLanguage)("analysisResultPending")); }
      else setNotice(createTranslator(settings.systemLanguage)("analysisCleanupFailed"));
    } finally {
      cleanupRetryingRef.current = false;
      setCleanupRetrying(false);
    }
  }, [patchTask, retireDesktopRun, setNotice, settings.systemLanguage]);

  const retryResult = useCallback(async () => {
    const execution = activeExecutionRef.current;
    if (!execution?.recovery || resultRetryingRef.current) return;
    resultRetryingRef.current = true; setResultRetrying(true);
    try {
      await execution.adapter.runPreparedAnalysis?.(execution.recovery, execution.taskId, undefined, true);
      if (activeExecutionRef.current !== execution || execution.recovery.phase !== "ready") return;
      setResultTaskId(null); setCleanupTaskId(null); cleanupBlockedRef.current = null;
      activeExecutionRef.current = null; activeTaskIdRef.current = null; stoppingTaskIdRef.current = null; dispatchingRef.current = false;
      setStopping(false); setExecutionActive(false); setSchedulerVersion((version) => version + 1);
    } catch (error) {
      if (execution.recovery.phase === "cleanup_failed" || isAnalysisCleanupError(error)) { cleanupBlockedRef.current = execution; setCleanupTaskId(execution.taskId); setResultTaskId(null); }
      setNotice(createTranslator(settings.systemLanguage)("analysisResultPending"));
    } finally { resultRetryingRef.current = false; setResultRetrying(false); }
  }, [setNotice, settings.systemLanguage]);

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
    cleanupFailedTask: tasks.find((task) => task.id === cleanupTaskId) ?? null,
    cleanupRetrying,
    cleanupUnconfirmed: activeExecutionRef.current?.recovery?.phase === "unknown",
    retryCleanup,
    resultPendingTask: tasks.find((task) => task.id === resultTaskId) ?? null,
    resultRetrying,
    retryResult,
    stopping,
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
    outputQuality: undefined,
    evidenceBundle: undefined,
    evidenceValidation: undefined,
    memoryBundle: undefined,
    memoryValidation: undefined,
    researchReadiness: undefined,
    readinessValidation: undefined,
    reportTextSnapshot: undefined,
    numericValidation: undefined,
    effectiveRequestIdentity: undefined,
    identityValidation: undefined,
    evaluationReviews: [],
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
    outputQuality: undefined,
    evidenceBundle: undefined,
    evidenceValidation: undefined,
    memoryBundle: undefined,
    memoryValidation: undefined,
    researchReadiness: undefined,
    readinessValidation: undefined,
    reportTextSnapshot: undefined,
    numericValidation: undefined,
    effectiveRequestIdentity: undefined,
    identityValidation: undefined,
    evaluationReviews: [],
    logs: [],
    error: "",
  };
}

function finalizeAgentStatuses(agentStatuses: Record<string, AgentStatus>) {
  return Object.fromEntries(
    Object.entries(agentStatuses).map(([agent, status]) => [agent, status === "in_progress" ? "error" : status]),
  ) as Record<string, AgentStatus>;
}
