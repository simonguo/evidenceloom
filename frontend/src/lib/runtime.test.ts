import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAnalysisForm } from "./analysis";
import { isAnalysisCleanupError } from "./desktop-analysis";
import { tauriRuntimeAdapter } from "./runtime";
import { SameSessionConsumer } from "@/features/analysis-recovery/lib/consumer";
import { deferred, transportFixture } from "@/features/analysis-recovery/test-support/transport-fixture";
import { RecoveryPendingError } from "@/features/analysis-recovery/lib/transport";
import type { RecoveryApi } from "@/features/analysis-recovery/types";
import corpus from "../../../tests/fixtures/desktop_task_store_wire_v1.json";
import { validateRequest } from "@/features/desktop-task-store/lib/protocol";

const tauri = vi.hoisted(() => ({ invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(), listen: vi.fn<(channel: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
function fixture(options: Parameters<typeof transportFixture>[0] = {}) {
  const f = transportFixture(options);
  tauri.invoke.mockImplementation((command, args) => f.api.invoke(command, args as Parameters<RecoveryApi["invoke"]>[1]));
  tauri.listen.mockImplementation((channel, handler) => f.api.listen(channel, handler));
  const session = new SameSessionConsumer(f.captured, () => tauriRuntimeAdapter.getAnalysisRecoveryApi!(), { relevant: () => true, publish: () => true, changed: () => undefined });
  return { ...f, session, run: (signal?: AbortSignal, retry = false) => tauriRuntimeAdapter.runPreparedAnalysis!(session, f.captured.task.id, signal, retry) };
}
function calls(command: string) { return tauri.invoke.mock.calls.filter(([name]) => name === command); }

describe("Tauri journal-owned analysis transport", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke: (command: string, args?: Record<string, unknown>) => tauri.invoke(command, args) }, configurable: true }); tauri.invoke.mockReset(); tauri.listen.mockReset(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
  it("fails closed for tokenless callers without inventing native authority", async () => {
    await expect(tauriRuntimeAdapter.runAnalysis("unconfirmed-task", defaultAnalysisForm(), vi.fn())).rejects.toBeInstanceOf(RecoveryPendingError); expect(tauri.invoke).not.toHaveBeenCalled(); expect(tauri.listen).not.toHaveBeenCalled();
  });
  it("uses exact original packets, acknowledged channel and durable cursor rather than a V1 save", async () => {
    const f = fixture(); await f.run();
    expect(tauri.listen).toHaveBeenCalledExactlyOnceWith(`analysis-journal:${f.header.origin.runtimeEpoch}:${f.header.origin.runId}`, expect.any(Function));
    expect(JSON.parse(calls("reserve_analysis")[0][1]!.requestJson as string)).toEqual(f.captured.packet.request);
    expect(calls("start_analysis")).toHaveLength(1); expect(calls("commit_analysis_projection")).toHaveLength(2); expect(calls("save_desktop_task")).toHaveLength(0); expect(f.session.phase).toBe("ready");
    expect(JSON.parse(calls("start_analysis")[0][1]!.executionInputJson as string)).not.toHaveProperty("apiKey");
  });
  it("cancels a pre-aborted admitted reservation without spawning and projects its sealed outcome", async () => {
    const f = fixture(), signal = new AbortController(); signal.abort(); await f.run(signal.signal);
    expect(calls("start_analysis")).toHaveLength(0); expect(calls("stop_analysis")).toHaveLength(1); expect(f.task().status).toBe("stopped"); expect(f.session.phase).toBe("ready");
  });
  it("does not start when cancellation overtakes pending listener acknowledgement", async () => {
    const f = fixture(), registration = deferred<() => void>(), entered = deferred<void>(), signal = new AbortController();
    tauri.listen.mockImplementation(() => { entered.resolve(); return registration.promise; });
    const run = f.run(signal.signal); await entered.promise; signal.abort(); const stop = tauriRuntimeAdapter.stopAnalysis(f.captured.task.id); registration.resolve(vi.fn()); await Promise.all([run, stop]);
    expect(calls("start_analysis")).toHaveLength(0); expect(calls("stop_analysis")).toHaveLength(1); expect(f.session.phase).toBe("ready");
  });
  it("retains listener refusal as a result retry and never waits for a nonexistent worker", async () => {
    const f = fixture({ listenerFailure: true }); await expect(f.run()).rejects.toBeInstanceOf(RecoveryPendingError);
    expect(calls("start_analysis")).toHaveLength(0); await f.run(undefined, true); expect(f.session.phase).toBe("ready"); expect(f.task().status).toBe("stopped");
  });
  it("queries a lost start acknowledgement with only the original safe packet", async () => {
    const f = fixture(); let lost = false; f.setHook((command) => { if (command === "start_analysis" && !lost) { lost = true; throw new Error("owned lost acknowledgement"); } }); await f.run();
    expect(calls("query_analysis_start")[0][1]).toEqual({ requestJson: calls("start_analysis")[0][1]!.requestJson }); expect(calls("start_analysis")).toHaveLength(1);
  });
  it("keeps cleanup failure retained until a new explicit control attempt and final cursor acknowledgement", async () => {
    const f = fixture({ cleanupFailure: true }); await expect(f.run()).rejects.toSatisfy(isAnalysisCleanupError); expect(f.session.phase).toBe("cleanup_failed");
    await tauriRuntimeAdapter.stopAnalysis(f.captured.task.id); await f.run(undefined, true);
    expect(JSON.parse(calls("stop_analysis")[0][1]!.requestJson as string)).toMatchObject({ mode: "retry_cleanup", expectedControlRevision: "1", origin: f.header.origin }); expect(f.session.phase).toBe("ready");
  });
  it("shares the original pending stop while abort and adapter stop run concurrently", async () => {
    const f = fixture(), registration = deferred<() => void>(), entered = deferred<void>(), barrier = deferred<void>(), signal = new AbortController(); f.setStopBarrier(barrier.promise);
    tauri.listen.mockImplementation(() => { entered.resolve(); return registration.promise; }); const run = f.run(signal.signal); await entered.promise; signal.abort(); const stop = tauriRuntimeAdapter.stopAnalysis(f.captured.task.id);
    barrier.resolve(); registration.resolve(vi.fn()); await Promise.all([run, stop]); expect(calls("stop_analysis")).toHaveLength(1); expect(calls("query_analysis_control")).toHaveLength(0);
  });
  it("never classifies a generic string or unrelated machine error as confirmed cleanup failure", () => {
    expect(isAnalysisCleanupError("Analysis cleanup incomplete")).toBe(false); expect(isAnalysisCleanupError({ code: "analysis_worker_failed", message: "Analysis cleanup incomplete" })).toBe(false); expect(isAnalysisCleanupError(new RecoveryPendingError("cleanup"))).toBe(true);
  });
  it("rejects a task-ID mismatch before storing or invoking the session", async () => {
    const f = fixture(); await expect(tauriRuntimeAdapter.runPreparedAnalysis!(f.session, "different-task")).rejects.toThrow(); expect(tauri.invoke).not.toHaveBeenCalled();
  });
  it("disposes the acknowledged listener only after both native gates confirm", async () => {
    const f = fixture(), unlisten = vi.fn(); tauri.listen.mockResolvedValue(unlisten); await f.run(); expect(unlisten).toHaveBeenCalledTimes(1); await expect(tauriRuntimeAdapter.stopAnalysis(f.captured.task.id)).rejects.toBeInstanceOf(RecoveryPendingError);
  });
});

// Wire transport tests use actual adapter methods and native serialized fixture
// packets; invoke/listen are fictional and no native application is launched.
describe("Tauri immutable task mutation transport", () => {
  beforeEach(() => { Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true }); tauri.invoke.mockReset().mockResolvedValue(undefined); });
  afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
  it.each([
    ["saveDesktopTask", "save_desktop_task", "create_sql"],
    ["deleteDesktopTask", "delete_desktop_task", "delete_never_seen_sql"],
    ["clearDesktopData", "clear_desktop_data", "clear_direct_ack"],
  ] as const)("passes the exact frozen packet and checks at actual invoke for %s", async (method, command, name) => {
    const request = validateRequest(JSON.parse(corpus.cases.find((entry) => entry.name === name)!.requestJson));
    const before = vi.fn(() => { expect(tauri.invoke).not.toHaveBeenCalled(); });
    await tauriRuntimeAdapter[method](request, before); expect(before).toHaveBeenCalledTimes(1); expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith(command, { request }); expect(tauri.invoke.mock.calls[0][1]?.request).toBe(request);
  });
  it("does no mutation command if the final post-import guard rejects ownership", async () => {
    const request = validateRequest(JSON.parse(corpus.cases[0].requestJson));
    await expect(tauriRuntimeAdapter.saveDesktopTask(request, () => { throw new Error("owned stale lifetime"); })).rejects.toThrow("owned stale lifetime"); expect(tauri.invoke).not.toHaveBeenCalled();
  });
  it("queries the original packet without any write or normalization", async () => {
    const request = validateRequest(JSON.parse(corpus.cases[0].requestJson)); await tauriRuntimeAdapter.queryDesktopTaskMutation(request);
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("query_desktop_task_mutation", { request }); expect(tauri.invoke.mock.calls[0][1]?.request).toBe(request);
  });
  it("separates settings-only legacy import from task import and does not send a tasks field", async () => {
    const settings = { ...defaultAnalysisForm(), systemLanguage: "en" as const };
    await tauriRuntimeAdapter.loadDesktopData({ settings, tasks: [] });
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("import_legacy_desktop_data", { legacy: { settings } });
    tauri.invoke.mockClear(); await tauriRuntimeAdapter.loadDesktopData({ tasks: [] }); expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("load_desktop_data");
  });
});
