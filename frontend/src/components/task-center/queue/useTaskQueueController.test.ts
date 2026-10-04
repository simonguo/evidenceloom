import { webcrypto } from "node:crypto";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyTask, defaultGlobalSettings, defaultTaskDraft } from "@/lib/analysis";
import { AnalysisCleanupError } from "@/lib/desktop-analysis";
import { createTranslator } from "@/lib/i18n";
import type { RuntimeAdapter } from "@/lib/runtime";
import type { AnalysisEvent, AnalysisTask } from "@/lib/types";
import { TaskQueuePanel } from "./TaskQueuePanel";
import { useTaskQueueController } from "./useTaskQueueController";

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function queued(id: string, order: number): AnalysisTask {
  return { ...createEmptyTask({ ...defaultTaskDraft(), analysisDate: "2026-08-01", ticker: "SPY" }, id), status: "queued", queueOrder: order };
}

describe("queue cleanup acknowledgement and retry controls", () => {
  let root: Root, container: HTMLDivElement, queue: ReturnType<typeof useTaskQueueController>, tasks: AnalysisTask[];
  let initial: AnalysisTask[], runs: Map<string, ReturnType<typeof deferred>>, handlers: Map<string, (event: AnalysisEvent) => void>;
  let adapter: RuntimeAdapter;
  const events = vi.fn(), notice = vi.fn(), persist = vi.fn();
  const settings = { ...defaultGlobalSettings(), systemLanguage: "en" as const };
  function Harness() {
    const [state, setTasks] = useState(initial); tasks = state;
    queue = useTaskQueueController({ hydrated: true, tasks: state, setTasks, settings,
      runtimeAdapterRef: { current: adapter }, persistTask: persist, onEvent: (id, event) => {
        events(id, event);
        if (event.type === "completed") setTasks((current) => current.map((task) => task.id === id ? { ...task, status: "completed" } : task));
      }, setNotice: notice });
    return createElement(TaskQueuePanel, { runningTask: queue.runningTask, queuedTasks: queue.queuedTasks,
      cleanupFailedTask: queue.cleanupFailedTask, cleanupRetrying: queue.cleanupRetrying, stopping: queue.stopping,
      language: "en", onStop: queue.stopRunningTask, onRetryCleanup: () => { void queue.retryCleanup(); },
      onCancel: queue.cancelQueuedTask, onMove: queue.moveQueuedTask });
  }
  async function mount() { await act(async () => root.render(createElement(Harness))); }
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    initial = [queued("owned-first", 1), queued("owned-second", 2)]; runs = new Map(); handlers = new Map();
    events.mockReset(); notice.mockReset(); persist.mockReset();
    adapter = { runAnalysis: vi.fn((id, _payload, callback) => {
      const run = deferred(); runs.set(id, run); handlers.set(id, callback); return run.promise;
    }), stopAnalysis: vi.fn().mockResolvedValue(undefined) } as unknown as RuntimeAdapter;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("keeps stopping visible and the queue paused until stop acknowledgement", async () => {
    const stop = deferred(); vi.mocked(adapter.stopAnalysis).mockReturnValue(stop.promise); await mount();
    expect(adapter.runAnalysis).toHaveBeenCalledTimes(1);
    await act(async () => queue.stopRunningTask());
    expect(adapter.stopAnalysis).toHaveBeenCalledExactlyOnceWith("owned-first");
    expect(queue.stopping).toBe(true); expect(queue.executionActive).toBe(true);
    expect(tasks[0].status).toBe("running"); expect(container.textContent).toContain("Stopping analysis…");
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Stop task"]')?.disabled).toBe(true);
    await act(async () => { runs.get("owned-first")!.reject(new DOMException("owned abort", "AbortError")); });
    expect(adapter.runAnalysis).toHaveBeenCalledTimes(1); expect(tasks[1].status).toBe("queued");
    await act(async () => stop.resolve());
    expect(tasks[0].status).toBe("stopped"); expect(tasks[1].status).toBe("running"); expect(adapter.runAnalysis).toHaveBeenCalledTimes(2);
  });

  it("exposes an actual retry button, preserves failure, and resumes only after successful cleanup", async () => {
    const stop = deferred(), retry = deferred(); vi.mocked(adapter.stopAnalysis).mockReturnValueOnce(stop.promise).mockReturnValueOnce(retry.promise);
    await mount(); await act(async () => queue.stopRunningTask());
    const error = new AnalysisCleanupError("en", new Error("owned cleanup failure"));
    await act(async () => { stop.reject(error); runs.get("owned-first")!.reject(error); });
    expect(queue.cleanupFailedTask?.id).toBe("owned-first"); expect(queue.executionActive).toBe(true);
    expect(tasks[0].error).toBe(createTranslator("en")("analysisCleanupFailed"));
    expect(tasks[1].status).toBe("queued"); expect(adapter.runAnalysis).toHaveBeenCalledTimes(1);
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Retry stopping")!;
    expect(button).toBeDefined(); expect(button.disabled).toBe(false);
    await act(async () => { button.click(); button.click(); });
    expect(adapter.stopAnalysis).toHaveBeenCalledTimes(2); expect(queue.cleanupRetrying).toBe(true);
    expect(adapter.runAnalysis).toHaveBeenCalledTimes(1);
    await act(async () => retry.resolve());
    expect(queue.cleanupFailedTask).toBeNull(); expect(tasks[0].status).toBe("stopped"); expect(tasks[0].error).toBe("");
    expect(adapter.runAnalysis).toHaveBeenCalledTimes(2); expect(tasks[1].status).toBe("running");
  });

  it("retains a repeated cleanup failure and prevents requeueing the blocked owner", async () => {
    const error = { code: "analysis_cleanup_incomplete", message: "owned backend fixture" };
    await mount(); await act(async () => runs.get("owned-first")!.reject(error));
    expect(queue.cleanupFailedTask?.id).toBe("owned-first");
    vi.mocked(adapter.stopAnalysis).mockRejectedValue(error);
    await act(async () => { await queue.retryCleanup(); });
    expect(queue.cleanupFailedTask?.id).toBe("owned-first"); expect(queue.cleanupRetrying).toBe(false);
    expect(queue.queueTask("owned-first")).toBe(false); expect(notice).toHaveBeenLastCalledWith(createTranslator("en")("analysisCleanupFailed"));
    expect(tasks[1].status).toBe("queued"); expect(adapter.runAnalysis).toHaveBeenCalledTimes(1);
  });

  it("does not let an old callback/finally clear a replacement after successful retry", async () => {
    const stop = deferred(); vi.mocked(adapter.stopAnalysis).mockReturnValueOnce(stop.promise).mockResolvedValue(undefined);
    await mount(); await act(async () => queue.stopRunningTask());
    await act(async () => stop.reject(new AnalysisCleanupError("en", "owned stop failure")));
    await act(async () => { await queue.retryCleanup(); });
    expect(tasks[1].status).toBe("running");
    await act(async () => {
      handlers.get("owned-first")!({ type: "error", error: "owned late old event" });
      runs.get("owned-first")!.reject(new Error("owned late old completion"));
    });
    expect(events).not.toHaveBeenCalled(); expect(queue.runningTask?.id).toBe("owned-second"); expect(queue.executionActive).toBe(true);
    expect(tasks[0].status).toBe("stopped");
    await act(async () => queue.stopRunningTask()); expect(adapter.stopAnalysis).toHaveBeenLastCalledWith("owned-second");
  });

  it("keeps the active owner stoppable after a terminal event until runner cleanup completes", async () => {
    await mount(); await act(async () => handlers.get("owned-first")!({ type: "completed" }));
    expect(tasks[0].status).toBe("completed"); expect(queue.runningTask?.id).toBe("owned-first");
    expect(queue.executionActive).toBe(true); expect(queue.queueTask("owned-first")).toBe(false);
    expect(adapter.runAnalysis).toHaveBeenCalledTimes(1);
    await act(async () => queue.stopRunningTask()); expect(adapter.stopAnalysis).toHaveBeenCalledExactlyOnceWith("owned-first");
    await act(async () => runs.get("owned-first")!.reject(new DOMException("owned abort", "AbortError")));
    expect(tasks[0].status).toBe("stopped"); expect(tasks[1].status).toBe("running");
  });

  it("keeps a generic cancelled start error visible after confirmed stop", async () => {
    await mount(); await act(async () => queue.stopRunningTask());
    await act(async () => runs.get("owned-first")!.reject({ code: "analysis_failed", message: "owned actionable start error" }));
    expect(tasks[0].status).toBe("error"); expect(tasks[0].error).toBe("owned actionable start error");
    expect(tasks[1].status).toBe("running"); expect(queue.cleanupFailedTask).toBeNull();
  });
});
