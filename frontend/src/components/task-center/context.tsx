"use client";

import { normalizeIdentityTasks, normalizeIdentityTaskFields, verifyIdentityTask, verifyIdentityTasks } from "@/features/source-identity/lib/tasks";
import { identityFromEvent } from "@/features/source-identity/lib/validation";
import { normalizeNumericTasks, normalizeNumericTaskFields, verifyNumericTask, verifyNumericTasks } from "@/features/numeric-review/lib/tasks";
import { reportSnapshotFromEvent } from "@/features/numeric-review/lib/snapshot";
import { appendNumericReviews } from "@/features/numeric-review/lib/history";
import { verifyNumericReview } from "@/features/numeric-review/lib/validation";
import type { NumericReview } from "@/features/numeric-review/types";

import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  createEmptyTask,
  defaultGlobalSettings,
  detectAssetType,
  normalizeAnalystsForAssetType,
  normalizeGlobalSettings,
  normalizeTicker,
  validateTaskDraft,
} from "@/lib/analysis";
import {
  clearGlobalSettings,
  clearLegacyDesktopData,
  clearTasks,
  loadGlobalSettings,
  loadLegacyDesktopData,
  loadTasks,
  saveGlobalSettings,
  saveVerifiedTasks,
  sessionSafeSettings,
} from "@/features/persistence/local-storage";
import {
  appendCompletedReportVersion,
  ensureLegacyReportVersion,
  FICTIONAL_DEMO_TASK_ID,
  getOrCreateFictionalDemoTask,
} from "@/features/report-export";
import { normalizeSettingsForSave } from "@/features/settings/lib/normalize-settings";
import { mergeEventOutputQuality, normalizeTaskOutputQuality } from "@/features/output-quality/lib/quality";
import { evidenceFromEvent, evidenceMatchesSnapshot, normalizeTaskEvidence, verifyTaskEvidence } from "@/features/evidence/lib/validation";
import { memoryFromEvent, normalizeMemoryTaskFields, verifyTaskMemory, verifyMemoryBundle, verifyReviewAttachment } from "@/features/memory/lib/validation";
import { normalizeMemoryTasks, verifyMemoryTasks } from "@/features/memory/lib/tasks";
import { normalizeReadinessTasks, normalizeReadinessTaskFields, readinessFromEvent, verifyReadinessTasks, verifyTaskReadiness } from "@/features/research-readiness/lib/validation";
import { appendEvaluationReviews } from "@/features/memory/lib/reviews";
import type { ReviewAttachment } from "@/features/memory/types";
import type { AgentStatus, AnalysisEvent, AnalysisTask, GlobalSettings, NewTaskDraft, RunContext, TaskStatus } from "@/lib/types";
import { defaultRuntimeInfo, getRuntimeAdapter, isTauriRuntime, type RuntimeAdapter, type RuntimeCheck, type RuntimeInfo } from "@/lib/runtime";
import { createTranslator } from "@/lib/i18n";
import { prependLog } from "./utils";
import { resolveTaskDecision } from "./decisions";
import { useTaskQueueController } from "./queue/useTaskQueueController";

type TaskCenterContextValue = {
  settings: GlobalSettings;
  tasks: AnalysisTask[];
  sortedTasks: AnalysisTask[];
  hydrated: boolean;
  runningTask: AnalysisTask | null;
  queuedTasks: AnalysisTask[];
  cleanupFailedTask: AnalysisTask | null;
  cleanupRetrying: boolean;
  stopping: boolean;
  retryCleanup: () => Promise<void>;
  activeTaskId: string;
  setActiveTaskId: (taskId: string) => void;
  notice: string;
  setNotice: (notice: string) => void;
  saveSettings: (settings: GlobalSettings) => Promise<GlobalSettings>;
  deleteProviderSecret: () => Promise<void>;
  deleteAlphaVantageSecret: () => Promise<void>;
  clearAllLocalData: () => Promise<boolean>;
  createTask: (draft: NewTaskDraft) => { task?: AnalysisTask; errors: string[] };
  createAndQueueTask: (draft: NewTaskDraft) => Promise<{ task?: AnalysisTask; errors: string[] }>;
  createDemoTask: () => AnalysisTask;
  deleteTask: (taskId: string) => void;
  queueTask: (taskId: string) => boolean;
  cancelQueuedTask: (taskId: string) => void;
  moveQueuedTask: (taskId: string, direction: "up" | "down") => void;
  getQueuePosition: (taskId: string) => number | null;
  stopRunningTask: () => void;
  getTask: (taskId: string) => AnalysisTask | undefined;
  runtimeInfo: RuntimeInfo;
  checkRuntime: (settingsOverride?: GlobalSettings) => Promise<RuntimeCheck>;
  saveNumericReviews: (taskId: string, versionId: string, reviews: NumericReview[]) => Promise<void>;
  saveEvaluationReviews: (taskId: string, versionId: string, reviews: ReviewAttachment[]) => Promise<void>;
};

