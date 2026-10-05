import { beforeEach, describe, expect, it } from "vitest";
import { memoryTask } from "@/features/memory/fixtures/test-data";
import { createFictionalReadinessDemoTask } from "@/features/research-readiness/fixtures/fictional-readiness";
import { verifySavedMemory } from "@/features/memory/lib/validation";
import { verifySavedReadiness } from "@/features/research-readiness/lib/validation";
import { verifyTaskEvidence } from "@/features/evidence/lib/validation";
import { saveVerifiedTasks, loadTasks } from "@/features/persistence/local-storage";

beforeEach(() => window.localStorage.clear());
describe("current owner identity cannot become imported version metadata", () => {
  it.each(["memory", "readiness"] as const)(
    "rejects reverse version spoofing in %s and Evidence including actual save/load",
    async (kind) => {
      const task = kind === "memory" ? memoryTask() : createFictionalReadinessDemoTask("en");
      const original = task.reportVersions[0];
      const bad = {
        ...original,
        task: { ...original.task, ticker: "OTHER" },
        runId: "00000000-0000-4000-8000-000000000001",
        status: "completed",
        ticker: task.ticker,
        analysisDate: task.analysisDate,
        assetType: task.assetType,
      };
      if (kind === "memory")
        expect((await verifySavedMemory(bad)).memoryValidation?.reason).toBe("reference_mismatch");
      else
        expect((await verifySavedReadiness(bad)).readinessValidation?.reason).toBe(
          "reference_mismatch",
        );
      const forged = { ...task, reportVersions: [bad] };
      expect((await verifyTaskEvidence(forged)).reportVersions[0].evidenceBundle).toBeUndefined();
      await saveVerifiedTasks([forged]);
      const stored = loadTasks()[0].reportVersions[0];
      expect(stored.evidenceBundle).toBeUndefined();
      expect(kind === "memory" ? stored.memoryBundle : stored.researchReadiness).toBeUndefined();
      expect(
        kind === "memory" ? stored.memoryValidation?.status : stored.readinessValidation?.status,
      ).toBe("invalid");
    },
  );
  it.each(["memory", "readiness"] as const)(
    "rejects top ticker spoofing in %s and Evidence direct binding and persisted reload",
    async (kind) => {
      const task = kind === "memory" ? memoryTask() : createFictionalReadinessDemoTask("en");
      expect((await verifyTaskEvidence(task)).evidenceBundle).toBeDefined();
      if (kind === "memory") expect((await verifySavedMemory(task)).memoryBundle).toBeDefined();
      else expect((await verifySavedReadiness(task)).researchReadiness).toBeDefined();
      const bad = {
        ...task,
        ticker: "OTHER",
        task: structuredClone(task.reportVersions[0].task),
        runId: task.evidenceBundle!.run_id,
      };
      expect((await verifyTaskEvidence(bad)).evidenceBundle).toBeUndefined();
      if (kind === "memory")
        expect((await verifySavedMemory(bad)).memoryValidation?.reason).toBe("reference_mismatch");
      else
        expect((await verifySavedReadiness(bad)).readinessValidation?.reason).toBe(
          "reference_mismatch",
        );
      await saveVerifiedTasks([bad]);
      const [stored] = loadTasks();
      expect(stored.evidenceBundle).toBeUndefined();
      expect(kind === "memory" ? stored.memoryBundle : stored.researchReadiness).toBeUndefined();
      expect(
        kind === "memory" ? stored.memoryValidation?.status : stored.readinessValidation?.status,
      ).toBe("invalid");
      expect(stored.reportVersions[0].evidenceBundle).toEqual(
        task.reportVersions[0].evidenceBundle,
      );
    },
  );
});
