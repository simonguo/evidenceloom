import { beforeEach, describe, expect, it } from "vitest";
import { loadTasks, saveTasks, saveVerifiedTasks } from "@/features/persistence/local-storage";
import { identityFixture } from "../fixtures/fictional-identity";
import { rehash } from "../fixtures/modified-identity";
import { assertRetainedIdentityAuthority, verifyIdentityTasks } from "./tasks";
import { changeFixture } from "../fixtures/modified-identity";
import { verifiedIdentityExport } from "./export";
import { sha256 } from "@/features/evidence/lib/validation";
const key = "evidenceloom.analysisTasks.v1";
beforeEach(() => window.localStorage.clear());
describe("immutable saved request assessment authority", () => {
  it("preserves an unknown-policy invalid diagnostic and blocks export", async () => {
    const task = await changeFixture(() => {}, true);
    task.evidenceBundle!.manifest.effective_request_identity_policy_sha256 = "0".repeat(64);
    task.evidenceBundle!.manifest_sha256 = await sha256(task.evidenceBundle!.manifest);
    await rehash(task.evidenceBundle!, "bundle_sha256");
    task.reportTextSnapshot!.evidence_bundle_sha256 = task.evidenceBundle!.bundle_sha256;
    await rehash(task.reportTextSnapshot!, "snapshot_sha256");
    task.effectiveRequestIdentity = undefined;
    task.identityValidation = { status: "invalid", reason: "reference_mismatch" };
    Object.assign(task.reportVersions[0], {
      evidenceBundle: structuredClone(task.evidenceBundle),
      reportTextSnapshot: structuredClone(task.reportTextSnapshot),
      effectiveRequestIdentity: undefined,
      identityValidation: task.identityValidation,
    });
    await saveVerifiedTasks([task]);
    const [loaded] = loadTasks();
    expect(loaded.identityValidation).toEqual(task.identityValidation);
    expect(loaded.reportVersions[0].identityValidation).toEqual(task.identityValidation);
    await expect(verifiedIdentityExport(loaded.reportVersions[0])).rejects.toThrow(
      "reference_mismatch",
    );
  });
  it("retains exact input payloads and assessment through actual save/reload", async () => {
    const task = identityFixture();
    await saveVerifiedTasks([task]);
    const [loaded] = await verifyIdentityTasks(loadTasks());
    expect(loaded.effectiveRequestIdentity).toEqual(task.effectiveRequestIdentity);
    expect(loaded.reportVersions[0].effectiveRequestIdentity).toEqual(
      task.reportVersions[0].effectiveRequestIdentity,
    );
    expect(loaded.evidenceBundle).toEqual(task.evidenceBundle);
    expect(loaded.reportVersions[0].reportTextSnapshot).toEqual(task.reportTextSnapshot);
    expect(loaded.reportVersions[1].effectiveRequestIdentity).toBeUndefined();
  });
  it.each(["ordinary", "verified"])(
    "%s save cannot overwrite prior authority with a malformed assessment",
    async (mode) => {
      const task = identityFixture();
      await saveVerifiedTasks([task]);
      const durable = window.localStorage.getItem(key);
      const changed = structuredClone(task);
      changed.reportVersions[0].effectiveRequestIdentity!.records.pop();
      await rehash(changed.reportVersions[0].effectiveRequestIdentity!, "assessment_sha256");
      if (mode === "ordinary") expect(() => saveTasks([changed])).toThrow();
      else await expect(saveVerifiedTasks([changed])).rejects.toThrow();
      expect(window.localStorage.getItem(key)).toBe(durable);
    },
  );
  it("refuses later additions to an already frozen version even when the attachment is valid", async () => {
    const complete = identityFixture(),
      old = structuredClone(complete);
    old.effectiveRequestIdentity = undefined;
    old.reportVersions[0].effectiveRequestIdentity = undefined;
    await saveVerifiedTasks([old]);
    const durable = window.localStorage.getItem(key);
    await expect(saveVerifiedTasks([complete])).rejects.toThrow();
    expect(window.localStorage.getItem(key)).toBe(durable);
    expect(() => assertRetainedIdentityAuthority([old], [complete])).toThrow("reference_mismatch");
  });
  it("a new run can clear current fields while retaining the exact frozen version", async () => {
    const task = identityFixture();
    await saveVerifiedTasks([task]);
    const queued = {
      ...task,
      status: "queued" as const,
      effectiveRequestIdentity: undefined,
      identityValidation: undefined,
      evidenceBundle: undefined,
      reportTextSnapshot: undefined,
      reportSections: {},
      decision: "",
    };
    await saveVerifiedTasks([queued]);
    const [loaded] = loadTasks();
    expect(loaded.effectiveRequestIdentity).toBeUndefined();
    expect(loaded.reportVersions[0].effectiveRequestIdentity).toEqual(
      task.effectiveRequestIdentity,
    );
    saveTasks([]);
    expect(loadTasks()).toEqual([]);
  });
  it("current and frozen global run divergences invalidate every owner before persistence", async () => {
    const first = identityFixture(),
      other = identityFixture();
    other.id = "other-owner";
    other.reportVersions[0].id = "other-frozen";
    other.effectiveRequestIdentity!.reviewed_at = "2026-01-09T12:01:00.000000Z";
    await rehash(other.effectiveRequestIdentity!, "assessment_sha256");
    other.reportVersions[0].effectiveRequestIdentity = structuredClone(
      other.effectiveRequestIdentity,
    );
    await saveVerifiedTasks([first, other]);
    for (const task of await verifyIdentityTasks(loadTasks())) {
      expect(task.identityValidation?.reason).toBe("reference_mismatch");
      expect(task.reportVersions[0].identityValidation?.reason).toBe("reference_mismatch");
    }
  });
  it("identical copies with distinct frozen owners remain valid", async () => {
    const task = identityFixture(),
      other = structuredClone(task);
    other.id = "other-copy";
    other.reportVersions[0].id = "other-version";
    other.reportVersions[1].id = "other-legacy";
    await saveVerifiedTasks([task, other]);
    expect(
      (await verifyIdentityTasks(loadTasks())).every(
        (row) => !row.identityValidation && !row.reportVersions[0].identityValidation,
      ),
    ).toBe(true);
  });
  it("invalid markers survive reload and a new forged body is never normalized to legacy absence", async () => {
    const task = identityFixture();
    task.effectiveRequestIdentity!.summary.conflict_count = 0;
    task.reportVersions[0].effectiveRequestIdentity = structuredClone(
      task.effectiveRequestIdentity,
    );
    await saveVerifiedTasks([task]);
    const [loaded] = await verifyIdentityTasks(loadTasks());
    expect(loaded.identityValidation?.reason).toBe("reference_mismatch");
    expect(loaded.reportVersions[0].identityValidation?.reason).toBe("reference_mismatch");
    expect(loaded.reportVersions[0].effectiveRequestIdentity).toBeUndefined();
  });
});
