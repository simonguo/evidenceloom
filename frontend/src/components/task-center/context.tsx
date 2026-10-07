"use client";

import { NativeAnalysisControls } from "@/features/analysis-recovery/components/NativeAnalysisControls";
import { AttachedRunConsumer, captureAttachment } from "@/features/analysis-recovery/lib/attachment";
import type { RecoveryPhase, RuntimeObservation } from "@/features/analysis-recovery/types";
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
import { defaultRuntimeInfo, getRuntimeAdapter, isTauriRuntime, type DesktopSnapshot, type RuntimeAdapter, type RuntimeCheck, type RuntimeInfo } from "@/lib/runtime";
import { createTranslator } from "@/lib/i18n";
import { prependLog } from "./utils";
import { resolveTaskDecision } from "./decisions";
import { useTaskQueueController } from "./queue/useTaskQueueController";
import { DesktopTaskMutations } from "@/features/desktop-task-store/lib/mutations";
import { detached } from "@/features/desktop-task-store/lib/protocol";
import type { RunOwner, TaskAction, TaskStoreState } from "@/features/desktop-task-store/types";
import { captureAdmission, loadRecovery, loadRuntimeObservation, SameSessionConsumer } from "@/features/analysis-recovery/lib/consumer";
import { finished, gateReady, sameOrigin } from "@/features/analysis-recovery/lib/protocol";

