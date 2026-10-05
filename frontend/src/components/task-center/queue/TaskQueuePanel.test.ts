import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyTask, defaultTaskDraft } from "@/lib/analysis";
import { TaskQueuePanel } from "./TaskQueuePanel";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)); afterEach(() => vi.unstubAllGlobals());
it("passes the displayed task object with queue controls rather than only a reusable ID", async () => {
  const element = document.createElement("div"); document.body.appendChild(element); const root = createRoot(element);
  const tasks = ["a", "b"].map((id) => ({ ...createEmptyTask(defaultTaskDraft(), id), status: "queued" as const }));
  const cancel = vi.fn(), move = vi.fn();
  try {
    await act(async () => root.render(createElement(TaskQueuePanel, { runningTask: null, queuedTasks: tasks, cleanupFailedTask: null, cleanupRetrying: false, stopping: false, onRetryCleanup: vi.fn(), language: "en", onStop: vi.fn(), onCancel: cancel, onMove: move })));
    const buttons = [...element.querySelectorAll("button")];
    await act(async () => { buttons[1].click(); buttons[2].click(); buttons[3].click(); });
    expect(move).toHaveBeenNthCalledWith(1, "a", "down", tasks[0]); expect(cancel).toHaveBeenCalledExactlyOnceWith("a", tasks[0]); expect(move).toHaveBeenNthCalledWith(2, "b", "up", tasks[1]);
  } finally { await act(async () => root.unmount()); element.remove(); }
});
