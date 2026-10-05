import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTasks, saveVerifiedTasks } from "@/features/persistence/local-storage";
import { appendCompletedReportVersion, createRunContext } from "@/features/report-export/lib/versioning";
import { defaultAnalysisForm } from "@/lib/analysis";
import { component, memoryTask, reviewFor } from "../fixtures/test-data";
import { appendEvaluationReviews } from "./reviews";
import { verifySavedMemory, verifyTaskMemory } from "./validation";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); window.localStorage.clear(); });
afterEach(() => vi.unstubAllGlobals());
describe("versioned memory persistence", () => {
  it("round-trips all prior artifacts while later settlement remains separate from original input", async () => {
    const task = memoryTask(); const original = structuredClone(task.memoryBundle!); const version = task.reportVersions[0];
    const facts = await reviewFor(original.decision_snapshot, { reflection: false });
    const reflected = await reviewFor(original.decision_snapshot);
    const settled = appendEvaluationReviews(task, version.id, [facts, reflected]);
    const deduped = appendEvaluationReviews(settled, version.id, [reflected]);
    expect(deduped.reportVersions[0].evaluationReviews).toHaveLength(2);
    expect(deduped.evaluationReviews).toHaveLength(2);
    await saveVerifiedTasks([deduped]);
    const [loaded] = loadTasks(); const verified = await verifyTaskMemory(loaded);
    expect(verified.memoryValidation).toBeUndefined();
    expect(verified.memoryBundle).toEqual(original);
    expect(verified.reportVersions[0].memoryBundle).toEqual(original);
    expect(verified.evaluationReviews).toEqual([facts, reflected]);
    expect(verified.reportVersions[0].evaluationReviews).toEqual([facts, reflected]);
    expect(verified.memoryBundle!.decision_snapshot.outcome).toBeNull();
    expect(JSON.stringify(verified)).toContain("123.45678901234567");
  });
  it("keeps the selected version's frozen benchmark/horizon and excludes current task settings", async () => {
    const task = memoryTask(); const first = task.reportVersions[0];
    task.reportVersions.push({ ...structuredClone(first), id: "second-version", versionNumber: 2 });
    task.memoryBundle = undefined; task.evidenceBundle = undefined; task.evaluationReviews = [];
    task.ticker = "CURRENT.TEST"; task.analysisDate = "2026-10-04";
    const review = await reviewFor(first.memoryBundle!.decision_snapshot);
    const next = appendEvaluationReviews(task, first.id, [review]);
    expect(next.reportVersions[0].evaluationReviews).toEqual([review]);
    expect(next.reportVersions[1].evaluationReviews).toEqual([]);
    expect(next.evaluationReviews).toEqual([]);
    expect((await verifySavedMemory(next.reportVersions[0])).memoryValidation).toBeUndefined();
    expect(next.reportVersions[0].memoryBundle!.decision_snapshot.contract).toMatchObject({ resolved_benchmark: "FICTIONAL.TEST", holding_period_days: 2 });
  });
  it("rejects two individually valid, coherently rehashed conflicting saved outcomes", async () => {
    const task = memoryTask(); const version = task.reportVersions[0];
    const first = await reviewFor(task.memoryBundle!.decision_snapshot);
    const conflict = await reviewFor(task.memoryBundle!.decision_snapshot, { price: "99.0" });
    conflict.reviewed_at = "2025-02-22T12:00:00Z";
    const changed = await component(conflict, "attachment_sha256");
    expect(() => appendEvaluationReviews(task, version.id, [first, changed])).toThrow("reference_mismatch");
    const poisoned = { ...version, evaluationReviews: [first, changed] };
    expect((await verifySavedMemory(poisoned)).memoryValidation?.reason).toBe("reference_mismatch");
  });
  it("rejects later component removal and conflicting same-time versions", async () => {
    const task = memoryTask(); const snapshot = task.memoryBundle!.decision_snapshot;
    const full = await reviewFor(snapshot); const factsOnly = await reviewFor(snapshot, { reflection: false });
    const removed = await component({ ...factsOnly, reviewed_at: "2025-02-22T12:00:00Z" }, "attachment_sha256");
    expect(() => appendEvaluationReviews(task, task.reportVersions[0].id, [full, removed])).toThrow("reference_mismatch");
    const equalTime = await component({ ...factsOnly, reviewed_at: full.reviewed_at }, "attachment_sha256");
    expect(() => appendEvaluationReviews(task, task.reportVersions[0].id, [full, equalTime])).toThrow("reference_mismatch");
  });
  it("rejects same-run contradictions across current task and different report versions", async () => {
    const task = memoryTask(); const version = task.reportVersions[0];
    const first = await reviewFor(task.memoryBundle!.decision_snapshot);
    const conflict = await reviewFor(task.memoryBundle!.decision_snapshot, { price: "9.0" });
    task.reportVersions.push({ ...structuredClone(version), id: "other-version", versionNumber: 2, evaluationReviews: [conflict] });
    expect(() => appendEvaluationReviews(task, version.id, [first])).toThrow("reference_mismatch");
    task.reportVersions[0].evaluationReviews = [first];
    const checked = await verifyTaskMemory(task);
    expect(checked.memoryValidation?.reason).toBe("reference_mismatch");
    expect(checked.reportVersions.every((item) => item.memoryValidation?.reason === "reference_mismatch")).toBe(true);
  });
  it("rejects replacing the original completion with a rehashed later version of the same run", async () => {
    const task = memoryTask();
    task.memoryBundle = await component({ ...task.memoryBundle!, persistence_status: "memory_only" as const }, "bundle_sha256");
    const checked = await verifyTaskMemory(task);
    expect(checked.memoryValidation?.reason).toBe("reference_mismatch");
    expect(checked.reportVersions[0].memoryValidation?.reason).toBe("reference_mismatch");
  });
  it("retains visible corruption after browser reload and never renders it as legacy absence", async () => {
    const task = memoryTask(); const review = await reviewFor(task.memoryBundle!.decision_snapshot);
    task.reportVersions[0].evaluationReviews = [review];
    review.snapshot.artifacts[review.snapshot.reflection!.response_sha256].payload += " HASH-CORRUPTION";
    await saveVerifiedTasks([task]);
    const version = loadTasks()[0].reportVersions[0];
    expect(version.memoryBundle).toBeUndefined();
    expect(version.memoryValidation?.reason).toBe("hash_mismatch");
    expect(JSON.stringify(version)).not.toContain("HASH-CORRUPTION");
  });
  it("freezes validated event memory before later task mutations", () => {
    const task = memoryTask(); task.origin = "analysis"; task.reportVersions = [];
    const versioned = appendCompletedReportVersion(task, { type: "completed", memoryBundle: task.memoryBundle, evidenceBundle: task.evidenceBundle, reportSections: task.reportSections }, createRunContext(defaultAnalysisForm()));
    const frozen = structuredClone(versioned.reportVersions[0].memoryBundle!);
    task.memoryBundle!.input_snapshot.context_artifact.payload = "changed live input";
    task.reportSections.final_trade_decision = "changed live decision";
    expect(versioned.reportVersions[0].memoryBundle).toEqual(frozen);
    expect(versioned.reportVersions[0].reportSections.final_trade_decision).not.toBe("changed live decision");
  });
});
