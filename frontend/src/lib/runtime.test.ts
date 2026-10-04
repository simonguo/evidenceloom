import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAnalysisForm } from "./analysis";
import { isAnalysisCleanupError } from "./desktop-analysis";
import { tauriRuntimeAdapter } from "./runtime";
import type { AnalysisEvent } from "./types";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  listen: vi.fn<(event: string, handler: (event: { payload: AnalysisEvent | string }) => void) => Promise<() => void>>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function registrationFixture() {
  const registration = deferred<() => void>(), entered = deferred<void>();
  let handler: ((event: { payload: AnalysisEvent | string }) => void) | undefined;
  tauri.listen.mockImplementation((_event, callback) => { handler = callback; entered.resolve(); return registration.promise; });
  return { registration, entered: entered.promise, emit: (payload: AnalysisEvent | string) => handler?.({ payload }) };
}
function observed<T>(promise: Promise<T>) { return promise.then((value) => ({ value }), (error: unknown) => ({ error })); }
function listenerCleanup(signal: AbortSignal) {
  const add = vi.spyOn(signal, "addEventListener"), remove = vi.spyOn(signal, "removeEventListener");
  return () => { expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]?.[1]); };
}
const payload = { ...defaultAnalysisForm(), analysisDate: "2026-08-01" };
let taskId: string, runId: string, sequence = 0;
function invokeDefault(command: string) { return Promise.resolve(command === "reserve_analysis" ? runId : undefined); }
function calls(command: string) { return tauri.invoke.mock.calls.filter(([name]) => name === command); }

