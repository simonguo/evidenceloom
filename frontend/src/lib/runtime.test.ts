import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAnalysisForm } from "./analysis";
import { tauriRuntimeAdapter } from "./runtime";
import type { AnalysisEvent } from "./types";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<void>>(),
  listen: vi.fn<(event: string, handler: (event: { payload: AnalysisEvent | string }) => void) => Promise<() => void>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function deferredRegistration() {
  const registration = deferred<() => void>();
  const entered = deferred<void>();
  let handler: ((event: { payload: AnalysisEvent | string }) => void) | undefined;
  tauri.listen.mockImplementation((_event, callback) => {
    handler = callback;
    entered.resolve(undefined);
    return registration.promise;
  });
  return { registration, entered: entered.promise, emit: (payload: AnalysisEvent | string) => handler?.({ payload }) };
}

function expectAbortListenerCleanup(signal: AbortSignal) {
  const add = vi.spyOn(signal, "addEventListener");
  const remove = vi.spyOn(signal, "removeEventListener");
  return () => {
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", add.mock.calls[0]?.[1]);
  };
}

const payload = { ...defaultAnalysisForm(), analysisDate: "2026-08-01" };
const taskId = "owned-cancellation-fixture";

describe("Tauri analysis cancellation at listener registration", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    tauri.invoke.mockReset().mockResolvedValue(undefined);
    tauri.listen.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("starts once after registration and cleans up after normal completion", async () => {
    const controller = new AbortController();
    const checkCleanup = expectAbortListenerCleanup(controller.signal);
    const { registration, entered, emit } = deferredRegistration();
    const unlisten = vi.fn();
    const onEvent = vi.fn();
    const run = tauriRuntimeAdapter.runAnalysis(taskId, payload, onEvent, controller.signal);
    await entered;
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(tauri.listen).toHaveBeenCalledExactlyOnceWith(`analysis-event:${taskId}`, expect.any(Function));
    registration.resolve(unlisten);
    emit({ type: "error", error: "owned event fixture" });
    await run;
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("start_analysis", {
      taskId,
      payloadJson: expect.any(String),
    });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: "error", error: "owned event fixture" });
    expect(unlisten).toHaveBeenCalledTimes(1);
    checkCleanup();
    controller.abort();
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
  });

  it("does not register or invoke for a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(tauri.listen).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("does not start when cancelled while listener registration is pending", async () => {
    const controller = new AbortController();
    const checkCleanup = expectAbortListenerCleanup(controller.signal);
    const { registration, entered } = deferredRegistration();
    const unlisten = vi.fn();
    const outcome = tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal)
      .then(() => undefined, (error: unknown) => error);
    await entered;
    controller.abort();
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("stop_analysis", { taskId });
    registration.resolve(unlisten);
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(tauri.invoke).not.toHaveBeenCalledWith("start_analysis", expect.anything());
    expect(unlisten).toHaveBeenCalledTimes(1);
    checkCleanup();
  });

  it("preserves in-flight cancellation after start has been invoked", async () => {
    const controller = new AbortController();
    const checkCleanup = expectAbortListenerCleanup(controller.signal);
    const { registration, entered } = deferredRegistration();
    const start = deferred<void>();
    const started = deferred<void>();
    tauri.invoke.mockImplementation((command) => {
      if (command === "start_analysis") {
        started.resolve(undefined);
        return start.promise;
      }
      return Promise.resolve();
    });
    const unlisten = vi.fn();
    const outcome = tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal)
      .then(() => undefined, (error: unknown) => error);
    await entered;
    registration.resolve(unlisten);
    await started.promise;
    controller.abort();
    expect(tauri.invoke).toHaveBeenNthCalledWith(1, "start_analysis", expect.objectContaining({ taskId }));
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, "stop_analysis", { taskId });
    start.resolve(undefined);
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(tauri.invoke).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledTimes(1);
    checkCleanup();
  });

  it("preserves registration errors and removes the abort listener", async () => {
    const controller = new AbortController();
    const checkCleanup = expectAbortListenerCleanup(controller.signal);
    const { registration, entered } = deferredRegistration();
    const error = new Error("owned registration failure");
    const outcome = tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal)
      .then(() => undefined, (failure: unknown) => failure);
    await entered;
    registration.reject(error);
    expect(await outcome).toBe(error);
    checkCleanup();
    controller.abort();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("reports cancellation when pending registration subsequently rejects", async () => {
    const controller = new AbortController();
    const checkCleanup = expectAbortListenerCleanup(controller.signal);
    const { registration, entered } = deferredRegistration();
    const outcome = tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal)
      .then(() => undefined, (error: unknown) => error);
    await entered;
    controller.abort();
    registration.reject(new Error("owned registration failure after cancellation"));
    expect(await outcome).toMatchObject({ name: "AbortError" });
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("stop_analysis", { taskId });
    checkCleanup();
  });

  it("cleans up the registration and preserves an uncancelled start error", async () => {
    const controller = new AbortController();
    const checkCleanup = expectAbortListenerCleanup(controller.signal);
    const { registration, entered } = deferredRegistration();
    const error = new Error("owned start failure");
    tauri.invoke.mockRejectedValue(error);
    const unlisten = vi.fn();
    const outcome = tauriRuntimeAdapter.runAnalysis(taskId, payload, vi.fn(), controller.signal)
      .then(() => undefined, (failure: unknown) => failure);
    await entered;
    registration.resolve(unlisten);
    expect(await outcome).toBe(error);
    expect(unlisten).toHaveBeenCalledTimes(1);
    checkCleanup();
    controller.abort();
    expect(tauri.invoke).toHaveBeenCalledExactlyOnceWith("start_analysis", expect.objectContaining({ taskId }));
  });
});
