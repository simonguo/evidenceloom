import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTasks, saveVerifiedTasks } from "@/features/persistence/local-storage";
import { memoryTask } from "../fixtures/test-data";
import { targetMemoryReview, targetMemoryTask } from "../fixtures/target-memory";
import { appendEvaluationReviews } from "./reviews";
import { verifyTaskMemory } from "./validation";
import { normalizeMemoryTasks } from "./tasks";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); window.localStorage.clear(); });
afterEach(() => { window.localStorage.clear(); vi.unstubAllGlobals(); });

describe("versioned target-bound memory persistence", () => {
  it("round-trips exact as-generated v2 and later facts without rewriting historical input", async () => {
    const task = targetMemoryTask();
    const original = structuredClone(task.memoryBundle);
    const review = await targetMemoryReview();
    const settled = appendEvaluationReviews(task, task.reportVersions[0].id, [review]);
    await saveVerifiedTasks([settled]);
    const loaded = await verifyTaskMemory(loadTasks()[0]);
    expect(loaded.memoryValidation).toBeUndefined();
    expect(loaded.memoryBundle).toEqual(original);
    expect(loaded.reportVersions[0].memoryBundle).toEqual(original);
    expect(loaded.reportVersions[0].evaluationReviews).toEqual([review]);
    expect(loaded.memoryBundle!.decision_snapshot.outcome).toBeNull();
    expect(loaded.memoryBundle!.input_snapshot.decisions[0].contract.schema_version).toBe(1);
  });

  it("rejects retained v1-to-v2 replacement without changing stored original bytes", async () => {
    const original = memoryTask();
    await saveVerifiedTasks([original]);
    const stored = window.localStorage.getItem("evidenceloom.analysisTasks.v1");
    const replacement = targetMemoryTask();
    replacement.id = original.id;
    replacement.reportVersions[0].id = original.reportVersions[0].id;
    await expect(saveVerifiedTasks([replacement])).rejects.toThrow();
    expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).toBe(stored);
  });

  it("rejects conflicting contracts under one run UUID across different task owners", async () => {
    const old = memoryTask();
    old.id = "legacy-owner";
    old.reportVersions[0].id = "legacy-version";
    const current = targetMemoryTask();
    current.id = "target-owner";
    current.reportVersions[0].id = "target-version";
    await saveVerifiedTasks([old, current]);
    const loaded = loadTasks();
    expect(loaded.every((task) => task.memoryValidation?.reason === "reference_mismatch")).toBe(true);
    expect(loaded.flatMap((task) => task.reportVersions).every((version) => version.memoryValidation?.reason === "reference_mismatch")).toBe(true);
  });

  it("allows identical same-run copies with distinct owners and preserves ordinary legacy absence", async () => {
    const first = targetMemoryTask();
    const other = structuredClone(first);
    other.id = "second-owner";
    other.reportVersions[0].id = "second-version";
    const legacy = memoryTask();
    legacy.id = "absent-owner";
    legacy.reportVersions[0].id = "absent-version";
    delete legacy.memoryBundle;
    delete legacy.evidenceBundle;
    delete legacy.reportVersions[0].memoryBundle;
    delete legacy.reportVersions[0].evidenceBundle;
    await saveVerifiedTasks([first, other, legacy]);
    const loaded = loadTasks();
    expect(loaded.every((task) => !task.memoryValidation)).toBe(true);
    expect(loaded[0].memoryBundle).toEqual(first.memoryBundle);
    expect(loaded[1].memoryBundle).toEqual(first.memoryBundle);
    expect(loaded[2].memoryBundle).toBeUndefined();
  });

  it("marks reused Memory-only version IDs across owners invalid on actual save and reload", async () => {
    const first = targetMemoryTask(), other = structuredClone(first);
    other.id = "different-task-owner";
    await saveVerifiedTasks([first, other]);
    const loaded = loadTasks();
    expect(loaded.map((task) => task.reportVersions[0].memoryValidation?.reason)).toEqual(["reference_mismatch", "reference_mismatch"]);
    expect(loaded.every((task) => task.reportVersions[0].memoryBundle === undefined)).toBe(true);
  });

  it("atomically rejects a new owner reusing a retained Memory-only version ID", async () => {
    const first = targetMemoryTask();
    await saveVerifiedTasks([first]);
    const before = window.localStorage.getItem("evidenceloom.analysisTasks.v1");
    const other = structuredClone(first);
    other.id = "different-task-owner";
    await expect(saveVerifiedTasks([first, other])).rejects.toThrow("reference_mismatch");
    expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).toBe(before);
  });

  it.each([true, false])("rejects a mixed attached/legacy version ID in either task order without a reload exception (%s)", async (memoryFirst) => {
    const first = targetMemoryTask(), legacy = structuredClone(first);
    legacy.id = "legacy-task-owner";
    delete legacy.memoryBundle;
    delete legacy.evidenceBundle;
    delete legacy.reportVersions[0].memoryBundle;
    delete legacy.reportVersions[0].evidenceBundle;
    await saveVerifiedTasks(memoryFirst ? [first, legacy] : [legacy, first]);
    const loaded = loadTasks();
    expect(loaded.map((task) => task.reportVersions[0].memoryValidation?.reason)).toEqual(["reference_mismatch", "reference_mismatch"]);
    expect(loaded.every((task) => task.reportVersions[0].memoryBundle === undefined)).toBe(true);
  });

  it("propagates within-task conflicts to every same-run owner before any payload is stripped", () => {
    const old = memoryTask();
    old.id = "legacy-owner";
    old.reportVersions[0].id = "legacy-version";
    const mixed = targetMemoryTask();
    mixed.id = "mixed-owner";
    mixed.reportVersions = [{ ...structuredClone(old.reportVersions[0]), id: "mixed-version" }];
    const checked = normalizeMemoryTasks([mixed, old]);
    expect(checked.every((task) => task.memoryValidation?.reason === "reference_mismatch")).toBe(true);
    expect(checked.flatMap((task) => task.reportVersions).every((version) => version.memoryValidation?.reason === "reference_mismatch")).toBe(true);
  });

  it("keeps saved review attachments append-only and permits explicit whole-task deletion", async () => {
    const task = targetMemoryTask();
    const settled = appendEvaluationReviews(task, task.reportVersions[0].id, [await targetMemoryReview()]);
    await saveVerifiedTasks([settled]);
    const retained = window.localStorage.getItem("evidenceloom.analysisTasks.v1");
    await expect(saveVerifiedTasks([task])).rejects.toThrow("reference_mismatch");
    expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).toBe(retained);
    await saveVerifiedTasks([]);
    await saveVerifiedTasks([memoryTask()]);
    expect(loadTasks()[0].memoryBundle!.decision_snapshot.contract.schema_version).toBe(1);
  });
});