describe("Tauri owned analysis lifecycle", () => {
  beforeEach(() => {
    taskId = `owned-lifecycle-${++sequence}`; runId = `owned-server-run-${sequence}`;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    tauri.invoke.mockReset().mockImplementation(invokeDefault); tauri.listen.mockReset().mockResolvedValue(vi.fn());
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it("reserves before subscribing and starts with the acknowledged identity", async () => {
    const controller = new AbortController(), check = listenerCleanup(controller.signal), f = registrationFixture();
    const unlisten = vi.fn(), onEvent = vi.fn();
    const run = tauriRuntimeAdapter.runAnalysis(taskId, payload, onEvent, controller.signal);
    await f.entered;
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("reserve_analysis", { taskId });
    expect(tauri.listen).toHaveBeenCalledExactlyOnceWith(`analysis-event:${taskId}:${runId}`, expect.any(Function));
    f.registration.resolve(unlisten); f.emit({ type: "error", error: "owned event fixture" }); await run;
    expect(calls("start_analysis")).toEqual([["start_analysis", { taskId, runId, payloadJson: expect.any(String) }]]);
    expect(JSON.parse(calls("start_analysis")[0][1]?.payloadJson as string)).not.toHaveProperty("apiKey");
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "error", error: "owned event fixture" });
    expect(unlisten).toHaveBeenCalledTimes(1); check(); controller.abort(); expect(calls("stop_analysis")).toHaveLength(0);
  });
  it("does no command or subscription for a pre-aborted signal", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(tauri.listen).not.toHaveBeenCalled(); expect(tauri.invoke).not.toHaveBeenCalled();
  });
  it("waits for reserve acknowledgement after cancellation and stops without starting", async () => {
    const reserve = deferred<unknown>(), entered = deferred<void>(), stop = deferred<void>();
    tauri.invoke.mockImplementation((command) => {
      if (command === "reserve_analysis") { entered.resolve(); return reserve.promise; }
      return command === "stop_analysis" ? stop.promise : invokeDefault(command);
    });
    const controller = new AbortController(), outcome = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal));
    await entered.promise; controller.abort(); const stopping = observed(tauriRuntimeAdapter.stopAnalysis(taskId));
    expect(calls("stop_analysis")).toHaveLength(0); expect(tauri.listen).not.toHaveBeenCalled();
    reserve.resolve(runId); stop.resolve();
    expect(await outcome).toMatchObject({ error: { name: "AbortError" } }); expect(await stopping).toEqual({ value: undefined });
    expect(calls("stop_analysis")).toEqual([["stop_analysis", { taskId, runId }]]);
    expect(calls("start_analysis")).toHaveLength(0); expect(tauri.listen).not.toHaveBeenCalled();
  });
  it("does not start after cancellation during a pending listener acknowledgement", async () => {
    const controller = new AbortController(), check = listenerCleanup(controller.signal), f = registrationFixture(), unlisten = vi.fn(), events = vi.fn();
    const outcome = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, events, controller.signal));
    await f.entered; controller.abort(); const stopping = tauriRuntimeAdapter.stopAnalysis(taskId);
    f.emit({ type: "error", error: "owned cancelled event" }); f.registration.resolve(unlisten);
    expect(await outcome).toMatchObject({ error: { name: "AbortError" } }); await stopping;
    expect(calls("stop_analysis")).toEqual([["stop_analysis", { taskId, runId }]]); expect(calls("start_analysis")).toHaveLength(0);
    expect(unlisten).toHaveBeenCalledTimes(1); expect(events).not.toHaveBeenCalled(); check();
  });
  it("observes stop acknowledgement even while the start command is pending", async () => {
    const start = deferred<void>(), stop = deferred<void>(), entered = deferred<void>();
    tauri.invoke.mockImplementation((command) => {
      if (command === "start_analysis") { entered.resolve(); return start.promise; }
      return command === "stop_analysis" ? stop.promise : invokeDefault(command);
    });
    const controller = new AbortController(), outcome = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal));
    await entered.promise; controller.abort(); let finished = false; void outcome.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false); const stopping = tauriRuntimeAdapter.stopAnalysis(taskId); stop.resolve();
    expect(await outcome).toMatchObject({ error: { name: "AbortError" } }); await stopping;
    expect(calls("stop_analysis")).toEqual([["stop_analysis", { taskId, runId }]]); start.resolve();
  });
  it.each([undefined, "", 7])("fails closed for invalid server identity %s", async (identity) => {
    tauri.invoke.mockResolvedValue(identity);
    await expect(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn())).rejects.toThrow("reservation was not acknowledged");
    expect(tauri.listen).not.toHaveBeenCalled(); expect(calls("start_analysis")).toHaveLength(0);
  });
  it("preserves reservation failure without inventing a stop identity", async () => {
    const error = { code: "analysis_failed", message: "owned reservation error" }; tauri.invoke.mockRejectedValue(error);
    expect(await observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn()))).toEqual({ error });
    expect(calls("stop_analysis")).toHaveLength(0); expect(tauri.listen).not.toHaveBeenCalled();
  });
  it.each([false, true])("preserves listener rejection including cancellation=%s", async (cancel) => {
    const controller = new AbortController(), check = listenerCleanup(controller.signal), f = registrationFixture(), error = new Error("owned registration failure");
    const outcome = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal));
    await f.entered; if (cancel) controller.abort(); f.registration.reject(error);
    expect(await outcome).toEqual({ error }); expect(calls("stop_analysis")).toEqual([["stop_analysis", { taskId, runId }]]);
    expect(calls("start_analysis")).toHaveLength(0); check();
  });
  it.each([false, true])("preserves generic start error including cancellation=%s", async (cancel) => {
    const controller = new AbortController(), error = { code: "analysis_failed", message: "owned start failure" };
    tauri.invoke.mockImplementation((command) => {
      if (command === "start_analysis") { if (cancel) controller.abort(); return Promise.reject(error); }
      return invokeDefault(command);
    });
    expect(await observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal))).toEqual({ error });
    expect(calls("stop_analysis")).toEqual([["stop_analysis", { taskId, runId }]]);
  });
  it("retains a failed stop identity until an explicit successful retry", async () => {
    const entered = deferred<void>(), start = deferred<void>(); let stopFails = true;
    tauri.invoke.mockImplementation((command) => {
      if (command === "start_analysis") { entered.resolve(); return start.promise; }
      if (command === "stop_analysis" && stopFails) return Promise.reject({ code: "analysis_cleanup_incomplete", message: "owned fixture" });
      return invokeDefault(command);
    });
    const controller = new AbortController(), outcome = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal));
    await entered.promise; controller.abort(); expect(await outcome).toMatchObject({ error: { name: "AnalysisCleanupError" } });
    expect(calls("stop_analysis")).toHaveLength(1);
    await expect(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn())).rejects.toMatchObject({ name: "AnalysisCleanupError" });
    expect(calls("reserve_analysis")).toHaveLength(1); stopFails = false; await tauriRuntimeAdapter.stopAnalysis(taskId);
    expect(calls("stop_analysis")).toEqual(Array(2).fill(["stop_analysis", { taskId, runId }]));
    start.resolve(); tauri.invoke.mockImplementation(invokeDefault); runId = "owned-fresh-server-run";
    await tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn()); expect(calls("start_analysis").at(-1)?.[1]).toMatchObject({ runId });
  });
  it("classifies the stable machine code and does not automatically retry backend cleanup", async () => {
    const error = { code: "analysis_cleanup_incomplete", message: "owned wording" };
    tauri.invoke.mockImplementation((command) => command === "start_analysis" ? Promise.reject(error) : invokeDefault(command));
    expect(await observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn()))).toMatchObject({ error: { name: "AnalysisCleanupError", cause: error } });
    expect(calls("stop_analysis")).toHaveLength(0); expect(isAnalysisCleanupError("Analysis cleanup incomplete")).toBe(false);
    expect(isAnalysisCleanupError({ code: "analysis_failed", message: "Analysis cleanup incomplete" })).toBe(false);
    await tauriRuntimeAdapter.stopAnalysis(taskId); expect(calls("stop_analysis")).toEqual([["stop_analysis", { taskId, runId }]]);
  });
  it("retains a failed listener disposal handle for explicit retry", async () => {
    const unlisten = vi.fn().mockImplementationOnce(() => { throw new Error("owned disposal failure"); }); tauri.listen.mockResolvedValue(unlisten);
    await expect(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn())).rejects.toMatchObject({ name: "AnalysisCleanupError" });
    await tauriRuntimeAdapter.stopAnalysis(taskId); expect(unlisten).toHaveBeenCalledTimes(2); expect(calls("stop_analysis")).toHaveLength(1);
  });
  it("shares stop attempts and ignores stale events and completion after replacement", async () => {
    const entered = deferred<void>(), oldStart = deferred<void>(), stop = deferred<void>(), f = registrationFixture(), events = vi.fn();
    tauri.invoke.mockImplementation((command) => {
      if (command === "start_analysis") { entered.resolve(); return oldStart.promise; }
      return command === "stop_analysis" ? stop.promise : invokeDefault(command);
    });
    const oldRun = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, events)); await f.entered; f.registration.resolve(vi.fn<() => void>()); await entered.promise;
    const stops = [tauriRuntimeAdapter.stopAnalysis(taskId), tauriRuntimeAdapter.stopAnalysis(taskId)]; stop.resolve(); await Promise.all(stops);
    expect(await oldRun).toMatchObject({ error: { name: "AbortError" } }); expect(calls("stop_analysis")).toHaveLength(1);
    const freshStart = deferred<void>(), freshEntered = deferred<void>();
    tauri.invoke.mockImplementation((command) => {
      if (command === "start_analysis") { freshEntered.resolve(); return freshStart.promise; }
      return Promise.resolve(command === "reserve_analysis" ? "owned-new-run" : undefined);
    });
    tauri.listen.mockResolvedValue(vi.fn()); const freshRun = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn())); await freshEntered.promise;
    f.emit({ type: "error", error: "owned stale event" }); oldStart.resolve(); await Promise.resolve(); expect(events).not.toHaveBeenCalled();
    await tauriRuntimeAdapter.stopAnalysis(taskId); expect(calls("stop_analysis").at(-1)?.[1]).toEqual({ taskId, runId: "owned-new-run" });
    freshStart.resolve(); expect(await freshRun).toMatchObject({ error: { name: "AbortError" } });
  });
  it("bounds a never-returning reservation and retries the same pending stop before a late acknowledgement", async () => {
    vi.useFakeTimers(); const reserve = deferred<unknown>(), entered = deferred<void>();
    tauri.invoke.mockImplementation((command) => {
      if (command === "reserve_analysis") { entered.resolve(); return reserve.promise; }
      return invokeDefault(command);
    });
    const controller = new AbortController(), outcome = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal));
    await entered.promise; controller.abort(); await vi.advanceTimersByTimeAsync(5_001);
    expect(await outcome).toMatchObject({ error: { name: "AnalysisCleanupError" } });
    const firstRetry = observed(tauriRuntimeAdapter.stopAnalysis(taskId)); await vi.advanceTimersByTimeAsync(5_001);
    expect(await firstRetry).toMatchObject({ error: { name: "AnalysisCleanupError" } });
    expect(calls("reserve_analysis")).toHaveLength(1); expect(calls("stop_analysis")).toHaveLength(0);
    await expect(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn())).rejects.toMatchObject({ name: "AnalysisCleanupError" });
    reserve.resolve(runId); await Promise.resolve(); await Promise.resolve();
    await tauriRuntimeAdapter.stopAnalysis(taskId);
    expect(calls("stop_analysis")).toEqual([["stop_analysis", { taskId, runId }]]);
    expect(calls("start_analysis")).toHaveLength(0); expect(tauri.listen).not.toHaveBeenCalled();
  });
  it("bounds a never-returning stop and does not issue duplicate unknown stop commands on retry", async () => {
    vi.useFakeTimers(); const start = deferred<void>(), stop = deferred<void>(), entered = deferred<void>();
    tauri.invoke.mockImplementation((command) => {
      if (command === "start_analysis") { entered.resolve(); return start.promise; }
      return command === "stop_analysis" ? stop.promise : invokeDefault(command);
    });
    const controller = new AbortController(), outcome = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal));
    await entered.promise; controller.abort(); const stopping = observed(tauriRuntimeAdapter.stopAnalysis(taskId));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await outcome).toMatchObject({ error: { name: "AnalysisCleanupError" } });
    expect(await stopping).toMatchObject({ error: { name: "AnalysisCleanupError" } });
    const retry = observed(tauriRuntimeAdapter.stopAnalysis(taskId)); await vi.advanceTimersByTimeAsync(5_001);
    expect(await retry).toMatchObject({ error: { name: "AnalysisCleanupError" } }); expect(calls("stop_analysis")).toHaveLength(1);
    stop.resolve(); await tauriRuntimeAdapter.stopAnalysis(taskId); start.resolve();
    expect(calls("stop_analysis")).toHaveLength(1);
    runId = "owned-after-stop-ack"; tauri.invoke.mockImplementation(invokeDefault); await tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn());
    expect(calls("start_analysis").at(-1)?.[1]).toMatchObject({ runId });
  });
  it("bounds pending listener handoff, blocks replacement, and disposes a late acknowledgement", async () => {
    vi.useFakeTimers(); const controller = new AbortController(), events = vi.fn(), f = registrationFixture();
    const outcome = observed(tauriRuntimeAdapter.runAnalysis(taskId, payload, events, controller.signal)); await f.entered; controller.abort();
    const stopping = observed(tauriRuntimeAdapter.stopAnalysis(taskId)); await vi.advanceTimersByTimeAsync(5_001);
    expect(await outcome).toMatchObject({ error: { name: "AnalysisCleanupError" } }); expect(await stopping).toMatchObject({ error: { name: "AnalysisCleanupError" } });
    expect(calls("start_analysis")).toHaveLength(0); await expect(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn())).rejects.toMatchObject({ name: "AnalysisCleanupError" });
    const unlisten = vi.fn(); f.registration.resolve(unlisten); await Promise.resolve(); await Promise.resolve();
    f.emit({ type: "error", error: "owned late event" }); expect(events).not.toHaveBeenCalled(); expect(unlisten).toHaveBeenCalledTimes(1);
    await tauriRuntimeAdapter.stopAnalysis(taskId); expect(calls("stop_analysis")).toHaveLength(1);
    runId = "owned-after-listener-retry"; tauri.listen.mockResolvedValue(vi.fn()); await tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn());
    expect(calls("start_analysis").at(-1)?.[1]).toMatchObject({ runId });
  });
});
