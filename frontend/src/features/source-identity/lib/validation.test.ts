import { describe, expect, it, vi } from "vitest";
import { sha256 } from "@/features/evidence/lib/validation";
import { identityFixture, identitySharedFixture as shared } from "../fixtures/fictional-identity";
import { rehash, changeFixture } from "../fixtures/modified-identity";
import { assessSelector, identitySummary } from "./derive";
import { identityPolicy, identityPolicySha256 } from "./policy";
import {
  copyEffectiveRequestIdentity,
  identityFromEvent,
  verifyEffectiveRequestIdentity,
  verifyIdentityOwner,
} from "./validation";
import { normalizeIdentityTasks, verifyIdentityTasks } from "./tasks";
import type { EffectiveRequestIdentity } from "../types";
import { loadTasks, saveVerifiedTasks } from "@/features/persistence/local-storage";
describe("saved effective request derivation", () => {
  it.each(shared.cases)("$name", (test) => {
    expect(
      assessSelector(test.input.run_instrument, test.input.tool, test.input.parameters),
    ).toEqual(test.expected);
  });
  it("embeds the exact frozen policy and independently verifies complete fixture", async () => {
    expect(identityPolicy).toEqual(shared.policy);
    expect(await sha256(identityPolicy)).toBe(identityPolicySha256);
    expect(
      await verifyEffectiveRequestIdentity(shared.assessment, shared.evidence, shared.snapshot),
    ).toEqual(shared.assessment);
  });
  it.each(["record", "source", "order", "false-result", "provider-stage", "summary"])(
    "rejects coherent %s forgery",
    async (kind) => {
      const value = structuredClone(shared.assessment) as EffectiveRequestIdentity;
      if (kind === "record") value.records.splice(1, 1);
      if (kind === "source") value.records[0].sources.pop();
      if (kind === "order") value.records.reverse();
      if (kind === "false-result") {
        value.records[1].record_alignment = "consistent";
        value.records[1].record_reason = "effective_request_aligned";
      }
      if (kind === "provider-stage")
        (value.records[0].sources[0] as unknown as Record<string, unknown>).provider_entity =
          "consistent";
      value.summary =
        kind === "summary"
          ? { ...value.summary, conflict_count: 0 }
          : identitySummary(value.records);
      await rehash(value, "assessment_sha256");
      await expect(
        verifyEffectiveRequestIdentity(value, shared.evidence, shared.snapshot),
      ).rejects.toThrow("reference_mismatch");
    },
  );
  it("rejects hash, clock, policy, unsafe text, null and unknown fields", async () => {
    for (const value of [
      null,
      { ...shared.assessment, assessment_sha256: "0".repeat(64) },
      { ...shared.assessment, reviewed_at: "2026-01-09T11:59:59.999999Z" },
      { ...shared.assessment, policy_sha256: "0".repeat(64) },
      { ...shared.assessment, extra: true },
      { ...shared.assessment, instrument: "password=synthetic" },
    ])
      await expect(
        verifyEffectiveRequestIdentity(value, shared.evidence, shared.snapshot),
      ).rejects.toThrow();
  });
  it("freezes caller inputs before the first hash await", async () => {
    const evidence = structuredClone(shared.evidence),
      snapshot = structuredClone(shared.snapshot),
      value = structuredClone(shared.assessment);
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const pending = verifyEffectiveRequestIdentity(value, evidence, snapshot);
    value.reviewed_at = "2026-02-01T12:00:00.000000Z";
    evidence.records[0].parameters = { symbol: "OTHER" };
    snapshot.report_sections.market_report = "changed";
    release();
    expect(await pending).toEqual(shared.assessment);
    vi.restoreAllMocks();
  });
  it("validates both present event representations including explicit null", async () => {
    const task = identityFixture();
    const event = {
      type: "completed" as const,
      effectiveRequestIdentity: task.effectiveRequestIdentity,
      finalState: { effective_request_identity: task.effectiveRequestIdentity },
    };
    expect(
      (await identityFromEvent(event, task.evidenceBundle, task.reportTextSnapshot))
        ?.effectiveRequestIdentity,
    ).toEqual(task.effectiveRequestIdentity);
    for (const changed of [
      { ...event, effectiveRequestIdentity: null },
      { ...event, finalState: { effective_request_identity: null } },
    ])
      expect(
        (await identityFromEvent(changed as never, task.evidenceBundle, task.reportTextSnapshot))
          ?.identityValidation?.status,
      ).toBe("invalid");
    expect(
      await identityFromEvent({ type: "completed" }, task.evidenceBundle, task.reportTextSnapshot),
    ).toBeUndefined();
  });
  it("requires marked unsafe completions to preserve authoritative REVIEW", async () => {
    const valid = await changeFixture((task) => {
      task.reportSections.final_trade_decision = "Rating: REVIEW";
    }, true);
    expect((await verifyIdentityOwner(valid.reportVersions[0])).identityValidation).toBeUndefined();
    const bad = await changeFixture((task) => {
      task.decision = "Buy";
      task.reportSections.final_trade_decision = "Rating: Buy\nRating: REVIEW";
    }, true);
    expect((await verifyIdentityOwner(bad.reportVersions[0])).identityValidation?.reason).toBe(
      "reference_mismatch",
    );
    const ambiguous = await changeFixture((task) => {
      task.reportSections.final_trade_decision = "Rating: REVIEW or Buy";
    }, true);
    expect(
      (await verifyIdentityOwner(ambiguous.reportVersions[0])).identityValidation?.reason,
    ).toBe("reference_mismatch");
    const unmarked = await changeFixture((task) => {
      task.decision = "Buy";
      task.reportSections.final_trade_decision = "Rating: Buy";
    });
    expect(
      (await verifyIdentityOwner(unmarked.reportVersions[0])).identityValidation,
    ).toBeUndefined();
  });
  it("captures both event representations and bindings before any hash await", async () => {
    const task = identityFixture(),
      expected = structuredClone(task.effectiveRequestIdentity);
    const event = {
      type: "completed" as const,
      effectiveRequestIdentity: structuredClone(task.effectiveRequestIdentity),
      finalState: { effective_request_identity: structuredClone(task.effectiveRequestIdentity) },
    };
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      await gate;
      return original(...args);
    });
    const pending = identityFromEvent(event, task.evidenceBundle, task.reportTextSnapshot);
    event.finalState.effective_request_identity!.reviewed_at = "2026-02-01T12:00:00.000000Z";
    task.evidenceBundle!.records[0].parameters = { symbol: "OTHER" };
    task.reportTextSnapshot!.report_sections.market_report = "changed";
    release();
    expect((await pending)?.effectiveRequestIdentity).toEqual(expected);
    vi.restoreAllMocks();
  });
  it("requires marked completed attachments while allowing intermediates and legacy absence", async () => {
    const task = await changeFixture((value) => {
      value.reportSections.final_trade_decision = "Rating: REVIEW";
    }, true);
    task.effectiveRequestIdentity = undefined;
    task.reportVersions[0].effectiveRequestIdentity = undefined;
    const saved = await verifyIdentityTasks([task]);
    expect(saved[0].identityValidation?.reason).toBe("reference_mismatch");
    expect(saved[0].reportVersions[0].identityValidation?.reason).toBe("reference_mismatch");
    expect(
      (await verifyIdentityOwner({ ...task, status: "running" as const })).identityValidation,
    ).toBeUndefined();
    expect((await verifyIdentityOwner(task.reportVersions[1])).identityValidation).toBeUndefined();
  });
  it("rejects changed valid assessments globally across current/frozen task owners", async () => {
    const first = identityFixture(),
      other = identityFixture();
    other.id = "other-task";
    other.reportVersions[0].id = "other-version";
    other.effectiveRequestIdentity!.reviewed_at = "2026-01-09T12:01:00.000000Z";
    await rehash(other.effectiveRequestIdentity!, "assessment_sha256");
    other.reportVersions[0].effectiveRequestIdentity = structuredClone(
      other.effectiveRequestIdentity,
    );
    const saved = await verifyIdentityTasks([first, other]);
    for (const task of saved) {
      expect(task.identityValidation?.reason).toBe("reference_mismatch");
      expect(task.reportVersions[0].identityValidation?.reason).toBe("reference_mismatch");
    }
    expect(
      normalizeIdentityTasks([first, structuredClone(first)]).every(
        (task) => !task.identityValidation,
      ),
    ).toBe(true);
  });
  it("binds the exact selected report and detects changed owning date/sections/run", () => {
    const first = identityFixture();
    for (const patch of [
      { runId: "00000000-0000-4000-8000-000000000001" },
      { reportSections: { market_report: "changed" } },
    ])
      expect(
        normalizeIdentityTasks([
          { ...first, reportVersions: [{ ...first.reportVersions[0], ...patch }] },
        ])[0].reportVersions[0].identityValidation?.reason,
      ).toBe("reference_mismatch");
    expect(
      copyEffectiveRequestIdentity(shared.assessment, shared.evidence, shared.snapshot),
    ).toEqual(shared.assessment);
  });
  it("binds top-level task identity even when imported metadata imitates a version", async () => {
    const first = identityFixture();
    const forged = {
      ...first,
      ticker: "OTHER",
      task: structuredClone(first.reportVersions[0].task),
      runId: first.evidenceBundle!.run_id,
      numericReviews: [],
    };
    expect((await verifyIdentityOwner(forged)).identityValidation?.reason).toBe(
      "reference_mismatch",
    );
    const changedDate = { ...forged, ticker: first.ticker, analysisDate: "2026-01-08" };
    expect((await verifyIdentityOwner(changedDate)).identityValidation?.reason).toBe(
      "reference_mismatch",
    );
  });
  it("binds saved identity to completed current state and admissible frozen version metadata", async () => {
    const task = identityFixture();
    for (const patch of [{ status: "running" as const }, { id: "" }, { id: "a".repeat(257) }])
      expect((await verifyIdentityOwner({ ...task, ...patch })).identityValidation?.reason).toBe(
        "reference_mismatch",
      );
    for (const patch of [{ id: "" }, { versionNumber: 0 }, { createdAt: "not a timestamp" }])
      expect(
        (await verifyIdentityOwner({ ...task.reportVersions[0], ...patch })).identityValidation
          ?.reason,
      ).toBe("reference_mismatch");
  });
  it("rejects a frozen version with wrong owner metadata disguised as a completed task", async () => {
    const task = identityFixture();
    const version = {
      ...task.reportVersions[0],
      task: { ...task.reportVersions[0].task, ticker: "OTHER" },
      runId: "00000000-0000-4000-8000-000000000001",
      status: "completed",
      ticker: task.ticker,
      analysisDate: task.analysisDate,
    };
    const direct = await verifyIdentityOwner(version);
    window.localStorage.clear();
    await saveVerifiedTasks([{ ...task, reportVersions: [version] }]);
    const stored = loadTasks()[0].reportVersions[0];
    expect(stored.effectiveRequestIdentity).toBeUndefined();
    expect(stored.identityValidation?.status).toBe("invalid");
    expect(direct.effectiveRequestIdentity).toBeUndefined();
    expect(direct.identityValidation?.reason).toBe("reference_mismatch");
  });
});
