import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCenterProvider, useTaskCenter } from "@/components/task-center/context";
import { defaultGlobalSettings } from "@/lib/analysis";
import * as runtime from "@/lib/runtime";
import { attachmentFixture } from "../test-support/attachment-fixture";
import { deferred } from "../test-support/transport-fixture";
import { recoveryMessages } from "./protocol";
import type { AttachReply } from "../attachment-types";

/** Actual Provider caller ordering, with fictional transport; no native/SQL/IPC proof. */
describe("global native controls through the actual Provider", () => {
  let fixture: Awaited<ReturnType<typeof attachmentFixture>>, root: Root, element: HTMLDivElement, center: ReturnType<typeof useTaskCenter>;
  let sqlUnavailable: boolean, recoveryLoads: number;
  const actions: Promise<void>[] = [];
  function Consumer() { center = useTaskCenter(); return createElement("p", null, center.notice); }
  const snapshot = () => {
    const current = fixture.current(); if (current.state !== "coherent") throw new Error("Owned SQL cut missing");
    return { settings: { ...defaultGlobalSettings(), systemLanguage: "en" as const }, tasks: [current.task!], storage: { ...current.storage, legacyTaskImportAllowed: false } };
  };
  beforeEach(async () => {
    fixture = await attachmentFixture(); sqlUnavailable = false; recoveryLoads = 0; actions.length = 0;
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    const invoke = (command: string, args: { requestJson: string }) => {
      if (command === "load_analysis_recovery") {
        recoveryLoads++;
        if (sqlUnavailable) throw new Error("Owned SQL observation unavailable");
        const current = fixture.current(), saved = snapshot();
        return Promise.resolve({ recoveryProtocolVersion: 1, storage: saved.storage, tasks: saved.tasks, journals: current.state === "coherent" && current.journal ? [current.journal] : [], clearBlockers: [], runtime: current.runtime, coherent: true });
      }
      return fixture.api.invoke(command, args);
    };
    vi.spyOn(runtime, "getRuntimeAdapter").mockReturnValue({ ...runtime.tauriRuntimeAdapter,
      getRuntimeInfo: async () => ({ kind: "tauri", label: "Owned Provider fixture" }),
      getAnalysisRecoveryApi: async () => ({ invoke, listen: (...args) => fixture.api.listen(...args) }),
      loadDesktopData: async () => snapshot(),
    });
    element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); element.remove(); await Promise.allSettled(actions);
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });
  async function mount() {
    await act(async () => root.render(createElement(TaskCenterProvider, null, createElement(Consumer))));
    await vi.waitFor(async () => { await act(async () => {}); expect(center.hydrated).toBe(true); });
  }
  const calls = (command: string) => fixture.calls.filter((call) => call.command === command);
  it("keeps a native pending result out of the waiting queue after reload even if its saved task says queued", async () => {
    fixture.canonical({ ...fixture.task(), status: "queued", queuedAt: "2026-01-01T00:00:00.000Z", queueOrder: 1 });
    const save = vi.spyOn(runtime.getRuntimeAdapter(), "saveDesktopTask");
    await mount(); const saved = center.getTask(fixture.header.origin.taskId)!;
    expect(center.runningTask).toBeNull(); expect(center.queuedTasks).toHaveLength(0);
    expect(center.getTaskDisplayStatus(saved)).toBe("result_pending");
    await act(async () => center.cancelQueuedTask(saved.id, saved));
    expect(save).not.toHaveBeenCalled(); expect(center.getTask(saved.id)?.status).toBe("queued");
    await act(async () => expect(await center.deleteTask(saved.id, saved)).toBe(false));
    expect(fixture.calls.some((call) => ["reserve_analysis", "start_analysis"].includes(call.command))).toBe(false);
    await act(async () => center.retryNativeResult());
    expect(center.nativeAnalysis).toBeNull(); expect(center.notice).toBe("");
    expect(center.getTask(saved.id)?.status).toBe("completed");
    expect(calls("attach_analysis_recovery")).toHaveLength(1);
    expect(fixture.calls.some((call) => ["reserve_analysis", "start_analysis"].includes(call.command))).toBe(false);
  });
  it("direct Stop shares a pending original attachment and still stops the exact witness after an unknown query", async () => {
    const original = fixture.api.invoke, ack = deferred<void>(), entered = deferred<void>(), admissions: string[] = [];
    fixture.api.invoke = async (command, args) => {
      if (command === "attach_analysis_recovery") { admissions.push(args.requestJson); entered.resolve(); await ack.promise; }
      return original(command, args);
    };
    await mount(); expect(center.nativeAnalysis?.taskId).toBe(fixture.header.origin.taskId);
    vi.useFakeTimers();
    let stopping!: Promise<void>;
    await act(async () => { stopping = center.stopNativeAnalysis(); actions.push(stopping); await entered.promise; });
    expect(calls("stop_analysis")).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); await stopping; });
    expect(admissions).toHaveLength(1); expect(calls("stop_analysis")).toHaveLength(1);
    expect(calls("query_analysis_attachment").every((call) => call.args.requestJson === admissions[0])).toBe(true);
    expect(JSON.parse(calls("stop_analysis")[0].args.requestJson).origin).toEqual(fixture.header.origin);
    expect(calls("commit_analysis_projection")).toHaveLength(0); expect(center.nativeAnalysis).not.toBeNull();
    await act(async () => { ack.resolve(); await center.watchNativeAnalysis(); });
    expect(center.nativeAnalysis).toBeNull(); expect(admissions).toHaveLength(1);
    expect(fixture.calls.some((call) => ["reserve_analysis", "start_analysis"].includes(call.command))).toBe(false);
  });
  it("direct Stop captures replacement B when a ready attachment for A remains in the same realm", async () => {
    await mount(); const previous = fixture;
    await act(async () => center.watchNativeAnalysis()); expect(center.nativeAnalysis).toBeNull();
    fixture = await attachmentFixture(); const current = fixture;
    await act(async () => center.retryTaskStorage()); expect(center.nativeAnalysis?.taskId).toBe(current.header.origin.taskId);
    await act(async () => center.stopNativeAnalysis());
    expect(previous.calls.filter((call) => call.command === "stop_analysis")).toHaveLength(0);
    expect(calls("stop_analysis")).toHaveLength(1);
    expect(JSON.parse(calls("stop_analysis")[0].args.requestJson).origin).toEqual(current.header.origin);
    expect(JSON.parse(calls("attach_analysis_recovery")[0].args.requestJson).origin).toEqual(current.header.origin);
    expect(calls("commit_analysis_projection")).toHaveLength(0); // No canonical B parent was bootstrapped.
  });
  it("refreshes the whole recovery snapshot after a retained attachment is ready and a global refresh fails", async () => {
    await mount();
    await act(async () => center.watchNativeAnalysis());
    expect(center.nativeAnalysis).toBeNull();
    const oldAttachmentQueries = calls("query_analysis_attachment").length;
    sqlUnavailable = true;
    await act(async () => center.retryTaskStorage());
    expect(center.nativeAnalysis?.taskId).toBeNull();
    const loadsAfterFailure = recoveryLoads;
    await act(async () => center.retryNativeResult());
    expect(recoveryLoads).toBe(loadsAfterFailure + 1);
    expect(center.nativeAnalysis).not.toBeNull();
    expect(center.notice).toContain("Refresh its state");
    expect(calls("query_analysis_attachment")).toHaveLength(oldAttachmentQueries);
    sqlUnavailable = false;
    await act(async () => center.retryNativeResult());
    expect(recoveryLoads).toBe(loadsAfterFailure + 2);
    expect(center.nativeAnalysis).toBeNull(); expect(center.notice).toBe("");
    expect(fixture.calls.some((call) => ["reserve_analysis", "start_analysis"].includes(call.command))).toBe(false);
    expect(calls("attach_analysis_recovery")).toHaveLength(1);
  });
  it("keeps dispatch paused but exposes exact Stop from a pure runtime witness when SQL bootstrap is unavailable", async () => {
    sqlUnavailable = true;
    const original = fixture.api.invoke;
    fixture.api.invoke = async (command, args) => {
      const value = await original(command, args);
      if (command !== "attach_analysis_recovery" && command !== "query_analysis_attachment") return value;
      const reply = value as AttachReply, owner = reply.current.runtime.owner!;
      return { ...reply, current: { state: "unavailable", error: { code: "analysis_storage_unavailable", message: recoveryMessages.analysis_storage_unavailable }, runtime: reply.current.runtime }, attachment: { kind: "volatile", witness: { origin: owner.origin, journalId: owner.journalId, binding: owner.binding, admissionRequestId: owner.admissionRequestId, admissionDigest: owner.admissionDigest, headerDigest: null, owner, reason: "storage_unavailable" }, control: { state: "unavailable", controlRevision: owner.controlRevision, error: { code: "analysis_storage_unavailable", message: recoveryMessages.analysis_storage_unavailable } } } };
    };
    await mount(); expect(center.nativeAnalysis?.taskId).toBe(fixture.header.origin.taskId);
    expect(center.storageState).toBe("unavailable");
    expect(calls("query_analysis_runtime")).toHaveLength(1);
    await act(async () => center.stopNativeAnalysis());
    expect(calls("stop_analysis")).toHaveLength(1); expect(calls("commit_analysis_projection")).toHaveLength(0);
    expect(center.nativeAnalysis).not.toBeNull();
    expect(fixture.calls.some((call) => ["reserve_analysis", "start_analysis"].includes(call.command))).toBe(false);
  });
});
