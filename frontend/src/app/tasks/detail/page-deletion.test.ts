import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";
import { createEmptyTask, defaultGlobalSettings, defaultTaskDraft } from "@/lib/analysis";

const control = vi.hoisted(() => ({ taskId: "owned-page-a", push: vi.fn(), center: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: control.push }), useSearchParams: () => new URLSearchParams({ id: control.taskId }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/task-center/context", () => ({ useTaskCenter: control.center }));
vi.mock("@/features/report-export", () => ({ ReportVersionsPanel: () => null }));
vi.mock("@/features/source-identity/components/IdentityInspector", () => ({ IdentityInspector: () => null }));
vi.mock("@/features/research-readiness/components/ReadinessInspector", () => ({ ReadinessInspector: () => null }));
vi.mock("@/features/memory/components/MemoryInspector", () => ({ MemoryInspector: () => null }));
vi.mock("@/features/output-quality/components/OutputQualityPanel", () => ({ OutputQualityPanel: () => null }));
vi.mock("@/features/evidence/components/EvidenceInspector", () => ({ EvidenceInspector: () => null }));

function acknowledgement() {
  let resolve!: (deleted: boolean) => void;
  const promise = new Promise<boolean>((yes) => { resolve = yes; });
  return { promise, resolve };
}

describe("actual task detail deletion navigation", () => {
  let container: HTMLDivElement, root: Root, unmounted: boolean;
  const requests: ReturnType<typeof acknowledgement>[] = [];
  let deleteTask: ReturnType<typeof vi.fn>;
  const tasks = ["owned-page-a", "owned-page-b"].map((id) => ({
    ...createEmptyTask({ ...defaultTaskDraft(), ticker: "FICT", instrumentName: "Owned fictional page fixture", analysisDate: "2026-08-01" }, id),
    origin: "demo" as const, status: "completed" as const,
  }));
  function deleteButton() { return [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Delete Task"); }
  async function render() { await act(async () => root.render(createElement(Page))); }
  async function openMenu() { await act(async () => container.querySelector<HTMLButtonElement>("button")!.click()); expect(deleteButton()).toBeDefined(); }
  async function clickDelete() { await act(async () => deleteButton()!.click()); }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); control.taskId = "owned-page-a"; control.push.mockReset(); requests.length = 0;
    deleteTask = vi.fn(() => { const request = acknowledgement(); requests.push(request); return request.promise; });
    control.center.mockReturnValue({ getTask: (id: string) => tasks.find((task) => task.id === id), settings: { ...defaultGlobalSettings(), systemLanguage: "en" },
      hydrated: true, deleteTask, queueTask: vi.fn(), cancelQueuedTask: vi.fn(), getQueuePosition: vi.fn(), stopRunningTask: vi.fn(),
      setActiveTaskId: vi.fn(), saveEvaluationReviews: vi.fn(), saveNumericReviews: vi.fn() });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); unmounted = false;
  });
  afterEach(async () => {
    await act(async () => { requests.forEach((request) => request.resolve(false)); await Promise.all(requests.map((request) => request.promise)); });
    if (!unmounted) await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });
  it("keeps the menu and page while the deletion acknowledgement is pending", async () => {
    await render(); await openMenu(); await clickDelete();
    expect(deleteTask).toHaveBeenCalledWith("owned-page-a"); expect(control.push).not.toHaveBeenCalled(); expect(deleteButton()).toBeDefined();
  });
  it("keeps refusal on the same page with an explicit usable retry", async () => {
    await render(); await openMenu(); await clickDelete(); await act(async () => requests[0].resolve(false));
    expect(control.push).not.toHaveBeenCalled(); expect(deleteButton()).toBeDefined(); await clickDelete();
    expect(deleteTask).toHaveBeenCalledTimes(2); await act(async () => requests[1].resolve(true)); expect(control.push).toHaveBeenCalledExactlyOnceWith("/");
  });
  it("closes and navigates only after successful acknowledgement", async () => {
    await render(); await openMenu(); await clickDelete(); expect(control.push).not.toHaveBeenCalled();
    await act(async () => requests[0].resolve(true)); expect(control.push).toHaveBeenCalledExactlyOnceWith("/"); expect(deleteButton()).toBeUndefined();
  });
  it("shares a page deletion attempt across duplicate clicks and navigates once", async () => {
    await render(); await openMenu(); await act(async () => { deleteButton()!.click(); deleteButton()!.click(); });
    expect(deleteTask).toHaveBeenCalledExactlyOnceWith("owned-page-a"); expect(control.push).not.toHaveBeenCalled();
    await act(async () => requests[0].resolve(true)); expect(control.push).toHaveBeenCalledExactlyOnceWith("/");
  });
  it("does not navigate or close the newly selected task menu for an old acknowledgement", async () => {
    await render(); await openMenu(); await clickDelete(); control.taskId = "owned-page-b"; await render();
    if (!deleteButton()) await openMenu(); await act(async () => requests[0].resolve(true));
    expect(control.push).not.toHaveBeenCalled(); expect(deleteButton()).toBeDefined();
  });
  it("does not navigate after the detail page unmounts while acknowledgement is pending", async () => {
    await render(); await openMenu(); await clickDelete(); await act(async () => root.unmount()); unmounted = true;
    await act(async () => requests[0].resolve(true)); expect(control.push).not.toHaveBeenCalled();
  });
});