const TaskCenterContext = createContext<TaskCenterContextValue | null>(null);

export function TaskCenterProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<GlobalSettings>(() => defaultGlobalSettings());
  const [tasks, setTasks] = useState<AnalysisTask[]>([]);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [notice, setNotice] = useState("");
  const [activeTaskId, setActiveTaskId] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const resolvingInstrumentNamesRef = useRef<Set<string>>(new Set());
  const runtimeAdapterRef = useRef<RuntimeAdapter | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());
  const eventQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo>(() => defaultRuntimeInfo());
  const t = createTranslator(settings.systemLanguage);

  useEffect(() => {
    const adapter = getRuntimeAdapter();
    runtimeAdapterRef.current = adapter;
    void adapter.getRuntimeInfo().then(setRuntimeInfo).catch(() => setRuntimeInfo(defaultRuntimeInfo()));

    if (!isTauriRuntime()) {
      try {
        setSettings(loadGlobalSettings());
        const loaded = loadTasks().map(normalizeTaskRuntimeState);
        void Promise.all(loaded.map(verifyTaskEvidence)).then(verifyMemoryTasks).then(verifyReadinessTasks).then(verifyNumericTasks).then(verifyIdentityTasks).then(setTasks).catch(() => setNotice("Saved research evidence and memory could not be verified.")).finally(() => setHydrated(true));
      } catch {
        setNotice("Local storage is unavailable. Reports have not been saved or loaded.");
        setHydrated(true);
      }
      return;
    }

    const legacy = loadLegacyDesktopData();
    void adapter.loadDesktopData(legacy)
      .then(async (snapshot) => {
        setSettings(normalizeGlobalSettings(snapshot.settings ?? {}));
        const normalizedTasks = await verifyIdentityTasks(await verifyNumericTasks(await verifyReadinessTasks(await verifyMemoryTasks(await Promise.all(snapshot.tasks.map(normalizeTaskRuntimeState).map(verifyTaskEvidence))))));
        setTasks(normalizedTasks);
        normalizedTasks.forEach((task, index) => {
          const stored = snapshot.tasks[index];
          if (
            task.decision !== stored?.decision
            || task.origin !== stored?.origin
            || task.reportVersions.length !== (stored?.reportVersions?.length ?? 0)
          ) {
            void adapter.saveDesktopTask(task).catch(() => setNotice("Failed to save report history. The displayed report may not be available after restart."));
          }
        });
        if (snapshot.secretMigrationError) {
          setNotice(snapshot.secretMigrationError);
        } else {
          clearLegacyDesktopData();
        }
      })
      .catch(() => {
        setSettings(sessionSafeSettings(legacy.settings ?? defaultGlobalSettings()));
        setTasks(normalizeIdentityTasks(normalizeNumericTasks(normalizeReadinessTasks(normalizeMemoryTasks((legacy.tasks ?? []).map(normalizeTaskRuntimeState))))));
        setNotice("Desktop storage could not be loaded. The displayed reports have not been confirmed saved.");
      })
      .finally(() => setHydrated(true));
  }, []);

  useEffect(() => {
    if (!hydrated || isTauriRuntime()) return;
    persistenceQueueRef.current = persistenceQueueRef.current.catch(() => undefined)
      .then(() => saveVerifiedTasks(tasks))
      .catch(() => setNotice("Failed to save reports and evidence. The displayed report may not be available after restart."));
  }, [hydrated, tasks]);

  useEffect(() => {
    if (!hydrated) return;
    if (isTauriRuntime()) return;
    const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
    tasks
      .filter((task) => task.origin !== "demo" && !task.instrumentName?.trim() && !resolvingInstrumentNamesRef.current.has(task.id))
      .slice(0, 5)
      .forEach((task) => {
        resolvingInstrumentNamesRef.current.add(task.id);
        void adapter.resolveInstrument(task.ticker, settings)
          .then((instrument) => {
            const name = instrument.displayName.trim();
            if (!name || name.toUpperCase() === task.ticker.toUpperCase()) return;
            updateTask(task.id, (current) => ({ ...current, instrumentName: name }));
          })
          .catch(() => undefined)
          .finally(() => {
            resolvingInstrumentNamesRef.current.delete(task.id);
          });
      });
  }, [hydrated, tasks, settings]);

  const sortedTasks = useMemo(
    () => [...tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    [tasks],
  );
  const persistTask = useCallback((task: AnalysisTask) => {
    if (!isTauriRuntime()) return;
    persistenceQueueRef.current = persistenceQueueRef.current.catch(() => undefined)
      .then(async () => {
        const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
        await adapter.saveDesktopTask(await verifyIdentityTask(await verifyNumericTask(await verifyTaskReadiness(await verifyTaskMemory(await verifyTaskEvidence(task))))));
      })
      .catch(() => setNotice("Failed to save report and evidence. The displayed report may not be available after restart."));
  }, []);

  const updateTask = useCallback((taskId: string, updater: (task: AnalysisTask) => AnalysisTask) => {
    setTasks((current) => {
      const next = normalizeIdentityTasks(normalizeNumericTasks(normalizeReadinessTasks(normalizeMemoryTasks(current.map((task) => task.id === taskId ? updater(task) : task)))));
      const changed = next.find((task) => task.id === taskId);
      if (changed) persistTask(changed);
      return next;
    });
  }, [persistTask]);

  function finalizeAgentStatuses(agentStatuses: Record<string, AgentStatus>) {
    return Object.fromEntries(
      Object.entries(agentStatuses).map(([agent, status]) => [agent, status === "in_progress" ? "error" : status]),
    ) as Record<string, AgentStatus>;
  }

  function normalizeTaskRuntimeState(task: AnalysisTask): AnalysisTask {
    const decision = resolveTaskDecision(task.decision, task.reportSections?.final_trade_decision);
    const normalizedTask = normalizeIdentityTaskFields(normalizeNumericTaskFields(normalizeReadinessTaskFields(normalizeMemoryTaskFields(normalizeTaskEvidence(normalizeTaskOutputQuality({
      ...task,
      origin: task.origin ?? "analysis",
      reportVersions: task.reportVersions ?? [],
      queuedAt: task.queuedAt ?? "",
      queueOrder: Number.isFinite(task.queueOrder) ? task.queueOrder : null,
      decision,
    }))))));
    if (normalizedTask.status === "running") {
      return ensureLegacyReportVersion({
        ...normalizedTask,
        status: "stopped",
        updatedAt: new Date().toISOString(),
        agentStatuses: finalizeAgentStatuses(normalizedTask.agentStatuses),
      });
    }
    if (normalizedTask.status === "error") {
      return ensureLegacyReportVersion({
        ...normalizedTask,
        agentStatuses: finalizeAgentStatuses(normalizedTask.agentStatuses),
      });
    }
    return ensureLegacyReportVersion(normalizedTask);
  }

  const handleTaskEvent = useCallback((taskId: string, event: AnalysisEvent, runContext?: RunContext) => {
    eventQueueRef.current = eventQueueRef.current.catch(() => undefined).then(async () => {
      const empty = { evidenceBundle: undefined, evidenceValidation: undefined, reportSections: {} } as AnalysisTask;
      const evidence = await evidenceFromEvent(empty, event);
      const memory = await memoryFromEvent(event, evidence.evidenceBundle);
      const readiness = await readinessFromEvent(event, evidence.evidenceBundle);
      const numeric = await reportSnapshotFromEvent(event, evidence.evidenceBundle);
      const identity = await identityFromEvent(event, evidence.evidenceBundle, numeric?.reportTextSnapshot);
      updateTask(taskId, (task) => {
        const logs = event.message || event.error
          ? prependLog(task.logs, event.messageType ?? event.type, event.error ?? event.message ?? "", event.timestamp, event.agent)
          : task.logs;
        const nextAgentStatuses = event.agentStatuses ?? task.agentStatuses;
        const reportSections = event.reportSections ?? task.reportSections;
        const status: TaskStatus = event.type === "completed"
          ? "completed"
          : event.type === "error"
            ? "error"
            : task.status;
        const nextTask: AnalysisTask = normalizeIdentityTaskFields(normalizeNumericTaskFields(normalizeReadinessTaskFields(normalizeMemoryTaskFields(evidenceMatchesSnapshot({
          ...task,
          status,
          updatedAt: new Date().toISOString(),
          decision: resolveTaskDecision(task.decision, reportSections.final_trade_decision, event),
          stats: event.stats ?? task.stats,
          agentStatuses: status === "error" ? finalizeAgentStatuses(nextAgentStatuses) : nextAgentStatuses,
          reportSections,
          outputQuality: mergeEventOutputQuality(task.outputQuality, event),
          ...((event.evidenceBundle !== undefined || event.finalState?.evidence_bundle !== undefined) ? evidence : {}),
          ...(memory ?? {}),
          ...(readiness ?? {}),
          ...(numeric ?? {}),
          ...(identity ?? {}),
          logs,
          error: event.error ?? (status === "running" ? "" : task.error),
        })))));
        return runContext
          ? appendCompletedReportVersion(nextTask, event, runContext)
          : nextTask;
      });
    }).catch(() => setNotice("A research update could not be processed. Report and evidence state may be incomplete."));
  }, [updateTask]);

  const {
    runningTask,
    queuedTasks,
    queueTask,
    cancelQueuedTask,
    moveQueuedTask,
    stopRunningTask,
    getQueuePosition,
    executionActive,
    cleanupFailedTask,
    cleanupRetrying,
    retryCleanup,
    stopping,
  } = useTaskQueueController({
    hydrated,
    tasks,
    setTasks,
    settings,
    runtimeAdapterRef,
    persistTask,
    onEvent: handleTaskEvent,
    setNotice,
  });

  async function saveSettingsAction(nextSettings: GlobalSettings) {
    const normalizedSettings = normalizeSettingsForSave(nextSettings);
    if (isTauriRuntime()) {
      const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
      const providerChanged =
        normalizedSettings.llmProvider !== settings.llmProvider.trim().toLowerCase();
      let providerConfigured = providerChanged ? false : normalizedSettings.providerConfigured;
      let alphaVantageConfigured = normalizedSettings.alphaVantageConfigured;
      if (normalizedSettings.apiKey) {
        await adapter.setProviderSecret(normalizedSettings.llmProvider, normalizedSettings.apiKey);
        providerConfigured = true;
      }
      if (normalizedSettings.alphaVantageApiKey) {
        await adapter.setAlphaVantageSecret(normalizedSettings.llmProvider, normalizedSettings.alphaVantageApiKey);
        alphaVantageConfigured = true;
      }
      const safeSettings = {
        ...normalizedSettings,
        providerConfigured,
        alphaVantageConfigured,
        apiKey: "",
        alphaVantageApiKey: "",
      };
      await adapter.saveDesktopSettings(safeSettings);
      setSettings(safeSettings);
      setSettingsSavedNotice(safeSettings.systemLanguage);
      return safeSettings;
    }
    const sessionSettings = {
      ...normalizedSettings,
      providerConfigured: Boolean(normalizedSettings.apiKey),
      alphaVantageConfigured: Boolean(normalizedSettings.alphaVantageApiKey),
    };
    saveGlobalSettings(sessionSettings);
    setSettings(sessionSettings);
    setSettingsSavedNotice(sessionSettings.systemLanguage);
    return sessionSettings;
  }

  function setSettingsSavedNotice(language: GlobalSettings["systemLanguage"]) {
    const translate = createTranslator(language);
    if (runningTask) {
      setNotice(translate("settingsSavedRunningTask", { ticker: runningTask.ticker }));
    } else if (queuedTasks.length > 0) {
      setNotice(translate("settingsSavedQueuedTasks"));
    } else {
      setNotice(translate("settingsSaved"));
    }
  }

  async function deleteProviderSecretAction() {
    if (isTauriRuntime()) {
      const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
      await adapter.deleteProviderSecret(settings.llmProvider);
      const safeSettings = { ...settings, providerConfigured: false, apiKey: "" };
      await adapter.saveDesktopSettings(safeSettings);
      setSettings(safeSettings);
      return;
    }
    setSettings((current) => ({ ...current, providerConfigured: false, apiKey: "" }));
  }

  async function deleteAlphaVantageSecretAction() {
    if (isTauriRuntime()) {
      const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
      await adapter.deleteAlphaVantageSecret(settings.llmProvider);
      const safeSettings = { ...settings, alphaVantageConfigured: false, alphaVantageApiKey: "" };
      await adapter.saveDesktopSettings(safeSettings);
      setSettings(safeSettings);
      return;
    }
    setSettings((current) => ({ ...current, alphaVantageConfigured: false, alphaVantageApiKey: "" }));
  }

  async function clearAllLocalData() {
    if (executionActive || runningTask || queuedTasks.length > 0) {
      setNotice(t("clearWhileQueueActive"));
      return false;
    }
    try {
      if (isTauriRuntime()) {
        const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
        await adapter.clearDesktopData();
      } else {
        clearGlobalSettings();
        clearTasks();
      }
      setSettings(defaultGlobalSettings());
      setTasks([]);
      setNotice(t("localDataCleared"));
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(t("localDataClearFailed", { detail }));
      return false;
    }
  }

  function createTaskAction(draft: NewTaskDraft) {
    const assetType = detectAssetType(draft.ticker, draft.assetType);
    const normalizedDraft: NewTaskDraft = {
      ...draft,
      assetType,
      researchDepth: draft.researchDepth,
      ticker: normalizeTicker(draft.ticker),
      instrumentName: draft.instrumentName,
      analysts: normalizeAnalystsForAssetType(draft.analysts, assetType),
    };
    const errors = validateTaskDraft(normalizedDraft, assetType, settings.systemLanguage);
    if (errors.length > 0) return { errors };
    const task = createEmptyTask(normalizedDraft);
    setTasks((current) => [task, ...current]);
    queueTask(task.id, task);
    setNotice(t("taskCreated", { ticker: task.ticker }));
    return { task, errors: [] };
  }

  async function createAndQueueTaskAction(draft: NewTaskDraft) {
    return createTaskAction(draft);
  }

  function createDemoTaskAction() {
    const demo = getOrCreateFictionalDemoTask(tasks, settings.systemLanguage);
    if (tasks.some((task) => task.id === FICTIONAL_DEMO_TASK_ID)) return demo;
    setTasks((current) => (
      current.some((task) => task.id === FICTIONAL_DEMO_TASK_ID)
        ? current
        : [demo, ...current]
    ));
    persistTask(demo);
    setNotice(t("demoTaskCreated"));
    return demo;
  }

  function deleteTask(taskId: string) {
    const task = tasks.find((item) => item.id === taskId);
    if (cleanupFailedTask?.id === taskId) {
      setNotice(t("analysisCleanupFailed"));
      return;
    }
    if (task?.status === "running" || runningTask?.id === taskId) {
      setNotice(t("cannotDeleteRunning"));
      return;
    }
    setTasks((current) => current.filter((item) => item.id !== taskId));
    if (isTauriRuntime()) void runtimeAdapterRef.current?.deleteDesktopTask(taskId).catch(() => undefined);
    setNotice(t("taskDeleted"));
  }

  async function checkRuntimeAction(settingsOverride?: GlobalSettings) {
    const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
    return adapter.checkRuntime(settingsOverride ?? settings);
  }

  async function saveNumericReviews(taskId: string, versionId: string, reviews: NumericReview[]) {
    const version = tasks.find((task) => task.id === taskId)?.reportVersions.find((item) => item.id === versionId);
    if (!version?.reportTextSnapshot || !version.evidenceBundle || version.numericValidation) throw new Error("This version has no verified original report snapshot.");
    const frozen = JSON.parse(JSON.stringify(version)) as typeof version;
    const verified = await Promise.all(reviews.map((review) => verifyNumericReview(review, frozen.reportTextSnapshot, frozen.evidenceBundle, { taskId, versionId })));
    const write = persistenceQueueRef.current.catch(() => undefined).then(async () => {
      const latest = tasksRef.current;
      const owner = latest.find((item) => item.id === taskId);
      if (!owner) throw new Error("The selected task no longer exists.");
      const next = appendNumericReviews(owner, versionId, verified);
      const candidate = normalizeNumericTasks(latest.map((item) => item.id === taskId ? next : item));
      if (candidate.find((item) => item.id === taskId)?.reportVersions.find((item) => item.id === versionId)?.numericValidation) throw new Error("Numeric reviews conflict with this saved report history.");
      if (isTauriRuntime()) {
        await (runtimeAdapterRef.current ?? getRuntimeAdapter()).saveDesktopTask(await verifyIdentityTask(await verifyNumericTask(next)));
      } else await saveVerifiedTasks(candidate);
      // Publish only after durable success. Re-append to the latest owner rather
      // than replacing unrelated updates made during the asynchronous write.
      await new Promise<void>((resolve, reject) => setTasks((current) => {
        try {
          const currentOwner = current.find((item) => item.id === taskId);
          if (!currentOwner) throw new Error();
          const saved = appendNumericReviews(currentOwner, versionId, verified);
          const result = normalizeNumericTasks(current.map((item) => item.id === taskId ? saved : item));
          if (result.find((item) => item.id === taskId)?.reportVersions.find((item) => item.id === versionId)?.numericValidation) throw new Error();
          queueMicrotask(resolve); return result;
        } catch { queueMicrotask(() => reject(new Error("Numeric review was saved, but its current owner could not be updated."))); return current; }
      }));
    });
    persistenceQueueRef.current = write;
    await write;
  }

  async function saveEvaluationReviews(taskId: string, versionId: string, reviews: ReviewAttachment[]) {
    const version = tasks.find((task) => task.id === taskId)?.reportVersions.find((item) => item.id === versionId);
    if (!version?.memoryBundle || version.memoryValidation) throw new Error("This saved version has no verified memory attachment.");
    const frozen = JSON.parse(JSON.stringify(version)) as typeof version;
    const capturedReviews = JSON.parse(JSON.stringify(reviews)) as ReviewAttachment[];
    const completion = await verifyMemoryBundle(frozen.memoryBundle, frozen.evidenceBundle);
    const verified = await Promise.all(capturedReviews.map((review) => verifyReviewAttachment(review, completion)));
    const write = persistenceQueueRef.current.catch(() => undefined).then(async () => {
      const latest = tasksRef.current;
      const owner = latest.find((item) => item.id === taskId);
      if (!owner) throw new Error("The selected task no longer exists.");
      const next = appendEvaluationReviews(owner, versionId, verified);
      const candidate = normalizeMemoryTasks(latest.map((item) => item.id === taskId ? next : item));
      if (candidate.find((item) => item.id === taskId)?.reportVersions.find((item) => item.id === versionId)?.memoryValidation) {
        throw new Error("Saved evaluation attachments conflict with this report history.");
      }
      if (isTauriRuntime()) {
        await (runtimeAdapterRef.current ?? getRuntimeAdapter()).saveDesktopTask(
          await verifyIdentityTask(await verifyNumericTask(await verifyTaskReadiness(await verifyTaskMemory(await verifyTaskEvidence(next))))),
        );
      } else await saveVerifiedTasks(candidate);
      // Keep the original input frozen and preserve unrelated updates made
      // during the write. Failed durable writes never publish a new review.
      await new Promise<void>((resolve, reject) => setTasks((current) => {
        try {
          const currentOwner = current.find((item) => item.id === taskId);
          if (!currentOwner) throw new Error();
          const saved = appendEvaluationReviews(currentOwner, versionId, verified);
          const result = normalizeMemoryTasks(current.map((item) => item.id === taskId ? saved : item));
          if (result.find((item) => item.id === taskId)?.reportVersions.find((item) => item.id === versionId)?.memoryValidation) throw new Error();
          queueMicrotask(resolve);
          return result;
        } catch {
          queueMicrotask(() => reject(new Error("Evaluation review was saved, but its current owner could not be updated.")));
          return current;
        }
      }));
    });
    persistenceQueueRef.current = write;
    await write;
  }

  const value: TaskCenterContextValue = {
    settings,
    tasks,
    sortedTasks,
    hydrated,
    runningTask,
    queuedTasks,
    cleanupFailedTask,
    cleanupRetrying,
    retryCleanup,
    stopping,
    activeTaskId,
    setActiveTaskId,
    notice,
    setNotice,
    saveSettings: saveSettingsAction,
    deleteProviderSecret: deleteProviderSecretAction,
    deleteAlphaVantageSecret: deleteAlphaVantageSecretAction,
    clearAllLocalData,
    createTask: createTaskAction,
    createAndQueueTask: createAndQueueTaskAction,
    createDemoTask: createDemoTaskAction,
    deleteTask,
    queueTask,
    cancelQueuedTask,
    moveQueuedTask,
    getQueuePosition,
    stopRunningTask,
    getTask: (taskId) => tasks.find((task) => task.id === taskId),
    runtimeInfo,
    checkRuntime: checkRuntimeAction,
    saveEvaluationReviews,
    saveNumericReviews,
  };

  return <TaskCenterContext.Provider value={value}>{children}</TaskCenterContext.Provider>;
}

export function useTaskCenter() {
  const context = useContext(TaskCenterContext);
  if (!context) throw new Error("useTaskCenter must be used inside TaskCenterProvider");
  return context;
}
