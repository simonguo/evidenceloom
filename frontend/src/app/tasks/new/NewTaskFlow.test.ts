import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyTask, defaultGlobalSettings, defaultTaskDraft } from "@/lib/analysis";
import { NewTaskFlow } from "./NewTaskFlow";
import type { AnalysisTask } from "@/lib/types";

const control = vi.hoisted(() => ({ push: vi.fn(), center: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: control.push }) }));
vi.mock("@/components/task-center/context", () => ({ useTaskCenter: control.center }));
describe("actual new-task demo navigation acknowledgement", () => {
  let element: HTMLDivElement, root: Root, unmounted: boolean, resolve: (task: AnalysisTask | undefined) => void;
  const create = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); control.push.mockReset(); create.mockReset().mockImplementation(() => new Promise<AnalysisTask | undefined>((done) => { resolve = done; }));
    control.center.mockReturnValue({ settings: { ...defaultGlobalSettings(), systemLanguage: "en" }, runningTask: null, queuedTasks: [], createAndQueueTask: vi.fn(), createDemoTask: create });
    element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element); unmounted = false;
  });
  afterEach(async () => { if (!unmounted) await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
  async function click() { await act(async () => root.render(createElement(NewTaskFlow))); const button = [...element.querySelectorAll("button")].find((item) => item.textContent?.toLowerCase().includes("fictional"))!; expect(button).toBeDefined(); await act(async () => { button.click(); button.click(); }); }
  it("uses one create action and navigates only after its confirmed task", async () => {
    await click(); expect(create).toHaveBeenCalledTimes(1); expect(control.push).not.toHaveBeenCalled();
    await act(async () => resolve(createEmptyTask(defaultTaskDraft(), "owned-demo"))); expect(control.push).toHaveBeenCalledExactlyOnceWith("/tasks/detail?id=owned-demo");
  });
  it("does not navigate for an unconfirmed creation", async () => { await click(); await act(async () => resolve(undefined)); expect(control.push).not.toHaveBeenCalled(); });
  it("does not navigate after unmount while creation is pending", async () => { await click(); await act(async () => root.unmount()); unmounted = true; await act(async () => resolve(createEmptyTask(defaultTaskDraft(), "owned-demo"))); expect(control.push).not.toHaveBeenCalled(); });
});
