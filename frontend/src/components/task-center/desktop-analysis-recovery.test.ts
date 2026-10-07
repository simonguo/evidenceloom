import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCenterProvider, useTaskCenter } from "./context";
import { TaskQueuePanel } from "./queue/TaskQueuePanel";
import { defaultGlobalSettings } from "@/lib/analysis";
import * as runtimeAdapter from "@/lib/runtime";
import { task, runtime } from "@/features/analysis-recovery/test-support/fixtures";
import { deferred, transportFixture } from "@/features/analysis-recovery/test-support/transport-fixture";
import { recoveryMessages } from "@/features/analysis-recovery/lib/protocol";
import type { AdmissionRequest, RecoveryCurrent } from "@/features/analysis-recovery/types";
import type { AnalysisTask } from "@/lib/types";
import type { TaskHead, TaskMutationRequest } from "@/features/desktop-task-store/types";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: ipc.listen }));

describe("desktop analysis recovery through the actual Provider and queue", () => {
  let root: Root, element: HTMLDivElement, center: ReturnType<typeof useTaskCenter>;
  let rows: Map<string, AnalysisTask>, heads: Map<string, TaskHead>, active: ReturnType<typeof transportFixture> | undefined;
  let configure: ((fixture: ReturnType<typeof transportFixture>, id: string) => void) | undefined, rejectId: string | undefined, cleanupFailureId: string | undefined, loadFailure: boolean;
  let refreshFailure: boolean, recoveryLoads: number;
  let collection: { collectionId: string; epoch: string };
  const calls = (command: string) => ipc.invoke.mock.calls.filter(([name]) => name === command);
  function authority() { return { collection, heads: [...heads.values()] }; }
  function Panel() {
    center = useTaskCenter();
    return createElement(TaskQueuePanel, { runningTask: center.runningTask, queuedTasks: center.queuedTasks, cleanupFailedTask: center.cleanupFailedTask, cleanupRetrying: center.cleanupRetrying, cleanupUnconfirmed: center.cleanupUnconfirmed, resultPendingTask: center.resultPendingTask, resultRetrying: center.resultRetrying, stopping: center.stopping, language: "en", onStop: center.stopRunningTask, onRetryCleanup: () => { void center.retryCleanup(); }, onRetryResult: () => { void center.retryResult(); }, onCancel: center.cancelQueuedTask, onMove: center.moveQueuedTask });
  }
  async function mount() { await act(async () => root.render(createElement(TaskCenterProvider, null, createElement(Panel)))); await vi.waitFor(async () => { await act(async () => {}); expect(center.hydrated).toBe(true); }); }
  async function settled(predicate: () => void) { await vi.waitFor(async () => { await act(async () => {}); predicate(); }); }
  function sql(request: TaskMutationRequest) {
    if (!("expectedHead" in request)) throw new Error("Unsupported owned SQL fixture operation");
    const expected = request.expectedHead, current = heads.get(expected.taskId);
    if (!current || JSON.stringify(current) !== JSON.stringify(expected)) throw { code: "storage_conflict", message: "Owned stale head" };
    const next = { ...expected, revision: String(BigInt(expected.revision) + BigInt(1)) };
    if (request.operation === "update") rows.set(expected.taskId, structuredClone(request.task));
    heads.set(expected.taskId, next);
    return { scope: "sql", receipt: { protocolVersion: 1, requestId: request.requestId, digest: "f".repeat(64), operation: request.operation, collection, heads: [next], sqlCommitted: true }, rejection: null, current: authority() };
  }
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
    const initial = ["owned-A", "owned-B"].map((id, index) => ({ ...task(), id, status: "queued" as const, queueOrder: index + 1, queuedAt: "2026-01-01T00:00:00.000Z" }));
    collection = { collectionId: "a".repeat(64), epoch: "0" }; rows = new Map(initial.map((row) => [row.id, row])); heads = new Map(initial.map((row) => [row.id, { taskId: row.id, generation: "1", revision: "1", state: "live" }])); active = undefined; configure = undefined; rejectId = undefined; cleanupFailureId = undefined; loadFailure = false;
    refreshFailure = false; recoveryLoads = 0;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke: (command: string, args: Record<string, unknown>) => ipc.invoke(command, args) }, configurable: true });
    ipc.listen.mockReset().mockResolvedValue(vi.fn()); ipc.invoke.mockReset().mockImplementation(async (command, args) => {
      if (command === "load_desktop_data") return { settings: { ...defaultGlobalSettings(), systemLanguage: "en" }, tasks: [...rows.values()], storage: { ...authority(), legacyTaskImportAllowed: false } };
      if (command === "load_analysis_recovery") { recoveryLoads += 1; if (loadFailure || refreshFailure && recoveryLoads > 1) throw new Error("Owned native runtime unavailable"); return { recoveryProtocolVersion: 1, storage: { ...authority(), legacyTaskImportAllowed: false }, tasks: [...rows.values()], journals: [], clearBlockers: [], runtime: runtime(), coherent: true }; }
      if (command === "save_desktop_task") return sql(args.request);
      if (command === "query_desktop_task_mutation") return { scope: "sql", receipt: null, rejection: null, current: authority() };
      if (command === "reserve_analysis") {
        const request = JSON.parse(args.requestJson) as AdmissionRequest;
        if (request.expectedHead.taskId === rejectId) throw { code: "analysis_conflict", message: recoveryMessages.analysis_conflict };
        active = transportFixture({ cleanupFailure: request.expectedHead.taskId === cleanupFailureId, captured: { packet: { request, requestJson: args.requestJson }, task: structuredClone(rows.get(request.expectedHead.taskId)!), executionInputJson: "" } }); configure?.(active, request.expectedHead.taskId);
      }
      if (command === "query_analysis_reservation" && JSON.parse(args.requestJson).expectedHead.taskId === rejectId) return { recoveryProtocolVersion: 1, scope: "analysis_admission", receipt: null, rejection: { code: "analysis_conflict", message: recoveryMessages.analysis_conflict }, matchedReservation: null, current: { state: "coherent", storage: authority(), task: null, head: null, journal: null, runtime: runtime() } };
      if (!active) throw new Error(`Unexpected owned command ${command}`);
      const reply = await active.api.invoke(command, args), current = (reply as { current?: RecoveryCurrent }).current;
      if (current?.state === "coherent" && current.task && current.head) { rows.set(current.task.id, structuredClone(current.task)); heads.set(current.head.taskId, structuredClone(current.head)); }
      return reply;
    });
    vi.spyOn(runtimeAdapter, "getRuntimeAdapter").mockReturnValue({ ...runtimeAdapter.tauriRuntimeAdapter, getRuntimeInfo: async () => ({ kind: "tauri", label: "Owned fictional recovery transport" }) });
    element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  });
  afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it("saves two successive original-context runs through actual adapter/Provider while SQL normalizes running", async () => {
    await mount(); await settled(() => expect(center.tasks.every((row) => row.status === "completed")).toBe(true));
    expect(calls("start_analysis")).toHaveLength(2); expect(calls("commit_analysis_projection")).toHaveLength(4); expect(calls("save_desktop_task")).toHaveLength(0); expect(center.runningTask).toBeNull();
    expect(center.tasks.map((row) => row.reportVersions.length)).toEqual([1, 1]); expect(center.tasks.every((row) => row.reportVersions[0].runId.length > 0)).toBe(true);
  });
  it("keeps native bootstrap failure failclosed with visible retained queued tasks", async () => {
    loadFailure = true; await mount(); await act(async () => {}); expect(center.tasks).toHaveLength(2); expect(calls("reserve_analysis")).toHaveLength(0); expect(center.notice).toContain("Dispatch remains paused");
  });
  it("explains a blocked failed-task requeue and exposes refresh even when the last runtime observation is idle", async () => {
    const failed = { ...task(), id: "owned-A", status: "error" as const, error: "Error code: 400 - unsupported model gpt-5.4-mini" };
    rows = new Map([[failed.id, failed]]); heads.delete("owned-B"); refreshFailure = true;
    await mount(); expect(center.storageState).toBe("ready"); expect(center.runningTask).toBeNull();
    await act(async () => expect(center.queueTask(failed.id, center.getTask(failed.id))).toBe(false));
    expect(center.notice).toContain("Refresh its state"); expect(center.nativeAnalysis).not.toBeNull();
    expect(calls("reserve_analysis")).toHaveLength(0); expect(rows.get(failed.id)?.status).toBe("error");
    const refresh = [...element.querySelectorAll("button")].find((button) => button.textContent === "Refresh analysis state");
    expect(refresh).toBeDefined(); refreshFailure = false;
    await act(async () => refresh!.click());
    await settled(() => expect(center.nativeAnalysis).toBeNull()); expect(center.notice).toBe("");
    expect(calls("reserve_analysis")).toHaveLength(0);
    await act(async () => expect(center.queueTask(failed.id, center.getTask(failed.id))).toBe(true));
    await settled(() => expect(center.getTask(failed.id)?.status).toBe("completed"));
    expect(calls("start_analysis")).toHaveLength(1); expect(center.getTask(failed.id)?.error).toBe("");
  });
  it("the real stop button retains the owner until ACK and shares abort/control without false cleanup failure", async () => {
    const registration = deferred<() => void>(), listenerEntered = deferred<void>(), stopped = deferred<void>();
    ipc.listen.mockImplementation(() => { listenerEntered.resolve(); return registration.promise; });
    configure = (fixture, id) => { if (id === "owned-A") fixture.setStopBarrier(stopped.promise); };
    await mount(); await listenerEntered.promise;
    const button = element.querySelector<HTMLButtonElement>('button[aria-label="Stop task"]')!; expect(button).toBeDefined();
    await act(async () => button.click()); await settled(() => expect(calls("stop_analysis")).toHaveLength(1));
    expect(center.stopping).toBe(true); expect(center.runningTask?.id).toBe("owned-A"); expect(center.tasks.find((row) => row.id === "owned-B")?.status).toBe("queued"); expect(center.cleanupFailedTask).toBeNull();
    await act(async () => { stopped.resolve(); registration.resolve(vi.fn()); });
    await settled(() => expect(center.tasks.find((row) => row.id === "owned-B")?.status).toBe("completed"));
    expect(calls("stop_analysis")).toHaveLength(1); expect(calls("query_analysis_control")).toHaveLength(0); expect(calls("start_analysis")).toHaveLength(1); expect(center.tasks.find((row) => row.id === "owned-A")?.status).toBe("stopped"); expect(center.cleanupFailedTask).toBeNull();
  });
  it("keeps completed A visible and B paused until explicit cleanup retry and sealed result acknowledgement", async () => {
    cleanupFailureId = "owned-A"; await mount(); await settled(() => expect(center.cleanupFailedTask?.id).toBe("owned-A"));
    expect(center.tasks.find((row) => row.id === "owned-A")?.status).toBe("completed"); expect(center.tasks.find((row) => row.id === "owned-B")?.status).toBe("queued"); expect(calls("start_analysis")).toHaveLength(1);
    const retry = [...element.querySelectorAll("button")].find((button) => button.textContent === "Retry stopping"); expect(retry).toBeDefined();
    await act(async () => retry!.click()); await settled(() => expect(center.tasks.find((row) => row.id === "owned-B")?.status).toBe("completed"));
    expect(JSON.parse(calls("stop_analysis")[0][1].requestJson)).toMatchObject({ mode: "retry_cleanup", expectedControlRevision: "1" }); expect(calls("start_analysis")).toHaveLength(2); expect(center.cleanupFailedTask).toBeNull();
  });
  it("a known rejected A does not loop admission or permanently block confirmed B", async () => {
    rejectId = "owned-A"; await mount(); await settled(() => expect(center.tasks.find((row) => row.id === "owned-B")?.status).toBe("completed"));
    expect(calls("reserve_analysis").map(([, args]) => JSON.parse(args.requestJson).expectedHead.taskId)).toEqual(["owned-A", "owned-B"]); expect(calls("start_analysis")).toHaveLength(1); expect(center.runningTask).toBeNull(); expect(center.tasks.find((row) => row.id === "owned-A")?.status).toBe("queued");
  });
  it("retains result uncertainty with a real retry button and does not issue a second start", async () => {
    let originalPage: string | undefined, firstQuery = true;
    configure = (fixture, id) => { if (id !== "owned-A") return; fixture.setHook((command, request) => { if (command === "commit_analysis_projection" && request.throughSeq === "3") { originalPage = JSON.stringify(request); throw new Error("Owned lost commit ACK"); } if (command === "query_analysis_projection" && firstQuery) { firstQuery = false; throw new Error("Owned query read unavailable"); } }); };
    await mount(); await settled(() => expect(center.resultPendingTask?.id).toBe("owned-A")); expect(calls("start_analysis")).toHaveLength(1); expect(center.tasks.find((row) => row.id === "owned-B")?.status).toBe("queued");
    const retry = [...element.querySelectorAll("button")].find((button) => button.textContent === "Retry result confirmation"); expect(retry).toBeDefined();
    await act(async () => retry!.click()); await settled(() => expect(center.tasks.find((row) => row.id === "owned-B")?.status).toBe("completed"));
    expect(calls("query_analysis_projection").some(([, args]) => args.requestJson === originalPage)).toBe(true); expect(calls("start_analysis")).toHaveLength(2); expect(center.resultPendingTask).toBeNull();
  });
  it.each(["delete", "clear"])("refreshes canonical authority after a fully projected external %s retires the original journal", async (operation) => {
    let firstQuery = true;
    configure = (fixture, id) => { if (id === "owned-A") fixture.setHook((command, request) => { if (command === "commit_analysis_projection" && request.throughSeq === "3") throw new Error("Owned lost final ACK"); if (command === "query_analysis_projection" && firstQuery) { firstQuery = false; throw new Error("Owned unavailable final query"); } }); };
    await mount(); await settled(() => expect(center.resultPendingTask?.id).toBe("owned-A"));
    const original = active!, old = original.current(); if (old.state !== "coherent" || !old.journal) throw new Error();
    rows.delete("owned-A"); heads.set("owned-A", { taskId: "owned-A", generation: "1", revision: "4", state: "tombstone" });
    if (operation === "clear") { collection = { ...collection, epoch: "1" }; const next = { ...task(), id: "owned-B", status: "queued" as const, queueOrder: 1 }; rows = new Map([[next.id, next]]); heads = new Map([[next.id, { taskId: next.id, generation: "1", revision: "1", state: "live" }]]); }
    const invoke = original.api.invoke;
    original.api.invoke = async (command, args) => {
      const reply = await invoke(command, args);
      if (!reply || typeof reply !== "object" || !("current" in reply)) return reply;
      const current: RecoveryCurrent = { ...old, storage: authority(), task: null, head: operation === "clear" ? null : heads.get("owned-A")!, journal: { ...old.journal!, bodyState: "purged", resultState: "discarded", historyState: "discarded" }, runtime: original.current().runtime };
      return { ...reply, current };
    };
    await act(async () => { await center.retryResult(); }); await settled(() => expect(center.tasks.find((row) => row.id === "owned-B")?.status).toBe("completed"));
    expect(center.tasks.some((row) => row.id === "owned-A")).toBe(false); expect(rows.has("owned-A")).toBe(false); expect(center.resultPendingTask).toBeNull(); expect(calls("start_analysis")).toHaveLength(2);
    expect(calls("commit_analysis_projection").filter(([, args]) => JSON.parse(args.requestJson).origin.taskId === "owned-A")).toHaveLength(2);
  });
});
