import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCenterProvider, useTaskCenter } from "./context";
import { createEmptyTask, defaultGlobalSettings, defaultTaskDraft } from "@/lib/analysis";
import { createFictionalDemoTask } from "@/features/report-export/fixtures/fictional-demo";
import * as runtime from "@/lib/runtime";
import type { AnalysisTask, SystemLanguage } from "@/lib/types";

const transport = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: transport.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: transport.listen }));
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("acknowledged desktop task deletion through the actual provider", () => {
  let container: HTMLDivElement, root: Root, center: ReturnType<typeof useTaskCenter>;
  let initial: AnalysisTask[], language: SystemLanguage;
  const nativeHeads = new Map<string, { taskId: string; generation: string; revision: string; state: "live" | "tombstone" }>();
  const collection = { collectionId: "owned-deletion-collection", epoch: "1" };
  const writes = new Map<string, ReturnType<typeof deferred>>();
  const actions: Promise<boolean | void>[] = [];
  function Consumer() {
    center = useTaskCenter();
    return createElement("div", null,
      createElement("p", { "data-notice": true }, center.notice),
      ...center.tasks.map((task) => createElement("article", { key: task.id, "data-task": task.id },
        createElement("p", null, task.reportSections.market_report),
        createElement("button", { "data-delete": task.id, onClick: () => { actions.push(Promise.resolve(center.deleteTask(task.id))); } }, "Delete"))));
  }
  async function mount() {
    await act(async () => root.render(createElement(TaskCenterProvider, null, createElement(Consumer))));
    for (let attempt = 0; !center.hydrated && attempt < 100; attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    expect(center.hydrated).toBe(true); expect(center.tasks.length).toBe(initial.length);
  }
  function click(id: string) { container.querySelector<HTMLButtonElement>(`button[data-delete="${id}"]`)!.click(); }
  function deletes() { return transport.invoke.mock.calls.filter(([command]) => command === "delete_desktop_task"); }
  function snapshot(id: string) { return JSON.stringify(center.tasks.find((task) => task.id === id)); }
  async function deleting(count = 1) { await vi.waitFor(async () => { await act(async () => {}); expect(deletes()).toHaveLength(count); }); }
  beforeEach(() => {
    language = "en"; initial = [createFictionalDemoTask("en", true)]; writes.clear(); actions.length = 0;
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke: (command: string, args?: Record<string, unknown>) => transport.invoke(command, args) }, configurable: true }); localStorage.clear();
    transport.invoke.mockReset().mockImplementation(async (command, args) => {
      if (command === "delete_desktop_task" || command === "save_desktop_task") {
        const request = args.request;
        if (command === "delete_desktop_task") { const pending = writes.get(request.expectedHead.taskId); if (!pending) throw new Error("Owned fixture missing deletion acknowledgement"); await pending.promise; }
        const head = { ...request.expectedHead, revision: String(BigInt(request.expectedHead.revision) + BigInt(1)), state: command === "delete_desktop_task" ? "tombstone" as const : "live" as const };
        nativeHeads.set(head.taskId, head);
        return { scope: "sql", receipt: { protocolVersion: 1, requestId: request.requestId, digest: "b".repeat(64), operation: request.operation, collection, heads: [head], sqlCommitted: true }, rejection: null, current: { collection, heads: [...nativeHeads.values()] } };
      }
      throw new Error(`Unexpected owned command: ${command}`);
    });
    transport.listen.mockReset().mockResolvedValue(vi.fn());
    vi.spyOn(runtime, "getRuntimeAdapter").mockReturnValue({ ...runtime.tauriRuntimeAdapter,
      getRuntimeInfo: async () => ({ kind: "tauri", label: "Owned desktop fixture" }),
      loadDesktopData: async () => {
        nativeHeads.clear(); initial.forEach((task) => nativeHeads.set(task.id, { taskId: task.id, generation: "1", revision: "1", state: "live" }));
        return { settings: { ...defaultGlobalSettings(), systemLanguage: language,
          apiKey: "owned-fictional-session-value", alphaVantageApiKey: "owned-fictional-secondary-value" }, tasks: structuredClone(initial), storage: { collection, heads: [...nativeHeads.values()], legacyTaskImportAllowed: false } };
      },
    });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { for (const pending of writes.values()) pending.resolve(); await Promise.all(actions); });
    await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("preserves exact task/report/evidence and session settings until native acknowledgement", async () => {
    const id = initial[0].id, pending = deferred(); writes.set(id, pending); await mount();
    const before = snapshot(id), settings = JSON.stringify(center.settings);
    await act(async () => click(id)); await deleting();
    expect(snapshot(id)).toBe(before); expect(container.querySelector(`[data-task="${id}"]`)).not.toBeNull();
    expect(JSON.stringify(center.settings)).toBe(settings); expect(center.notice).not.toBe("Task deleted.");
    await act(async () => pending.resolve()); expect(await actions[0]).toBe(true);
    expect(center.tasks.find((task) => task.id === id)).toBeUndefined(); expect(center.notice).toBe("Task deleted.");
  });
  it.each(["en", "zh"] as const)("retains exact saved report and shows localized refusal in %s", async (chosen) => {
    language = chosen; const id = initial[0].id, pending = deferred(); writes.set(id, pending); await mount();
    const before = snapshot(id), settings = JSON.stringify(center.settings);
    await act(async () => click(id)); await deleting();
    await act(async () => pending.reject({ code: "storage_owned", message: "Owned retained backend owner rejects deletion" }));
    expect(await actions[0]).toBe(false); expect(snapshot(id)).toBe(before); expect(JSON.stringify(center.settings)).toBe(settings);
    expect(container.querySelector(`[data-task="${id}"]`)).not.toBeNull();
    expect(center.notice).toBe(chosen === "en" ? "Deletion could not be confirmed. The task remains in the list; retry deleting it." : "未能确认删除完成。任务暂留在列表中，请重试。");
  });
  it("shares one actual native deletion across two clicks before acknowledgement", async () => {
    const id = initial[0].id, pending = deferred(); writes.set(id, pending); await mount();
    await act(async () => { click(id); click(id); }); await deleting();
    expect(deletes()).toHaveLength(1); expect(deletes()[0][1].request.expectedHead.taskId).toBe(id); expect(deletes()[0][1].request.operation).toBe("delete");
    await act(async () => pending.resolve()); expect(await Promise.all(actions)).toEqual([true, true]);
  });
  it("allows explicit retry after refusal and removes only after successful retry acknowledgement", async () => {
    const id = initial[0].id, refused = deferred(); writes.set(id, refused); await mount();
    await act(async () => click(id)); await deleting(); await act(async () => refused.reject({ code: "storage_owned", message: "Owned refusal" }));
    expect(await actions[0]).toBe(false); expect(center.tasks.find((task) => task.id === id)).toBeDefined();
    const retry = deferred(); writes.set(id, retry); await act(async () => click(id)); await deleting(2);
    expect(center.tasks.find((task) => task.id === id)).toBeDefined(); await act(async () => retry.resolve());
    expect(await actions[1]).toBe(true); expect(center.tasks.find((task) => task.id === id)).toBeUndefined(); expect(center.notice).toBe("Task deleted.");
  });
  it("keeps two task acknowledgements independent when they resolve in reverse order", async () => {
    const second = createEmptyTask({ ...defaultTaskDraft(), ticker: "FICT", instrumentName: "Owned fictional instrument", analysisDate: "2026-08-01" }, "owned-second-delete");
    initial.push(second); const firstId = initial[0].id, first = deferred(), other = deferred(); writes.set(firstId, first); writes.set(second.id, other); await mount();
    const before = snapshot(firstId); await act(async () => { click(firstId); click(second.id); }); await deleting(2);
    await act(async () => other.resolve()); expect(center.tasks.find((task) => task.id === second.id)).toBeUndefined(); expect(snapshot(firstId)).toBe(before);
    await act(async () => first.resolve()); expect(center.tasks).toHaveLength(0); expect(await Promise.all(actions)).toEqual([true, true]);
  });
  it("keeps the existing browser deletion path independent of desktop acknowledgement", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    localStorage.setItem("evidenceloom.analysisTasks.v1", JSON.stringify(initial));
    vi.mocked(runtime.getRuntimeAdapter).mockReturnValue(runtime.webRuntimeAdapter); await mount(); const id = initial[0].id;
    await act(async () => click(id)); expect(center.tasks.find((task) => task.id === id)).toBeUndefined();
    expect(center.notice).toBe("任务已删除。"); expect(deletes()).toHaveLength(0);
  });
});
