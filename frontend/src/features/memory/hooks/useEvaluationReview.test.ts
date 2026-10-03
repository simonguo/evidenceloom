import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportVersion } from "@/lib/types";
import { defaultGlobalSettings } from "@/lib/analysis";
import { component, memoryTask, reviewFor } from "../fixtures/test-data";
import { useEvaluationReview } from "./useEvaluationReview";

const { getResearchMemoryInventory } = vi.hoisted(() => ({ getResearchMemoryInventory: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ getRuntimeAdapter: () => ({ getResearchMemoryInventory }) }));
describe("read-only selected-version evaluation refresh", () => {
  let root: Root; let container: HTMLDivElement; let refresh: () => Promise<void>;
  const save = vi.fn();
  const settings = { ...defaultGlobalSettings(), apiKey: "session-model-secret", alphaVantageApiKey: "session-data-secret", pythonPath: "configured-interpreter", projectRoot: "configured-project" };
  function Session({ version }: { version: ReportVersion }) {
    const hook = useEvaluationReview(version, "en", settings, save); refresh = hook.refresh;
    return createElement("p", { role: "status", "data-loading": hook.loading }, hook.message);
  }
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    getResearchMemoryInventory.mockReset(); save.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  it("requests only the selected UUID and authorized runner paths, then saves separate dated attachments", async () => {
    const version = memoryTask().reportVersions[0]; const original = structuredClone(version.memoryBundle!);
    const review = await reviewFor(original.decision_snapshot);
    getResearchMemoryInventory.mockResolvedValue({ reviews: [review], missing_ids: [] });
    await act(async () => root.render(createElement(Session, { version })));
    await act(async () => refresh());
    expect(getResearchMemoryInventory).toHaveBeenCalledExactlyOnceWith({ decisionIds: [original.run_id], pythonPath: settings.pythonPath, projectRoot: settings.projectRoot });
    expect(JSON.stringify(getResearchMemoryInventory.mock.calls)).not.toMatch(/session-model-secret|session-data-secret|holding_period|benchmark/);
    expect(save).toHaveBeenCalledExactlyOnceWith(version.id, [review]);
    expect(version.memoryBundle).toEqual(original); expect(version.evaluationReviews).toEqual([]);
    expect(container.textContent).toContain("without fetching prices or re-evaluating");
    await act(async () => root.render(createElement(Session, { version: { ...version, id: "other-version" } })));
    expect(container.textContent).not.toContain("Loaded saved evaluation");
  });
  it("reports durable missing records and unsupported legacy runners without modifying originals", async () => {
    const version = memoryTask().reportVersions[0];
    getResearchMemoryInventory.mockResolvedValueOnce({ reviews: [], missing_ids: [version.runId] });
    await act(async () => root.render(createElement(Session, { version })));
    await act(async () => refresh());
    expect(container.textContent).toContain("No durable record was found"); expect(save).not.toHaveBeenCalled();
    getResearchMemoryInventory.mockResolvedValueOnce({ type: "ready" });
    await act(async () => refresh());
    expect(container.textContent).toContain("runner may not support this feature"); expect(save).not.toHaveBeenCalled();
  });
  it("does not query inventory for memory-only versions or hash-corrupt completions", async () => {
    const version = memoryTask().reportVersions[0];
    version.memoryBundle = await component({ ...version.memoryBundle!, persistence_status: "memory_only" as const }, "bundle_sha256");
    await act(async () => root.render(createElement(Session, { version })));
    await act(async () => refresh());
    expect(container.textContent).toContain("memory-only"); expect(getResearchMemoryInventory).not.toHaveBeenCalled();
    version.memoryBundle.persistence_status = "durable";
    await act(async () => refresh());
    expect(container.textContent).toContain("could not be read or verified"); expect(getResearchMemoryInventory).not.toHaveBeenCalled();
  });
  it("attaches an in-flight v1 review to v1 without showing its feedback under selected v2", async () => {
    const first = memoryTask().reportVersions[0]; const second = { ...structuredClone(first), id: "version-2", versionNumber: 2 };
    const review = await reviewFor(first.memoryBundle!.decision_snapshot);
    let resolve!: (value: unknown) => void;
    let started!: () => void;
    const requestStarted = new Promise<void>((done) => { started = done; });
    getResearchMemoryInventory.mockImplementation(() => new Promise((done) => { resolve = done; started(); }));
    await act(async () => root.render(createElement(Session, { version: first })));
    let request!: Promise<void>;
    await act(async () => { request = refresh(); await requestStarted; });
    expect(getResearchMemoryInventory).toHaveBeenCalledOnce();
    await act(async () => root.render(createElement(Session, { version: second })));
    expect(container.querySelector("p")?.dataset.loading).toBe("false");
    await act(async () => { resolve({ reviews: [review], missing_ids: [] }); await request; });
    expect(save).toHaveBeenCalledExactlyOnceWith(first.id, [review]);
    expect(container.textContent).not.toContain("Loaded saved evaluation");
    expect(container.querySelector("p")?.dataset.loading).toBe("false");
  });
});