type TaskCenterContextValue = {
  settings: GlobalSettings;
  tasks: AnalysisTask[];
  sortedTasks: AnalysisTask[];
  hydrated: boolean;
  runningTask: AnalysisTask | null;
  queuedTasks: AnalysisTask[];
  cleanupFailedTask: AnalysisTask | null;
  cleanupRetrying: boolean;
  cleanupUnconfirmed: boolean;
  resultPendingTask: AnalysisTask | null;
  resultRetrying: boolean;
  retryResult: () => Promise<void>;
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
  createTask: (draft: NewTaskDraft) => Promise<{ task?: AnalysisTask; errors: string[] }>;
  createAndQueueTask: (draft: NewTaskDraft) => Promise<{ task?: AnalysisTask; errors: string[] }>;
  createDemoTask: () => Promise<AnalysisTask | undefined>;
  deleteTask: (taskId: string, selectedTask?: AnalysisTask) => Promise<boolean>;
  queueTask: (taskId: string, selectedTask?: AnalysisTask) => boolean;
  cancelQueuedTask: (taskId: string, selectedTask?: AnalysisTask) => void;
  moveQueuedTask: (taskId: string, direction: "up" | "down", selectedTask?: AnalysisTask) => void;
  getQueuePosition: (taskId: string) => number | null;
  stopRunningTask: () => void;
  getTask: (taskId: string) => AnalysisTask | undefined;
  getTaskIdentity: (task: AnalysisTask) => object | string | undefined;
  runtimeInfo: RuntimeInfo;
  checkRuntime: (settingsOverride?: GlobalSettings) => Promise<RuntimeCheck>;
  beginReview: (task: AnalysisTask, versionId: string) => unknown;
  saveNumericReviews: (taskId: string, versionId: string, reviews: NumericReview[], action?: unknown) => Promise<void>;
  saveEvaluationReviews: (taskId: string, versionId: string, reviews: ReviewAttachment[], action?: unknown) => Promise<void>;
  storageState: TaskStoreState;
  retryTaskStorage: () => Promise<void>;
  nativeAnalysis: { taskId: string | null; phase: RecoveryPhase; attached: boolean; canRetryCleanup: boolean } | null;
  watchNativeAnalysis: () => Promise<void>;
  stopNativeAnalysis: () => Promise<void>;
  retryNativeResult: () => Promise<void>;
  retryNativeCleanup: () => Promise<void>;
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
  const deletionInFlightRef = useRef<Map<object | string, Promise<boolean>>>(new Map());
  const mutationsRef = useRef<DesktopTaskMutations | null>(null);
  const unknownActionsRef = useRef<Set<TaskAction>>(new Set());
  const bootstrapRetryRef = useRef<(() => Promise<void>) | null>(null);
  const [storageState, setStorageState] = useState<TaskStoreState>("unavailable");
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo>(() => defaultRuntimeInfo());
  const recoveryRuntimeRef = useRef<RuntimeObservation | null>(null);
  const [nativeObservation, setNativeObservation] = useState<RuntimeObservation | null>(null);
  const [nativeBlocked, setNativeBlocked] = useState(false);
  const [attachmentPhase, setAttachmentPhase] = useState<RecoveryPhase>("checking");
  const [attached, setAttached] = useState(false);
  const attachedRef = useRef<AttachedRunConsumer | null>(null);
  const recoverySessionsRef = useRef<Set<SameSessionConsumer>>(new Set());
  const [recoveryReady, setRecoveryReady] = useState(false);
  const t = createTranslator(settings.systemLanguage);

  const refreshAnalysisRecovery = useCallback(async () => {
    const adapter = runtimeAdapterRef.current, mutations = mutationsRef.current;
    setRecoveryReady(false);
    if (!adapter?.getAnalysisRecoveryApi || !mutations) throw new Error("Native analysis authority is unavailable.");
    const snapshot = await loadRecovery(await adapter.getAnalysisRecoveryApi());
    if (mutationsRef.current !== mutations || !mutations.initialized) return;
    recoveryRuntimeRef.current = snapshot.runtime; setNativeObservation(snapshot.runtime);
    setNativeBlocked(snapshot.clearBlockers.length > 0 || snapshot.journals.some((journal) => journal.historyState !== "discarded" && !finished(journal)));
    const ready = gateReady(snapshot.runtime) && snapshot.clearBlockers.length === 0 && snapshot.journals.every((journal) => journal.historyState === "discarded" || finished(journal));
    const admitted = ready && (!attachedRef.current || attachedRef.current.phase === "ready");
    setRecoveryReady(admitted); return admitted;
  }, []);

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
    const mutations = new DesktopTaskMutations({
      execute: (request, beforeInvoke) => request.operation === "delete" ? adapter.deleteDesktopTask(request, beforeInvoke)
        : request.operation === "clear" ? adapter.clearDesktopData(request, beforeInvoke)
          : request.operation === "import" ? adapter.importLegacyDesktopTasks(request, beforeInvoke)
            : adapter.saveDesktopTask(request, beforeInvoke),
      query: (request) => adapter.queryDesktopTaskMutation(request),
    }, setStorageState);
    mutationsRef.current = mutations;
    let pendingBootstrap: { action: TaskAction; continuation: () => Promise<void> } | undefined;
    let bootstrapInFlight: Promise<void> | undefined, legacyImported = false, displaySnapshot: DesktopSnapshot | undefined, nativeCutUnavailable = false;
    async function observeRuntimeOnly() {
      if (!adapter.getAnalysisRecoveryApi) return;
      try {
        const runtime = await loadRuntimeObservation(await adapter.getAnalysisRecoveryApi());
        if (mutationsRef.current !== mutations) return;
        recoveryRuntimeRef.current = runtime; setNativeObservation(runtime);
      } catch { /* No runtime observation grants SQL authority or a dispatch permit. */ }
    }
    const live = () => mutationsRef.current === mutations && mutations.initialized;
    async function confirmBootstrap(action: TaskAction, continuation: () => Promise<void>) {
      const outcome = await mutations.commit(action);
      if (outcome.kind !== "committed" || !outcome.publishable) {
        if (outcome.kind === "unknown" || outcome.kind === "committed") pendingBootstrap = { action, continuation };
        throw new Error("Task bootstrap mutation could not be confirmed.");
      }
      if (!live()) return;
      await continuation();
    }
    async function hydrateSnapshot(snapshot: DesktopSnapshot) {
        setRecoveryReady(false);
        if (!adapter.getAnalysisRecoveryApi) throw new Error("Native analysis authority is unavailable.");
        let recovery;
        try { recovery = await loadRecovery(await adapter.getAnalysisRecoveryApi()); nativeCutUnavailable = false; }
        catch (cause) { nativeCutUnavailable = true; await observeRuntimeOnly(); throw cause; }
        if (mutationsRef.current !== mutations) return;
        recoveryRuntimeRef.current = recovery.runtime; setNativeObservation(recovery.runtime);
        setNativeBlocked(recovery.clearBlockers.length > 0 || recovery.journals.some((journal) => journal.historyState !== "discarded" && !finished(journal)));
        snapshot = { ...snapshot, storage: recovery.storage, tasks: [...recovery.tasks] };
        mutations.initialize(snapshot.storage, snapshot.tasks);
        if (snapshot.storage?.legacyTaskImportAllowed && legacy.tasks?.length) {
          const action = mutations.prepareImport(legacy.tasks);
          await confirmBootstrap(action, async () => { legacyImported = true; await hydrateSnapshot(await adapter.loadDesktopData()); });
          return;
        }
        const repairs = snapshot.tasks.map((stored) => mutations.capture(stored));
        setSettings(normalizeGlobalSettings(snapshot.settings ?? {}));
        const owner = recovery.runtime.owner;
        const canonicalOwner = (task: AnalysisTask) => owner?.origin.taskId === task.id;
        // Native canonical parent is never the display/legacy normalization of an active run.
        const ordinary = snapshot.tasks.filter((task) => !canonicalOwner(task));
        const verified = await verifyIdentityTasks(await verifyNumericTasks(await verifyReadinessTasks(await verifyMemoryTasks(await Promise.all(ordinary.map(normalizeTaskRuntimeState).map(verifyTaskEvidence))))));
        const normalizedTasks = snapshot.tasks.map((task) => canonicalOwner(task) ? task : verified[ordinary.indexOf(task)]);
        if (mutationsRef.current !== mutations || !mutations.initialized) return;
        normalizedTasks.forEach((task, index) => mutations.bind(task, repairs[index]));
        setTasks(normalizedTasks);
        tasksRef.current = normalizedTasks;
        async function repairFrom(start: number): Promise<void> {
          if (!live()) return;
          for (let index = start; index < normalizedTasks.length; index += 1) {
            const task = normalizedTasks[index], stored = snapshot.tasks[index];
            if (!canonicalOwner(task) && (task.decision !== stored?.decision || task.origin !== stored?.origin || task.reportVersions.length !== (stored?.reportVersions?.length ?? 0))) {
              const action = mutations.prepareUpdate(repairs[index], () => task);
              mutations.markProjected(task, action);
              await confirmBootstrap(action, () => repairFrom(index + 1));
              return;
            }
          }
          tasksRef.current = normalizedTasks; setTasks(normalizedTasks); mutations.seal();
          try { await refreshAnalysisRecovery(); } catch { setNotice("Native analysis state could not be confirmed. Dispatch remains paused."); }
          if (snapshot.secretMigrationError) setNotice(snapshot.secretMigrationError);
          else if (!legacy.tasks?.length || legacyImported || snapshot.storage?.legacyTaskImportAllowed) clearLegacyDesktopData();
        }
        await repairFrom(0);
    }
    function bootstrap() {
      if (bootstrapInFlight) return bootstrapInFlight;
      bootstrapInFlight = (async () => {
        if (pendingBootstrap) {
          const pending = pendingBootstrap, outcome = await mutations.retry(pending.action);
          if (outcome.kind === "unknown") throw new Error("Task bootstrap mutation remains unknown.");
          pendingBootstrap = undefined;
          if (outcome.kind === "committed" && outcome.publishable) { await pending.continuation(); return; }
          // A known historical outcome cannot authorize its stale projection.
          // Explicit retry reads canonical native bodies before any new intent.
        }
        nativeCutUnavailable = true;
        try { displaySnapshot = await adapter.loadDesktopData(legacy); }
        catch (cause) { await observeRuntimeOnly(); throw cause; }
        await hydrateSnapshot(displaySnapshot);
      })().catch(() => {
        if (mutationsRef.current !== mutations) return;
        setSettings(sessionSafeSettings(legacy.settings ?? defaultGlobalSettings()));
        setTasks(normalizeIdentityTasks(normalizeNumericTasks(normalizeReadinessTasks(normalizeMemoryTasks((displaySnapshot?.tasks ?? legacy.tasks ?? []).map(normalizeTaskRuntimeState))))));
        setNotice("Desktop storage and native analysis state could not be confirmed. The displayed reports have not been confirmed saved. Dispatch remains paused.");
        setNativeBlocked(nativeCutUnavailable || !recoveryRuntimeRef.current || !gateReady(recoveryRuntimeRef.current)); setRecoveryReady(false);
      }).finally(() => { bootstrapInFlight = undefined; if (mutationsRef.current === mutations) setHydrated(true); });
      return bootstrapInFlight;
    }
    bootstrapRetryRef.current = bootstrap;
    void bootstrap();
    return () => { attachedRef.current?.dispose(); attachedRef.current = null; recoverySessionsRef.current.forEach((session) => session.dispose()); recoverySessionsRef.current.clear(); mutations.dispose(); if (mutationsRef.current === mutations) mutationsRef.current = null; };
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
  const confirmTaskAction = useCallback(async (action: TaskAction) => {
    const mutations = mutationsRef.current;
    if (!mutations) throw new Error("Desktop task storage is unavailable.");
    const outcome = await mutations.confirm(action);
    unknownActionsRef.current.forEach((pending) => { if (!mutations.needsConfirmation(pending)) unknownActionsRef.current.delete(pending); });
    if (outcome.kind !== "committed" || !mutations.publishable(action, outcome)) {
      if (mutations.needsConfirmation(action)) unknownActionsRef.current.add(action);
      throw new Error("Task storage could not be confirmed. Retry confirmation before continuing.");
    }
    unknownActionsRef.current.delete(action);
    return outcome;
  }, []);

  const mutateDesktopTask = useCallback((task: AnalysisTask, updater: (task: AnalysisTask) => AnalysisTask | Promise<AnalysisTask>, runOwner?: RunOwner) => {
    const mutations = mutationsRef.current;
    if (!mutations) return undefined;
    try {
      const transform = async (original: AnalysisTask) => verifyIdentityTask(await verifyNumericTask(await verifyTaskReadiness(await verifyTaskMemory(await verifyTaskEvidence(await updater(original))))));
      const action = runOwner ? mutations.prepareRunUpdate(runOwner, transform) : mutations.prepareUpdate(mutations.capture(task), transform);
      void confirmTaskAction(action).then(() => mutations.projection(action)).then((projection) => {
        if (!mutations.markProjected(projection, action)) return;
        tasksRef.current = tasksRef.current.map((item) => item.id === task.id ? projection : item);
        setTasks(tasksRef.current);
      }).catch(() => { if (mutations.relevant(action)) setNotice(createTranslator(settings.systemLanguage)("taskStorageUnconfirmed")); });
      return action;
    } catch { setNotice(createTranslator(settings.systemLanguage)("taskStorageChanged")); return undefined; }
  }, [confirmTaskAction, settings.systemLanguage]);

  const persistTask = useCallback(() => {}, []);

  const updateTask = useCallback((taskId: string, updater: (task: AnalysisTask) => AnalysisTask) => {
    const task = tasksRef.current.find((item) => item.id === taskId);
    if (isTauriRuntime()) { if (task) mutateDesktopTask(task, updater); return; }
    setTasks((current) => normalizeIdentityTasks(normalizeNumericTasks(normalizeReadinessTasks(normalizeMemoryTasks(current.map((item) => item.id === taskId ? updater(item) : item))))));
  }, [mutateDesktopTask]);

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

  const handleTaskEvent = useCallback((taskId: string, input: AnalysisEvent, runContext?: RunContext, runOwner?: RunOwner) => {
    const event = detached(input), context = runContext ? detached(runContext) : undefined;
    const transform = async (task: AnalysisTask) => {
      const empty = { evidenceBundle: undefined, evidenceValidation: undefined, reportSections: {} } as AnalysisTask;
      const evidence = await evidenceFromEvent(empty, event);
      const memory = await memoryFromEvent(event, evidence.evidenceBundle);
      const readiness = await readinessFromEvent(event, evidence.evidenceBundle);
      const numeric = await reportSnapshotFromEvent(event, evidence.evidenceBundle);
      const identity = await identityFromEvent(event, evidence.evidenceBundle, numeric?.reportTextSnapshot);
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
        return context
          ? appendCompletedReportVersion(nextTask, event, context)
          : nextTask;
    };
    if (isTauriRuntime()) {
      if (!runOwner) return;
      const task = tasksRef.current.find((item) => item.id === taskId);
      if (task) mutateDesktopTask(task, transform, runOwner);
      return;
    }
    eventQueueRef.current = eventQueueRef.current.catch(() => undefined).then(async () => {
      const task = tasksRef.current.find((item) => item.id === taskId);
      if (!task) return;
      const next = await transform(task);
      updateTask(taskId, () => next);
    }).catch(() => setNotice("A research update could not be processed. Report and evidence state may be incomplete."));
  }, [mutateDesktopTask, updateTask]);

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
    cleanupUnconfirmed,
    retryCleanup,
    resultPendingTask,
    resultRetrying,
    retryResult,
    stopping,
  } = useTaskQueueController({
    hydrated,
    tasks,
    setTasks,
    settings,
    runtimeAdapterRef,
    persistTask,
    storageReady: !isTauriRuntime() || recoveryReady && (storageState === "ready" || storageState === "pending"),
    blockedQueueNotice: t(storageState === "ready" || storageState === "pending" ? "analysisRecoveryBlocked" : "taskStorageUnconfirmed"),
    mutateDesktopTask,
    beginDesktopRun: async (task) => {
      const mutations = mutationsRef.current;
      if (!mutations) return undefined;
      const action = mutations.capture(task);
      if (!await mutations.awaitAdmission(action)) return undefined;
      return mutations.captureRun(action);
    },
    confirmDesktopAction: confirmTaskAction,
    retireDesktopRun: (owner) => mutationsRef.current?.retireRun(owner),
    prepareDesktopRun: (task, form, runContext) => {
      const mutations = mutationsRef.current, adapter = runtimeAdapterRef.current, runtime = recoveryRuntimeRef.current;
      if (!mutations || !adapter?.getAnalysisRecoveryApi || !runtime?.runtimeEpoch || !gateReady(runtime)) throw new Error("Native analysis authority is unavailable.");
      const action = mutations.capture(task), parent = mutations.recoveryParent(action);
      const captured = captureAdmission(task, form, runContext, parent.collection, parent.head, runtime.runtimeEpoch);
      let retiring = false;
      const session = new SameSessionConsumer(captured, adapter.getAnalysisRecoveryApi, {
        relevant: () => mutationsRef.current === mutations && (retiring || mutations.recoveryRelevant(action)),
        publish: (current) => {
          if (current.state !== "coherent" || !current.task || !current.head || mutationsRef.current !== mutations) return false;
          const canonical = detached(current.task);
          if (!mutations.adoptRecovery(action, current.storage, canonical, current.head)) return false;
          tasksRef.current = tasksRef.current.map((item) => item.id === canonical.id && mutations.identity(item) === parent.birth ? canonical : item);
          setTasks(tasksRef.current); return true;
        },
        retire: async (current) => {
          if (current.state !== "coherent" || mutationsRef.current !== mutations || !mutations.retireRecovery(action, current.storage)) return false;
          retiring = true; setRecoveryReady(false);
          await bootstrapRetryRef.current?.();
          if (mutationsRef.current !== mutations || !mutations.ready) return false;
          return await refreshAnalysisRecovery() === true;
        },
        changed: (phase, observed) => {
          if (mutationsRef.current !== mutations || !retiring && !mutations.recoveryRelevant(action)) return;
          if (observed) { recoveryRuntimeRef.current = observed; setNativeObservation(observed); }
          setRecoveryReady(phase === "ready" && !!observed && gateReady(observed));
        },
      });
      recoverySessionsRef.current.add(session); setRecoveryReady(false); return session;
    },
    onEvent: handleTaskEvent,
    setNotice,
  });

  function prepareNativeAttachment(): AttachedRunConsumer | undefined {
    const mutations = mutationsRef.current, adapter = runtimeAdapterRef.current, observed = nativeObservation;
    const owner = observed?.owner, latest = recoveryRuntimeRef.current?.owner;
    if (owner && (!latest || !sameOrigin(owner.origin, latest.origin) || owner.journalId !== latest.journalId || owner.admissionDigest !== latest.admissionDigest)) { setNotice(t("analysisRecoveryBlocked")); return; }
    if (!mutations || !adapter?.getAnalysisRecoveryApi || !observed?.runtimeEpoch || !owner) { setNotice(t("analysisRecoveryBlocked")); return; }
    // Capture this exact native observation before transport/import/verification awaits.
    const packet = captureAttachment({ runtimeEpoch: observed.runtimeEpoch, expectedObservationRevision: observed.observationRevision,
      origin: owner.origin, journalId: owner.journalId, binding: owner.binding, admissionRequestId: owner.admissionRequestId,
      admissionDigest: owner.admissionDigest, expectedHeaderDigest: null });
    const existing = attachedRef.current;
    if (existing && existing.phase !== "ready" && !existing.knownRejected && sameOrigin(existing.origin, owner.origin) && existing.captured.request.journalId === owner.journalId) return existing;
    const original = tasksRef.current.find((task) => task.id === owner.binding.taskId);
    let action: TaskAction | undefined;
    try { action = original ? mutations.capture(original) : undefined; } catch { /* Unknown local writes cannot supply a projection parent; exact Stop remains available. */ }
    const birth = original ? mutations.identity(original) : undefined;
    let session: AttachedRunConsumer;
    session = new AttachedRunConsumer(packet, adapter.getAnalysisRecoveryApi, {
      relevant: () => mutationsRef.current === mutations && attachedRef.current === session,
      publish: (current) => {
        if (attachedRef.current !== session || mutationsRef.current !== mutations || !action || current.state !== "coherent" || !current.task || !current.head) return false;
        const canonical = detached(current.task);
        if (!mutations.adoptRecovery(action, current.storage, canonical, current.head)) return false;
        tasksRef.current = tasksRef.current.map((task) => task.id === canonical.id && mutations.identity(task) === birth ? canonical : task);
        setTasks(tasksRef.current); return true;
      },
      changed: (phase, runtime) => {
        if (attachedRef.current !== session || mutationsRef.current !== mutations) return;
        if (runtime) { recoveryRuntimeRef.current = runtime; setNativeObservation(runtime); }
        setAttachmentPhase(phase); setRecoveryReady(phase === "ready" && !!runtime && gateReady(runtime));
        if (phase === "ready") { setNativeBlocked(false); setAttached(false); }
      },
    });
    attachedRef.current?.dispose(); attachedRef.current = session; setAttached(true); setAttachmentPhase("checking"); setRecoveryReady(false);
    return session;
  }
  async function watchNativeAnalysis() {
    const session = prepareNativeAttachment(); if (!session) return;
    try { await session.run(); } catch { if (attachedRef.current === session) setNotice(t("analysisResultPending")); }
  }
  async function retryNativeResult() {
    const session = attachedRef.current;
    if (session && nativeObservation?.owner && (!sameOrigin(session.origin, nativeObservation.owner.origin) || session.captured.request.journalId !== nativeObservation.owner.journalId)) return;
    if (!session) {
      try {
        if (!mutationsRef.current?.ready) await bootstrapRetryRef.current?.();
        setNotice(await refreshAnalysisRecovery() === true ? "" : t("analysisRecoveryBlocked"));
      } catch { setRecoveryReady(false); setNotice(t("analysisRecoveryBlocked")); }
      return;
    }
    try { await session.retryResult(); } catch { if (attachedRef.current === session) setNotice(t("analysisResultPending")); }
  }
  async function stopNativeAnalysis() {
    // Capture the displayed exact owner synchronously, including when an old ready/rejected
    // attachment remains in this realm. Never select another owner after an await.
    const session = prepareNativeAttachment(); if (!session) return;
    try { await session.stop(); } catch { if (attachedRef.current === session) setNotice(t("analysisCleanupUnconfirmed")); return; }
    try { await session.retryResult(); } catch { if (attachedRef.current === session) setNotice(t("analysisResultPending")); }
  }
  async function retryNativeCleanup() {
    const session = attachedRef.current; if (!session || !nativeObservation?.owner || !sameOrigin(session.origin, nativeObservation.owner.origin) || session.captured.request.journalId !== nativeObservation.owner.journalId) return;
    try { await session.stop(true); } catch { if (attachedRef.current === session) setNotice(t("analysisCleanupUnconfirmed")); return; }
    try { await session.retryResult(); } catch { if (attachedRef.current === session) setNotice(t("analysisResultPending")); }
  }
  const localExecution = [...recoverySessionsRef.current].some((session) => !session.isDisposed && session.phase !== "ready" && !!session.origin && !!nativeObservation?.owner && sameOrigin(session.origin, nativeObservation.owner.origin));
  const nativeAnalysis = isTauriRuntime() && !localExecution && (!recoveryReady || nativeObservation?.owner || nativeBlocked || nativeObservation && !gateReady(nativeObservation))
    ? { taskId: nativeObservation?.owner?.origin.taskId ?? null, phase: attached ? attachmentPhase : "checking" as RecoveryPhase, attached: attached && !attachedRef.current?.knownRejected,
      canRetryCleanup: (attachedRef.current?.attachment?.control.state === "known" && attachedRef.current.attachment.control.receipt.outcome === "cleanup_incomplete") === true }
    : null;

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
        const mutations = mutationsRef.current;
        if (!mutations) throw new Error("Desktop task storage is unavailable.");
        const action = mutations.prepareClear();
        const outcome = await confirmTaskAction(action);
        if (!mutations.publishable(action, outcome)) throw new Error("Local-data deletion is not confirmed for the current session.");
      } else {
        clearGlobalSettings();
        clearTasks();
      }
      setSettings(defaultGlobalSettings());
      tasksRef.current = [];
      setTasks([]);
      setNotice(t("localDataCleared"));
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setNotice(t("localDataClearFailed", { detail }));
      return false;
    }
  }

  async function createTaskAction(draft: NewTaskDraft) {
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
    if (isTauriRuntime()) {
      try {
        const mutations = mutationsRef.current;
        if (!mutations) throw new Error();
        const action = mutations.prepareCreate(task);
        tasksRef.current = [task, ...tasksRef.current]; setTasks(tasksRef.current);
        const outcome = await confirmTaskAction(action);
        if (!mutations.publishable(action, outcome)) throw new Error();
      } catch { setNotice(t("taskCreationUnconfirmed")); return { errors: [t("taskCreationUnconfirmed")] }; }
    } else { tasksRef.current = [task, ...tasksRef.current]; setTasks(tasksRef.current); }
    queueTask(task.id, task);
    setNotice(t("taskCreated", { ticker: task.ticker }));
    return { task, errors: [] };
  }

  async function createAndQueueTaskAction(draft: NewTaskDraft) {
    return createTaskAction(draft);
  }

  async function createDemoTaskAction() {
    const demo = getOrCreateFictionalDemoTask(tasksRef.current, settings.systemLanguage);
    const existing = tasksRef.current.find((task) => task.id === FICTIONAL_DEMO_TASK_ID);
    if (existing) {
      if (!isTauriRuntime()) return demo;
      try {
        const mutations = mutationsRef.current;
        if (!mutations || !await mutations.awaitAdmission(mutations.capture(existing)) || !mutations.identity(existing)) throw new Error();
        return existing;
      } catch { setNotice(t("demoCreationUnconfirmed")); return undefined; }
    }
    if (isTauriRuntime()) {
      try {
        const mutations = mutationsRef.current;
        if (!mutations) throw new Error();
        const action = mutations.prepareCreate(demo);
        tasksRef.current = [demo, ...tasksRef.current]; setTasks(tasksRef.current);
        const outcome = await confirmTaskAction(action);
        if (!mutations.publishable(action, outcome)) throw new Error();
      } catch { setNotice(t("demoCreationUnconfirmed")); return undefined; }
    } else { tasksRef.current = [demo, ...tasksRef.current]; setTasks(tasksRef.current); }
    setNotice(t("demoTaskCreated"));
    return demo;
  }

  function deleteTask(taskId: string, selectedTask?: AnalysisTask): Promise<boolean> {
    const task = selectedTask ?? tasksRef.current.find((item) => item.id === taskId);
    const deletionKey = isTauriRuntime() ? task && mutationsRef.current?.identity(task) : taskId;
    if (isTauriRuntime() && !deletionKey) { setNotice(t("taskDeleteFailed")); return Promise.resolve(false); }
    const pending = deletionInFlightRef.current.get(deletionKey!);
    if (pending) return pending;
    if (cleanupFailedTask?.id === taskId) {
      setNotice(t("analysisCleanupFailed"));
      return Promise.resolve(false);
    }
    if (task?.status === "running" || runningTask?.id === taskId) {
      setNotice(t("cannotDeleteRunning"));
      return Promise.resolve(false);
    }
    if (!isTauriRuntime()) {
      setTasks((current) => current.filter((item) => item.id !== taskId));
      setNotice(t("taskDeleted"));
      return Promise.resolve(true);
    }
    let action: TaskAction;
    try {
      if (!task || task.id !== taskId || !mutationsRef.current) throw new Error();
      action = mutationsRef.current.prepareDelete(task);
    } catch { setNotice(t("taskDeleteFailed")); return Promise.resolve(false); }
    const deletion = Promise.resolve().then(async () => {
      try {
        const outcome = await confirmTaskAction(action);
        if (!mutationsRef.current?.publishable(action, outcome)) return false;
        tasksRef.current = tasksRef.current.filter((item) => item.id !== taskId);
        setTasks(tasksRef.current);
        setNotice(t("taskDeleted"));
        return true;
      } catch {
        setNotice(t("taskDeleteFailed"));
        return false;
      }
    }).finally(() => {
      if (deletionInFlightRef.current.get(deletionKey!) === deletion) deletionInFlightRef.current.delete(deletionKey!);
    });
    deletionInFlightRef.current.set(deletionKey!, deletion);
    return deletion;
  }

  async function checkRuntimeAction(settingsOverride?: GlobalSettings) {
    const adapter = runtimeAdapterRef.current ?? getRuntimeAdapter();
    return adapter.checkRuntime(settingsOverride ?? settings);
  }

  function beginReview(task: AnalysisTask, versionId: string) {
    if (!isTauriRuntime()) return undefined;
    if (!mutationsRef.current) throw new Error("Desktop task storage is unavailable.");
    return mutationsRef.current.captureReview(task, versionId);
  }

  async function saveNumericReviews(taskId: string, versionId: string, reviews: NumericReview[], capturedAction?: unknown) {
    const mutations = isTauriRuntime() ? mutationsRef.current : null;
    const action = capturedAction as TaskAction;
    const version = isTauriRuntime() ? mutations?.reviewVersion(capturedAction) : tasks.find((task) => task.id === taskId)?.reportVersions.find((item) => item.id === versionId);
    if (isTauriRuntime() && (!mutations || !action || version?.id !== versionId)) throw new Error("This review's task storage identity is no longer available.");
    if (!version?.reportTextSnapshot || !version.evidenceBundle || version.numericValidation) throw new Error("This version has no verified original report snapshot.");
    const frozen = JSON.parse(JSON.stringify(version)) as typeof version;
    const capturedReviews = detached(reviews);
    if (mutations) {
      const update = mutations.prepareUpdate(action, async (original) => {
        if (original.id !== taskId) throw new Error("Review task mismatch.");
        const verified = await Promise.all(capturedReviews.map((review) => verifyNumericReview(review, frozen.reportTextSnapshot, frozen.evidenceBundle, { taskId, versionId })));
        const next = appendNumericReviews(original, versionId, verified);
        const validated = await verifyIdentityTask(await verifyNumericTask(next));
        if (validated.reportVersions.find((item) => item.id === versionId)?.numericValidation) throw new Error("Numeric reviews conflict with this saved report history.");
        return validated;
      });
      await confirmTaskAction(update);
      const projection = await mutations.projection(update);
      if (!mutations.markProjected(projection, update)) throw new Error("This task changed while the review was saved.");
      tasksRef.current = tasksRef.current.map((task) => task.id === taskId ? projection : task); setTasks(tasksRef.current); return;
    }
    const verified = await Promise.all(capturedReviews.map((review) => verifyNumericReview(review, frozen.reportTextSnapshot, frozen.evidenceBundle, { taskId, versionId })));
    const write = persistenceQueueRef.current.catch(() => undefined).then(async () => {
      const latest = tasksRef.current;
      const owner = latest.find((item) => item.id === taskId);
      if (!owner) throw new Error("The selected task no longer exists.");
      const next = appendNumericReviews(owner, versionId, verified);
      const candidate = normalizeNumericTasks(latest.map((item) => item.id === taskId ? next : item));
      if (candidate.find((item) => item.id === taskId)?.reportVersions.find((item) => item.id === versionId)?.numericValidation) throw new Error("Numeric reviews conflict with this saved report history.");
      await saveVerifiedTasks(candidate);
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

  async function saveEvaluationReviews(taskId: string, versionId: string, reviews: ReviewAttachment[], capturedAction?: unknown) {
    const mutations = isTauriRuntime() ? mutationsRef.current : null;
    const action = capturedAction as TaskAction;
    const version = isTauriRuntime() ? mutations?.reviewVersion(capturedAction) : tasks.find((task) => task.id === taskId)?.reportVersions.find((item) => item.id === versionId);
    if (isTauriRuntime() && (!mutations || !action || version?.id !== versionId)) throw new Error("This review's task storage identity is no longer available.");
    if (!version?.memoryBundle || version.memoryValidation) throw new Error("This saved version has no verified memory attachment.");
    const frozen = JSON.parse(JSON.stringify(version)) as typeof version;
    const capturedReviews = JSON.parse(JSON.stringify(reviews)) as ReviewAttachment[];
    if (mutations) {
      const update = mutations.prepareUpdate(action, async (original) => {
        if (original.id !== taskId) throw new Error("Review task mismatch.");
        const completion = await verifyMemoryBundle(frozen.memoryBundle, frozen.evidenceBundle);
        const verified = await Promise.all(capturedReviews.map((review) => verifyReviewAttachment(review, completion)));
        const next = appendEvaluationReviews(original, versionId, verified);
        const validated = await verifyIdentityTask(await verifyNumericTask(await verifyTaskReadiness(await verifyTaskMemory(await verifyTaskEvidence(next)))));
        if (validated.reportVersions.find((item) => item.id === versionId)?.memoryValidation) throw new Error("Saved evaluation attachments conflict with this report history.");
        return validated;
      });
      await confirmTaskAction(update);
      const projection = await mutations.projection(update);
      if (!mutations.markProjected(projection, update)) throw new Error("This task changed while the review was saved.");
      tasksRef.current = tasksRef.current.map((task) => task.id === taskId ? projection : task); setTasks(tasksRef.current); return;
    }
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
      await saveVerifiedTasks(candidate);
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
    cleanupUnconfirmed,
    resultPendingTask,
    resultRetrying,
    retryResult,
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
    getTaskIdentity: (task) => isTauriRuntime() ? mutationsRef.current?.identity(task) : task.id,
    runtimeInfo,
    checkRuntime: checkRuntimeAction,
    saveEvaluationReviews,
    saveNumericReviews,
    beginReview,
    storageState,
    nativeAnalysis, watchNativeAnalysis, stopNativeAnalysis, retryNativeResult, retryNativeCleanup,
    retryTaskStorage: async () => {
      if (isTauriRuntime()) { try { await refreshAnalysisRecovery(); } catch { setRecoveryReady(false); } }
      if (!unknownActionsRef.current.size && storageState !== "ready" && storageState !== "pending") { await bootstrapRetryRef.current?.(); return; }
      for (const action of [...unknownActionsRef.current]) {
        try {
          const outcome = await confirmTaskAction(action);
          const mutations = mutationsRef.current!;
          if (!mutations.publishable(action, outcome)) throw new Error();
          const intent = mutations.intent(action);
          if (intent.operation === "delete") { tasksRef.current = tasksRef.current.filter((task) => task.id !== intent.taskId); setTasks(tasksRef.current); }
          else if (intent.operation !== "clear" && intent.operation !== "import") {
            const projection = await mutations.projection(action);
            if (mutations.markProjected(projection, action)) { tasksRef.current = tasksRef.current.map((task) => task.id === intent.taskId ? projection : task); setTasks(tasksRef.current); }
          }
        } catch { if (mutationsRef.current?.relevant(action)) setNotice(t(mutationsRef.current.intent(action).operation === "clear" ? "localDataClearUnconfirmed" : "taskStorageUnconfirmed")); }
      }
    },
  };

  return <TaskCenterContext.Provider value={value}>{children}{hydrated && nativeAnalysis && <NativeAnalysisControls view={nativeAnalysis} label={tasks.find((task) => task.id === nativeAnalysis.taskId)?.ticker} language={settings.systemLanguage} onWatch={() => void watchNativeAnalysis()} onStop={() => void stopNativeAnalysis()} onResult={() => void retryNativeResult()} onCleanup={() => void retryNativeCleanup()} />}{hydrated && isTauriRuntime() && (storageState === "unavailable" || storageState === "unknown" || storageState === "conflict") && <div role="alert" className="fixed bottom-5 right-5 z-50 max-w-sm rounded-lg border border-amber-800 bg-zinc-950 p-4 text-sm text-amber-100"><p>{t("taskStorageUnconfirmed")}</p><button type="button" className="mt-3 rounded border border-amber-700 px-3 py-1" onClick={() => void value.retryTaskStorage()}>{t("taskStorageRetry")}</button></div>}</TaskCenterContext.Provider>;
}

export function useTaskCenter() {
  const context = useContext(TaskCenterContext);
  if (!context) throw new Error("useTaskCenter must be used inside TaskCenterProvider");
  return context;
}
