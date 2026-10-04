import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCenterProvider, useTaskCenter } from "@/components/task-center/context";
import { loadTasks, saveVerifiedTasks } from "@/features/persistence/local-storage";
import { targetMemoryReview, targetMemoryTask } from "../fixtures/target-memory";
import { verifyMemoryTasks } from "../lib/tasks";

vi.mock("@/lib/runtime", () => ({
  isTauriRuntime: () => false,
  defaultRuntimeInfo: () => ({}),
  getRuntimeAdapter: () => ({
    getRuntimeInfo: async () => ({}),
    resolveInstrument: () => { throw new Error("No source calls allowed"); },
  }),
}));

describe("durable saved evaluation reviews", () => {
  let root: Root;
  let container: HTMLDivElement;
  let center: ReturnType<typeof useTaskCenter>;
  function Consumer() {
    center = useTaskCenter();
    const count = center.tasks.flatMap((task) => task.reportVersions).reduce((sum, version) => sum + (version.evaluationReviews?.length ?? 0), 0);
    return createElement("p", null, `${center.hydrated ? "loaded" : "loading"}; reviews=${count}`);
  }
  async function mount() {
    await act(async () => root.render(createElement(TaskCenterProvider, null, createElement(Consumer))));
    await vi.waitFor(async () => { await act(async () => {}); expect(center.hydrated).toBe(true); });
  }
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("rejects actual quota failure without publishing or replacing durable history", async () => {
    const task = targetMemoryTask();
    await saveVerifiedTasks([task]);
    const before = window.localStorage.getItem("evidenceloom.analysisTasks.v1");
    await mount();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "evidenceloom.analysisTasks.v1" && JSON.parse(value)[0]?.reportVersions[0]?.evaluationReviews?.length) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      return original.call(this, key, value);
    });
    await act(async () => {
      await expect(center.saveEvaluationReviews(task.id, task.reportVersions[0].id, [await targetMemoryReview()])).rejects.toThrow();
    });
    expect(center.tasks[0].reportVersions[0].evaluationReviews).toEqual([]);
    expect(center.tasks[0].evaluationReviews).toEqual([]);
    expect(container.textContent).toContain("reviews=0");
    expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).toBe(before);
  });

  it("saves only the selected version and restores exact frozen input and later facts after reload", async () => {
    const task = targetMemoryTask();
    const selected = task.reportVersions[0];
    const legacy = { ...structuredClone(selected), id: "legacy-without-memory", runId: "44444444-4444-4444-8444-444444444444", memoryBundle: undefined, evidenceBundle: undefined, evaluationReviews: [], legacy: true };
    task.reportVersions = [legacy, selected];
    const original = structuredClone(task.memoryBundle);
    await saveVerifiedTasks([task]);
    await mount();
    const review = await targetMemoryReview();
    let saving!: Promise<void>;
    await act(async () => { saving = center.saveEvaluationReviews(task.id, selected.id, [review]); });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(center.tasks[0].reportVersions[1].evaluationReviews).toEqual([review]);
    });
    await saving;
    expect(center.tasks[0].reportVersions[0].evaluationReviews).toEqual([]);
    expect(center.tasks[0].reportVersions[1].evaluationReviews).toEqual([review]);
    const loaded = (await verifyMemoryTasks(loadTasks()))[0];
    expect(loaded.memoryBundle).toEqual(original);
    expect(loaded.reportVersions[1].memoryBundle).toEqual(original);
    expect(loaded.reportVersions[1].evaluationReviews).toEqual([review]);
    expect(loaded.memoryBundle!.decision_snapshot.outcome).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(center.tasks[0].reportVersions[1].evaluationReviews).toEqual([review]);
    expect(container.textContent).toContain("reviews=1");
  });
});
