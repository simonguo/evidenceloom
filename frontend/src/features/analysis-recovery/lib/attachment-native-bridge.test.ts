import { webcrypto } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { useTaskCenter } from "@/components/task-center/context";
import { buildRunForm, defaultGlobalSettings } from "@/lib/analysis";
import { createRunContext, ensureLegacyReportVersion } from "@/features/report-export/lib/versioning";
import type { AnalysisTask } from "@/lib/types";
import type { DesktopSnapshot } from "@/lib/runtime";
import type { SnapshotStorage } from "@/features/desktop-task-store/types";
import { nativeCommandBridge } from "../test-support/native-command-bridge";
import { finished, gateReady, readCurrent, readRuntime, sameOrigin } from "./protocol";
import { deferred } from "../test-support/transport-fixture";
import type { NativeOwner } from "../types";
import { captureAdmission, loadRuntimeObservation, SameSessionConsumer, type ConsumerBridge } from "./consumer";
import { AttachedRunConsumer, captureAttachment } from "./attachment";

const executable = process.env.EVIDENCELOOM_RECOVERY_BRIDGE_EXE;

it.skipIf(!executable)("confirms a cancelled unstarted native reservation with legacy history, then reruns the same task", async () => {
  const bridge = await nativeCommandBridge(executable!, undefined, process.env.EVIDENCELOOM_RECOVERY_RUSTC_DIRECTORY);
  vi.stubGlobal("crypto", webcrypto);
  try {
    const loadSnapshot = async () => await bridge.invoke("load_desktop_data") as DesktopSnapshot & { storage: SnapshotStorage };
    let snapshot = await loadSnapshot();
    const saved = ensureLegacyReportVersion({ ...snapshot.tasks[0], status: "completed", reportSections: { market_report: "Fictional historical report" } });
    Reflect.deleteProperty(saved.reportVersions[0], "evaluationReviews"); Reflect.deleteProperty(saved.reportVersions[0], "numericReviews");
    const retained = JSON.parse(JSON.stringify(saved.reportVersions));
    await bridge.invoke("save_desktop_task", { request: { protocolVersion: 1, requestId: crypto.randomUUID(), collection: snapshot.storage.collection, operation: "update", expectedHead: snapshot.storage.heads[0], task: { ...saved, status: "queued" } } });
    snapshot = await loadSnapshot();
    const form = buildRunForm(snapshot.tasks[0], defaultGlobalSettings());
    const admission = captureAdmission(snapshot.tasks[0], form, createRunContext(form), snapshot.storage.collection, snapshot.storage.heads[0], (await loadRuntimeObservation(bridge.api)).runtimeEpoch!);
    await bridge.api.invoke("reserve_analysis", { requestJson: admission.packet.requestJson });
    const owner = (await loadRuntimeObservation(bridge.api)).owner!;
    // Reproduce the old queue-cancellation write before confirming the unstarted run.
    await bridge.invoke("save_desktop_task", { request: { protocolVersion: 1, requestId: crypto.randomUUID(), collection: snapshot.storage.collection, operation: "update", expectedHead: snapshot.storage.heads[0], task: { ...snapshot.tasks[0], status: "idle", queuedAt: "", queueOrder: null } } });
    await bridge.api.invoke("stop_analysis", { requestJson: JSON.stringify({ recoveryProtocolVersion: 1, requestId: crypto.randomUUID(), origin: owner.origin, journalId: owner.journalId, mode: "stop", expectedControlRevision: null }) });
    const observed = await loadRuntimeObservation(bridge.api);
    const attachment = captureAttachment({ runtimeEpoch: observed.runtimeEpoch!, expectedObservationRevision: observed.observationRevision, origin: owner.origin, journalId: owner.journalId, binding: owner.binding, admissionRequestId: owner.admissionRequestId, admissionDigest: owner.admissionDigest, expectedHeaderDigest: null });
    let canonical: AnalysisTask | undefined;
    const publish: ConsumerBridge["publish"] = (current) => { if (current.state === "coherent" && current.task) canonical = current.task; return true; };
    const session = new AttachedRunConsumer(attachment, async () => bridge.api, { relevant: () => true, publish, changed: () => undefined });
    await session.run();
    expect(session.phase).toBe("ready"); expect(canonical!.status).toBe("stopped"); expect(canonical!.reportVersions).toEqual(retained);
    expect(gateReady(await loadRuntimeObservation(bridge.api))).toBe(true);
    expect(bridge.requests.some((line) => JSON.parse(line).command === "start_analysis")).toBe(false);
    snapshot = await loadSnapshot();
    const retryForm = buildRunForm(snapshot.tasks[0], defaultGlobalSettings());
    const retryAdmission = captureAdmission(snapshot.tasks[0], retryForm, createRunContext(retryForm), snapshot.storage.collection, snapshot.storage.heads[0], observed.runtimeEpoch!);
    const rerun = new SameSessionConsumer(retryAdmission, async () => bridge.api, { relevant: () => true, publish, changed: () => undefined });
    await rerun.run();
    expect(rerun.phase).toBe("ready"); expect(canonical!.status).toBe("completed"); expect(canonical!.reportVersions[0]).toEqual(retained[0]); expect(canonical!.reportVersions[1].versionNumber).toBe(2);
    expect(bridge.requests.filter((line) => JSON.parse(line).command === "start_analysis")).toHaveLength(1);
  } finally { vi.unstubAllGlobals(); expect(await bridge.close()).toBe(0); }
}, 30000);

