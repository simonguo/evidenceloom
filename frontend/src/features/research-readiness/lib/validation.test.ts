import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "@/features/evidence/lib/validation";
import { changeMarketRows, changeQuality, component, providerTable, readinessFixture, reassessTask } from "../fixtures/test-data";
import { copyResearchReadiness, normalizeTaskReadiness, readinessFromEvent, verifyResearchReadiness, verifySavedReadiness } from "./validation";
import sharedReadiness from "../../../../../tests/fixtures/research_readiness_v1.json";
import sharedEvidence from "../../../../../tests/fixtures/research_readiness_evidence_v1.json";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
describe("frozen research input checks", () => {
  it("re-derives the Python-produced assessment from actual saved verifier calculations", async () => {
    const saved = await verifyResearchReadiness(sharedReadiness, sharedEvidence);
    expect(saved.status).toBe("ready"); expect(saved.assessment_sha256).toBe(sharedReadiness.assessment_sha256);
    expect(JSON.stringify(sharedEvidence)).toContain("SourceTimestamp");
  });
  it("verifies recorded inputs, retains advisory unknowns and exact opaque numeric payloads", async () => {
    const task = await readinessFixture(); const before = canonicalJson(task.evidenceBundle);
    const verified = await verifyResearchReadiness(task.researchReadiness, task.evidenceBundle);
    expect(verified.status).toBe("ready"); expect(verified.recommendation_allowed).toBe(true);
    expect(verified.checks.slice(-2).every((check) => check.status === "unknown" && !check.required)).toBe(true);
    expect(canonicalJson(task.evidenceBundle)).toBe(before);
    const copy = copyResearchReadiness(verified, task.evidenceBundle); copy.policy.selected_analysts.push("news");
    expect(verified.policy.selected_analysts).toEqual(["market"]);
  });
  it("accepts canonical serialized envelopes regardless of object insertion order", async () => {
    const task = await readinessFixture();
    expect((await verifyResearchReadiness(JSON.parse(canonicalJson(task.researchReadiness)), JSON.parse(canonicalJson(task.evidenceBundle)))).status).toBe("ready");
  });
  it("rejects a coherently rehashed false pass after the verifier is skipped", async () => {
    const task = await readinessFixture();
    const record = task.evidenceBundle!.records.pop()!;
    for (const hash of [record.output_sha256, ...record.sources.map((source) => source.data_sha256!)]) if (!task.evidenceBundle!.records.some((item) => item.sources.some((source) => source.data_sha256 === hash))) delete task.evidenceBundle!.artifacts[hash];
    const saved = await reassessTask(task);
    expect(saved.researchReadiness!.status).toBe("insufficient_evidence");
    expect(saved.researchReadiness!.checks[1].reason_codes).toContain("missing_required_verification");
    const falsePass = structuredClone(saved.researchReadiness!);
    falsePass.checks[1] = { ...falsePass.checks[1], status: "passed", reason_codes: [] }; falsePass.checks[2] = { ...falsePass.checks[2], status: "passed", reason_codes: [] };
    falsePass.status = "ready"; falsePass.recommendation_allowed = true;
    await expect(verifyResearchReadiness(await component(falsePass, "assessment_sha256"), saved.evidenceBundle)).rejects.toThrow("reference_mismatch");
  });
  it.each(["unavailable", "empty", "partial", "withheld"] as const)("does not substitute a called %s receipt for usable data", async (status) => {
    const task = await readinessFixture(); task.evidenceBundle!.records[1].status = status;
    const saved = await reassessTask(task); const check = saved.researchReadiness!.checks[1];
    expect(check.status).not.toBe("passed"); expect(saved.researchReadiness!.recommendation_allowed).toBe(false);
    expect((await verifySavedReadiness(saved.reportVersions[0])).readinessValidation).toBeUndefined();
    saved.reportVersions[0].decision = "Hold";
    expect((await verifySavedReadiness(saved.reportVersions[0])).readinessValidation?.reason).toBe("reference_mismatch");
  });
  it.each(["\r", "\u2028", "\u2029", "\u0085", "\u000B", "\u000C", "\u001C", "\u001D", "\u001E"])("preserves the first authoritative rating across splitlines separator %j", async (separator) => {
    const task = await changeQuality(await readinessFixture(), (quality) => { quality.rows.in_window = 0; });
    task.reportVersions[0].reportSections.final_trade_decision = `Unrecognized heading${separator}Rating: Buy\nRating: REVIEW`;
    expect((await verifySavedReadiness(task.reportVersions[0])).readinessValidation?.reason).toBe("reference_mismatch");
  });
  it.each(["١. Rating: Buy", "Ratİng: Buy", "Rating: REVİEW", "Rating: Hold\u0338", "Rating: We consider Buy or Sell"])("rejects a false trailing REVIEW after the Python-authoritative %s", async (first) => {
    const task = await changeQuality(await readinessFixture(), (quality) => { quality.rows.in_window = 0; });
    task.reportVersions[0].reportSections.final_trade_decision = `${first}\nRating: REVIEW`;
    expect((await verifySavedReadiness(task.reportVersions[0])).readinessValidation?.reason).toBe("reference_mismatch");
  });
  it("marks insufficient SMA200 history separately from valid completed price rows", async () => {
    const task = await changeQuality(await changeMarketRows(await readinessFixture(), (table) => { table.rows = table.rows.slice(-60); }), (quality) => {
      quality.rows.received = quality.rows.in_window = quality.rows.valid = quality.rows.usable_complete = 60;
      for (const item of Object.values(quality.indicator_assessments)) { item.usable_rows = 60; if (item.required_rows! > 60) { item.status = "insufficient_warmup"; item.value = null; } }
    });
    expect(task.researchReadiness!.checks[1].status).toBe("passed");
    expect(task.researchReadiness!.checks[2].reason_codes).toContain("insufficient_indicator_history");
    expect((await verifyResearchReadiness(task.researchReadiness, task.evidenceBundle)).status).toBe("review_required");
  });
  it("rejects a rehashed SMA200 minimum of one row", async () => {
    const task = await changeQuality(await readinessFixture(), (quality) => { quality.indicator_assessments.close_200_sma.required_rows = 1; });
    expect(task.researchReadiness!.checks[1].reason_codes).toContain("verification_quality_unknown");
    const falsePass = (await readinessFixture()).researchReadiness!;
    falsePass.evidence_inputs = task.researchReadiness!.evidence_inputs;
    falsePass.checks = falsePass.checks.map((check) => ({ ...check, evidence_ids: task.researchReadiness!.checks.find((item) => item.key === check.key)!.evidence_ids, artifact_sha256s: task.researchReadiness!.checks.find((item) => item.key === check.key)!.artifact_sha256s }));
    await expect(verifyResearchReadiness(await component(falsePass, "assessment_sha256"), task.evidenceBundle)).rejects.toThrow("reference_mismatch");
  });
  it.each(["2025-02-14T11:59:59.999999Z", "2025-02-15T00:00:00.000000Z", "2025-02-14T12:00:03.000001Z"])("preserves exact microsecond availability for %s", async (observed) => {
    const task = await changeQuality(await readinessFixture(), (quality) => { quality.observed_at = observed; });
    expect(task.researchReadiness!.checks[1].reason_codes).toContain("verification_quality_unknown");
    await expect(verifyResearchReadiness(task.researchReadiness, task.evidenceBundle)).resolves.toBeDefined();
  });
  it("does not promote an eight-day data outage to verified session coverage", async () => {
    const task = await changeQuality(await changeMarketRows(await readinessFixture(), (table) => { table.rows = providerTable(300, "2025-02-06").rows; }), (quality) => { quality.rows.latest_received_date = quality.rows.latest_usable_date = "2025-02-06"; });
    expect(task.researchReadiness!.checks[1].reason_codes).toContain("stale_or_unknown_session_coverage");
    expect(task.researchReadiness!.status).toBe("review_required");
  });
  it.each([false, true])("does not count an available source whose saved collection is empty (withheld=%s)", async (withheld) => {
    const task = await readinessFixture(), evidence = task.evidenceBundle!, source = evidence.records[0].sources[0], old = source.data_sha256!;
    const artifact = { kind: "normalized_data" as const, payload: canonicalJson({ columns: ["Date", "Close"], rows: [] }) };
    source.data_sha256 = await sha256(artifact); evidence.artifacts[source.data_sha256] = artifact; source.observed_window = null;
    if (withheld) source.historical_availability = "withheld";
    if (!evidence.records.some((record) => record.sources.some((item) => item.data_sha256 === old))) delete evidence.artifacts[old];
    const saved = await reassessTask(task);
    expect(saved.researchReadiness!.checks[3].reason_codes).toContain("unknown_source_provenance");
    expect(saved.researchReadiness!.checks[1].status).toBe("passed");
    await expect(verifyResearchReadiness(saved.researchReadiness, saved.evidenceBundle)).resolves.toMatchObject({ status: "review_required" });
  });
  it("keeps deliberately unselected market domains distinct from failed or empty sources", async () => {
    const task = await readinessFixture(); const policy = task.researchReadiness!.policy;
    policy.selected_analysts = ["news"]; policy.required_checks = ["temporal_availability", "market_verification", "indicator_warmup", "selected_sources.news"];
    const saved = await reassessTask(task);
    expect(saved.researchReadiness!.checks[1]).toMatchObject({ status: "not_selected", reason_codes: ["market_not_selected"] });
    expect(saved.researchReadiness!.checks[3].reason_codes).toContain("missing_selected_source");
    await expect(verifyResearchReadiness(saved.researchReadiness, saved.evidenceBundle)).resolves.toBeDefined();
  });
  it("binds frozen manifest scope, tool budget and policy digest", async () => {
    const task = await readinessFixture(); task.evidenceBundle!.manifest.max_tool_rounds = 99;
    await expect(verifyResearchReadiness(task.researchReadiness, await component(task.evidenceBundle!, "bundle_sha256"))).rejects.toThrow("reference_mismatch");
  });
  it("rejects cross-run input substitution and deep reference omissions", async () => {
    const task = await readinessFixture(); const readiness = task.researchReadiness!;
    readiness.run_id = "33333333-3333-4333-8333-333333333333";
    await expect(verifyResearchReadiness(await component(readiness, "assessment_sha256"), task.evidenceBundle)).rejects.toThrow("reference_mismatch");
    readiness.run_id = task.evidenceBundle!.run_id; readiness.evidence_inputs[0].data_sha256s = [];
    await expect(verifyResearchReadiness(await component(readiness, "assessment_sha256"), task.evidenceBundle)).rejects.toThrow("reference_mismatch");
  });
  it("validates both completed and final-state attachments before accepting an event", async () => {
    const task = await readinessFixture(); const nested = structuredClone(task.researchReadiness!); nested.assessment_sha256 = "a".repeat(64);
    const fields = await readinessFromEvent({ type: "completed", researchReadiness: task.researchReadiness, finalState: { research_readiness: nested } }, task.evidenceBundle);
    expect(fields?.readinessValidation?.reason).toBe("hash_mismatch");
    expect(fields?.researchReadiness).toBeUndefined();
  });
  it("retains explicit invalid state and treats contract absence as legacy unknown", async () => {
    const task = await readinessFixture(); delete task.researchReadiness; delete task.reportVersions[0].researchReadiness;
    expect(normalizeTaskReadiness(task).readinessValidation).toBeUndefined();
    task.readinessValidation = { status: "invalid", reason: "hash_mismatch" };
    expect(normalizeTaskReadiness(task).readinessValidation?.reason).toBe("hash_mismatch");
  });
});
