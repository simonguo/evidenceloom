import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadTasks, saveVerifiedTasks } from "@/features/persistence/local-storage";
import { appendCompletedReportVersion } from "@/features/report-export/lib/versioning";
import { changeQuality, component, readinessFixture } from "../fixtures/test-data";
import { normalizeReadinessTasks, normalizeReadinessTaskFields, normalizeTaskReadiness, verifyReadinessTasks, verifySavedReadiness, verifyTaskReadiness } from "./validation";
import { createFictionalReadinessDemoTask } from "../fixtures/fictional-readiness";
import { verifyTaskEvidence } from "@/features/evidence/lib/validation";
import { verifiedReadinessExport } from "./export";

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); window.localStorage.clear(); });
describe("version-specific saved input checks", () => {
  it("validates the complete browser demo generated from the actual Python verifier fixture", async () => {
    const saved = await verifyTaskReadiness(await verifyTaskEvidence(createFictionalReadinessDemoTask("en")));
    expect(saved.researchReadiness!.status).toBe("ready"); expect(saved.readinessValidation).toBeUndefined();
    expect(saved.evidenceValidation).toBeUndefined(); expect(saved.reportVersions[0].evidenceValidation).toBeUndefined();
    expect(saved.reportVersions[0].researchReadiness!.assessment_sha256).toBe(saved.researchReadiness!.assessment_sha256);
    expect(saved.reportSections.final_trade_decision).toContain("entirely fictional");
  });
  it("deep-copies complete contracts and exact Evidence payloads through reload", async () => {
    const task = await readinessFixture(); const assessmentHash = task.researchReadiness!.assessment_sha256;
    const rawPayloads = Object.values(task.evidenceBundle!.artifacts).map((artifact) => artifact.payload);
    await saveVerifiedTasks([task]); task.researchReadiness!.policy.selected_analysts.push("news");
    const saved = await verifyTaskReadiness(loadTasks()[0]);
    expect(saved.researchReadiness!.assessment_sha256).toBe(assessmentHash);
    expect(saved.researchReadiness!.policy.selected_analysts).toEqual(["market"]);
    expect(Object.values(saved.evidenceBundle!.artifacts).map((artifact) => artifact.payload)).toEqual(rawPayloads);
    expect(saved.reportVersions[0].researchReadiness!.assessment_sha256).toBe(assessmentHash);
  });
  it("freezes only the validated completed version while a prior legacy version stays unknown", async () => {
    const task = await readinessFixture(); const version = task.reportVersions[0];
    task.origin = "analysis";
    task.reportVersions = [{ ...version, id: "older", runId: "44444444-4444-4444-8444-444444444444", researchReadiness: undefined, evidenceBundle: undefined, legacy: true }];
    const completed = appendCompletedReportVersion(task, { type: "completed", researchReadiness: task.researchReadiness, evidenceBundle: task.evidenceBundle, decision: "Hold", reportSections: task.reportSections }, { runId: version.runId, manifest: version.run! });
    const saved = await verifyTaskReadiness(completed);
    expect(saved.reportVersions).toHaveLength(2);
    expect(saved.reportVersions[0].researchReadiness).toBeUndefined(); expect(saved.reportVersions[0].readinessValidation).toBeUndefined();
    expect(saved.reportVersions[1].researchReadiness!.assessment_sha256).toBe(task.researchReadiness!.assessment_sha256);
    task.researchReadiness!.checks[0].status = "invalid";
    expect(saved.reportVersions[1].researchReadiness!.checks[0].status).toBe("passed");
  });
  it("never borrows current run checks for an older selected version", async () => {
    const old = await readinessFixture(); const current = await changeQuality(old, (quality) => { quality.price_basis = { status: "unknown", value: null }; });
    current.researchReadiness!.run_id = "55555555-5555-4555-8555-555555555555";
    current.evidenceBundle!.run_id = current.researchReadiness!.run_id;
    current.evidenceBundle = await component(current.evidenceBundle!, "bundle_sha256");
    current.researchReadiness = await component(current.researchReadiness!, "assessment_sha256");
    current.reportVersions = old.reportVersions;
    const saved = await verifyTaskReadiness(current);
    expect(saved.researchReadiness!.status).toBe("review_required");
    expect(saved.reportVersions[0].researchReadiness!.status).toBe("ready");
    expect(saved.reportVersions[0].decision).toBe("Hold");
  });
  it("rejects two individually coherent assessments claiming the same immutable run", async () => {
    const original = await readinessFixture(); const changed = await changeQuality(original, (quality) => { quality.price_basis = { status: "unknown", value: null }; });
    changed.reportVersions = original.reportVersions;
    const saved = normalizeTaskReadiness(changed);
    expect(saved.readinessValidation?.reason).toBe("reference_mismatch");
    expect(saved.reportVersions[0].readinessValidation?.reason).toBe("reference_mismatch");
  });
  it("rejects conflicting same-UUID assessments across task owners on save/reload and blocks export", async () => {
    const first = await readinessFixture(), second = await changeQuality(first, (quality) => { quality.price_basis = { status: "unknown", value: null }; });
    second.id = "other-task-owner"; second.reportVersions[0].id = "other-version-owner";
    await expect(verifyTaskReadiness(first)).resolves.toMatchObject({ readinessValidation: undefined });
    await expect(verifyTaskReadiness(second)).resolves.toMatchObject({ readinessValidation: undefined });
    const payloads = [first, second].map((task) => JSON.stringify(task.evidenceBundle!.artifacts));
    await saveVerifiedTasks([first, second]);
    const saved = await verifyReadinessTasks(loadTasks());
    expect(saved.map((task) => task.readinessValidation?.reason)).toEqual(["reference_mismatch", "reference_mismatch"]);
    expect(saved.every((task) => task.reportVersions[0].readinessValidation?.reason === "reference_mismatch")).toBe(true);
    expect(saved.map((task) => JSON.stringify(task.evidenceBundle!.artifacts))).toEqual(payloads);
    await expect(verifiedReadinessExport(saved[0].reportVersions[0])).rejects.toThrow("reference_mismatch");
    expect(first.researchReadiness).toBeDefined(); expect(second.researchReadiness).toBeDefined();
  });
  it("allows identical same-UUID copies across tasks and ignores legacy contract absence", async () => {
    const first = await readinessFixture(), second = structuredClone(first), legacy = structuredClone(first);
    second.id = "same-assessment-copy"; second.reportVersions[0].id = "same-version-copy";
    legacy.id = "legacy-owner"; delete legacy.researchReadiness; delete legacy.reportVersions[0].researchReadiness;
    const saved = await verifyReadinessTasks([first, second, legacy]);
    expect(saved.every((task) => task.readinessValidation === undefined && task.reportVersions[0].readinessValidation === undefined)).toBe(true);
    expect(saved.slice(0, 2).map((task) => task.researchReadiness!.assessment_sha256)).toEqual([first.researchReadiness!.assessment_sha256, first.researchReadiness!.assessment_sha256]);
    expect(normalizeReadinessTasks(saved)[2].researchReadiness).toBeUndefined();
  });
  it("propagates a within-task identity conflict to every other task before stripping any receipt", async () => {
    const original = await readinessFixture(), changed = await changeQuality(original, (quality) => { quality.price_basis = { status: "unknown", value: null }; });
    changed.reportVersions = structuredClone(original.reportVersions);
    const other = structuredClone(original); other.id = "third-owner"; other.reportVersions[0].id = "third-version";
    // This is the same owner-only preprocessing used by hydration and stream
    // completion; both conflicting hashes must survive until the list scan.
    const prepared = [changed, other].map(normalizeReadinessTaskFields);
    expect(prepared[0].researchReadiness).toBeDefined(); expect(prepared[0].reportVersions[0].researchReadiness).toBeDefined();
    const scanned = normalizeReadinessTasks(prepared);
    expect(scanned.every((task) => task.readinessValidation?.reason === "reference_mismatch" && task.reportVersions[0].readinessValidation?.reason === "reference_mismatch")).toBe(true);
    await saveVerifiedTasks([changed, other]);
    const loaded = loadTasks();
    expect(loaded.every((task) => task.readinessValidation?.reason === "reference_mismatch" && task.reportVersions[0].readinessValidation?.reason === "reference_mismatch")).toBe(true);
    await expect(verifiedReadinessExport(loaded[1].reportVersions[0])).rejects.toThrow("reference_mismatch");
  });
  it("preserves a corrupted hash as visible invalid state across save and reload", async () => {
    const task = await readinessFixture(); task.researchReadiness!.assessment_sha256 = "a".repeat(64); task.reportVersions[0].researchReadiness!.assessment_sha256 = "a".repeat(64);
    await saveVerifiedTasks([task]); const saved = loadTasks()[0];
    expect(saved.researchReadiness).toBeUndefined(); expect(saved.readinessValidation?.reason).toBe("hash_mismatch");
    expect(saved.reportVersions[0].readinessValidation?.reason).toBe("hash_mismatch");
    expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).toContain('"readinessValidation"');
  });
  it("rejects a frozen-version runtime budget inconsistent with its Evidence manifest", async () => {
    const task = await readinessFixture(); const version = task.reportVersions[0];
    version.run = { ...version.run!, runtimeRunSettings: { max_tool_rounds: 99, analysts: ["market"] } };
    expect((await verifySavedReadiness(version)).readinessValidation?.reason).toBe("reference_mismatch");
  });
});