it.skipIf(!executable).each(["same-realm-stop", "fresh-realm-stop", "completion-listener-gap"])("actual Provider %s attaches the original native worker and admits B only after both gates", async (scenario) => {
  const artifactRoot = process.env.EVIDENCELOOM_RECOVERY_BRIDGE_ARTIFACTS, artifacts = artifactRoot ? join(artifactRoot, scenario) : undefined;
  if (artifacts) await mkdir(artifacts);
  const bridge = await nativeCommandBridge(executable!, artifacts, process.env.EVIDENCELOOM_RECOVERY_RUSTC_DIRECTORY);
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  let root: Root | undefined, element: HTMLDivElement | undefined, restore: (() => void) | undefined;
  let center: ReturnType<typeof useTaskCenter> | undefined;
  const pending: Promise<void>[] = [];
  const listenerStarted = deferred<void>(), listenerAck = deferred<void>();
  let holdRegistration = false, dropWakes = false;
  const actualListen = bridge.api.listen;
  bridge.api.listen = async (channel, handler) => {
    const off = await actualListen(channel, (event) => { if (!dropWakes) handler(event); });
    if (holdRegistration) { listenerStarted.resolve(); await listenerAck.promise; }
    return off;
  };
  async function mount(reset: boolean) {
    if (reset) vi.resetModules();
    const context = await import("@/components/task-center/context"), runtime = await import("@/lib/runtime");
    const adapter = { ...runtime.tauriRuntimeAdapter, getRuntimeInfo: async () => ({ kind: "tauri" as const, label: "Actual native attachment fixture" }), getAnalysisRecoveryApi: async () => bridge.api,
      loadDesktopData: async () => ({ ...await bridge.invoke("load_desktop_data") as Awaited<ReturnType<typeof runtime.tauriRuntimeAdapter.loadDesktopData>>, settings: { ...defaultGlobalSettings(), systemLanguage: "en" as const } }),
      saveDesktopTask: async (request: Parameters<typeof runtime.tauriRuntimeAdapter.saveDesktopTask>[0], guard?: () => void) => { guard?.(); return bridge.invoke("save_desktop_task", { request }); },
      queryDesktopTaskMutation: async (request: Parameters<typeof runtime.tauriRuntimeAdapter.queryDesktopTaskMutation>[0]) => bridge.invoke("query_desktop_task_mutation", { request }),
    };
    const spy = vi.spyOn(runtime, "getRuntimeAdapter").mockReturnValue(adapter); restore = () => spy.mockRestore();
    element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
    function Consumer() { center = context.useTaskCenter(); return createElement("p", null, center.notice); }
    await act(async () => root!.render(createElement(context.TaskCenterProvider, null, createElement(Consumer))));
    await condition(() => center?.hydrated === true && center.tasks.length === 2);
  }
  async function unmount() { if (root) await act(async () => root!.unmount()); root = undefined; element?.remove(); element = undefined; restore?.(); restore = undefined; center = undefined; }
  async function condition(predicate: () => boolean, milliseconds = 20000) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline && !predicate()) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(predicate()).toBe(true);
  }
  const requests = () => bridge.requests.map((line) => JSON.parse(line) as { id: string; command: string; args: { requestJson?: string; executionInputJson?: string; request?: { expectedHead?: { taskId: string } } } });
  try {
    await bridge.invoke("fixture_queue_tasks"); await bridge.invoke("fixture_mode", { mode: scenario === "completion-listener-gap" ? "controlled_safe" : "waiting" });
    await mount(false); await condition(() => requests().filter((r) => r.command === "start_analysis").length === 1);
    const protocol = JSON.stringify({ recoveryProtocolVersion: 1 });
    const initialTaskIds = center!.tasks.map((task) => task.id);
    let original!: NativeOwner;
    async function releaseWorker() {
      const deadline = Date.now() + 10000; let started = false;
      while (!started && Date.now() < deadline) { try { const reply = await bridge.invoke("fixture_release_worker", { origin: original.origin, journalId: original.journalId }); expect(reply).toMatchObject({ released: true, workerStarted: true }); started = true; } catch (cause) { if ((cause as { code?: string }).code !== "analysis_busy") throw cause; await new Promise((resolve) => setTimeout(resolve, 20)); } }
      expect(started).toBe(true);
    }
    await act(async () => {
      const observed = readRuntime(await bridge.invoke("query_analysis_runtime", { requestJson: protocol }));
      expect(observed.owner).not.toBeNull(); original = observed.owner!;
      if (scenario !== "completion-listener-gap") await releaseWorker();
    });
    const nextTaskId = initialTaskIds.find((id) => id !== original.origin.taskId)!;
    await unmount(); // Disposes frontend listeners only, never a native Stop.
    const afterDisposal = requests().length;
    await bridge.invoke("fixture_mode", { mode: "safe" });
    if (scenario === "completion-listener-gap") { dropWakes = true; holdRegistration = true; }
    await mount(scenario !== "same-realm-stop");
    expect(center!.nativeAnalysis?.taskId).toBe(original.origin.taskId);
    expect(center!.tasks.find((task) => task.id === original.origin.taskId)?.reportVersions).toHaveLength(0);
    let watching: Promise<void> | undefined;
    if (scenario !== "fresh-realm-stop") await act(async () => {
      watching = center!.watchNativeAnalysis(); pending.push(watching);
      if (scenario === "completion-listener-gap") await listenerStarted.promise;
    });
    if (scenario === "completion-listener-gap") {
      await act(async () => {
        await releaseWorker();
        // Completion is actual worker output committed by native helpers while listener ACK is withheld.
        const deadline = Date.now() + 10000; let sealed = false;
        while (!sealed && Date.now() < deadline) {
          try {
            const cut = await bridge.invoke("load_analysis_recovery", { requestJson: protocol }) as { journals: { journalId: string; sealedThroughSeq: string | null }[] };
            sealed = cut.journals.some((journal) => journal.journalId === original.journalId && journal.sealedThroughSeq !== null);
          } catch (cause) {
            // The native snapshot can reject a cut while the original worker changes its revision.
            if (typeof cause !== "object" || cause === null || !("code" in cause) || cause.code !== "analysis_observation_changed") throw cause;
          }
          if (!sealed) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(sealed).toBe(true);
        listenerAck.resolve(); holdRegistration = false; dropWakes = false;
        await watching;
      });
    } else {
      if (scenario === "same-realm-stop") await condition(() => center?.nativeAnalysis?.attached === true);
      await act(async () => { const stopping = center!.stopNativeAnalysis(); pending.push(stopping); await stopping; });
    }
    await condition(() => center!.tasks.find((task) => task.id === nextTaskId)?.status === "completed" && center!.nativeAnalysis === null && center!.runningTask === null);
    await act(async () => { await Promise.all(pending); });
    const commands = requests(), reservations = commands.filter((r) => r.command === "reserve_analysis"), starts = commands.filter((r) => r.command === "start_analysis");
    expect(reservations).toHaveLength(2); expect(starts).toHaveLength(2);
    expect(JSON.parse(reservations[1].args.requestJson!).expectedHead.taskId).toBe(nextTaskId);
    expect(JSON.parse(starts[1].args.requestJson!).origin.taskId).toBe(nextTaskId);
    const attachments = commands.filter((r) => r.command === "attach_analysis_recovery"); expect(attachments).toHaveLength(1);
    const packet = JSON.parse(attachments[0].args.requestJson!);
    expect(packet.origin).toEqual(original.origin); expect(packet.journalId).toBe(original.journalId); expect(packet.binding).toEqual(original.binding);
    expect(commands.slice(afterDisposal, commands.indexOf(reservations[1])).filter((r) => ["reserve_analysis", "start_analysis"].includes(r.command) || r.command === "save_desktop_task" && r.args.request?.expectedHead?.taskId === original.origin.taskId)).toHaveLength(0);
    expect(commands.filter((r) => r.command === "query_analysis_attachment").every((r) => r.args.requestJson === attachments[0].args.requestJson)).toBe(true);
    const beforeB = commands.slice(afterDisposal, commands.indexOf(reservations[1]));
    expect(beforeB.some((request) => {
      const reply = bridge.replies.find((r) => r.id === request.id)?.ok as { current?: unknown } | undefined;
      if (!reply?.current) return false; const current = readCurrent(reply.current);
      return current.state === "coherent" && !!current.journal && sameOrigin(current.journal.origin, original.origin) && finished(current.journal) && gateReady(current.runtime);
    })).toBe(true);
    const first = center!.tasks.find((task) => task.id === original.origin.taskId)!;
    expect(first.reportVersions).toHaveLength(scenario === "completion-listener-gap" ? 1 : 0);
    expect(center!.tasks.find((task) => task.id === nextTaskId)!.reportVersions).toHaveLength(1);
  } finally {
    listenerAck.resolve(); await unmount(); await Promise.allSettled(pending);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); expect(await bridge.close()).toBe(0);
  }
}, 40000);
