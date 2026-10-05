import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { task } from "@/features/analysis-recovery/test-support/fixtures";
import { TaskQueuePanel } from "./TaskQueuePanel";

it("shows separate truthful cleanup/result confirmation controls and disables the active retry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const element = document.createElement("div"), root = createRoot(element), retryResult = vi.fn(), retryCleanup = vi.fn(); document.body.appendChild(element);
  const base = { runningTask: null, queuedTasks: [], cleanupFailedTask: null, cleanupRetrying: false, stopping: false, language: "en" as const, onStop: vi.fn(), onRetryCleanup: retryCleanup, onCancel: vi.fn(), onMove: vi.fn() };
  try {
    await act(async () => root.render(createElement(TaskQueuePanel, { ...base, cleanupFailedTask: task(), cleanupUnconfirmed: true })));
    expect(element.textContent).toContain("Stopping has not been confirmed"); await act(async () => [...element.querySelectorAll("button")].find((button) => button.textContent === "Retry stopping")!.click()); expect(retryCleanup).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement(TaskQueuePanel, { ...base, resultPendingTask: task(), resultRetrying: true, onRetryResult: retryResult })));
    expect(element.textContent).toContain("Saving the analysis result has not been confirmed"); const button = [...element.querySelectorAll("button")].find((item) => item.textContent === "Retry result confirmation")!; expect(button.disabled).toBe(true); await act(async () => button.click()); expect(retryResult).not.toHaveBeenCalled();
    await act(async () => root.render(createElement(TaskQueuePanel, { ...base, resultPendingTask: task(), resultRetrying: false, onRetryResult: retryResult }))); await act(async () => [...element.querySelectorAll("button")].find((item) => item.textContent === "Retry result confirmation")!.click()); expect(retryResult).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); }
});
