import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifact, component, memoryTask, reviewFor } from "../fixtures/test-data";
import { copyArtifact } from "./decision";
import { foldInstrument, parsePayload, stamp } from "./guards";
import { copyContextSnapshot } from "./context";
import { memoryFromEvent, normalizeTaskMemory, verifyMemoryBundle, verifyMemoryInventory, verifyReviewAttachment, verifySavedMemory } from "./validation";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe("immutable memory authority", () => {
  it("verifies independently generated Python hashes and preserves exact opaque precision", async () => {
    const task = memoryTask();
    const bundle = await verifyMemoryBundle(task.memoryBundle, task.evidenceBundle);
    expect(bundle).toEqual(task.memoryBundle);
    const prior = bundle.input_snapshot.decisions[0];
    const payload = prior.artifacts[prior.outcome!.facts_sha256!].payload;
    expect(payload).toContain("123.45678901234567"); expect(payload).toContain("1.0"); expect(payload).toContain("1e-07");
    expect(bundle.input_snapshot.context_artifact.payload).toContain(prior.reflection!.reflected_at);
    expect((await verifySavedMemory(task)).memoryValidation).toBeUndefined();
  });
  it.each(["run", "evidence", "context", "horizon", "benchmark"])("rejects a coherently rehashed %s binding mismatch", async (field) => {
    const task = memoryTask(); const evidence = task.evidenceBundle!;
    if (field === "run") evidence.run_id = "33333333-3333-4333-8333-333333333333";
    if (field === "evidence") task.memoryBundle!.evidence_bundle_sha256 = "a".repeat(64);
    if (field === "context") delete evidence.manifest.memory_input_sha256;
    if (field === "horizon") evidence.manifest.holding_period_days = 17;
    if (field === "benchmark") evidence.manifest.benchmark_ticker = "OTHER.TEST";
    expect((await verifySavedMemory(task)).memoryValidation?.reason).toBe("reference_mismatch");
  });
  it.each(["text", "rating"])("binds memory to exact selected report %s", async (field) => {
    const task = memoryTask(); const version = task.reportVersions[0];
    if (field === "text") version.reportSections.final_trade_decision += " changed";
    else version.decision = "Buy";
    expect((await verifySavedMemory(version)).memoryValidation?.reason).toBe("reference_mismatch");
  });
  it("checks both completed-event attachment locations before freezing a version", async () => {
    const task = memoryTask(); const other = structuredClone(task.memoryBundle!);
    other.persistence_status = "memory_only";
    const changed = await component(other, "bundle_sha256");
    const result = await memoryFromEvent({ type: "completed", memoryBundle: task.memoryBundle, finalState: { memory_bundle: changed } }, task.evidenceBundle);
    expect(result?.memoryValidation?.reason).toBe("reference_mismatch");
  });
  it("distinguishes legacy absence and visible invalid state", async () => {
    const task = memoryTask(); delete task.memoryBundle; delete task.evidenceBundle;
    expect(normalizeTaskMemory({ ...task, evaluationReviews: [] }).memoryValidation).toBeUndefined();
    const contradictory = { ...memoryTask(), memoryValidation: { status: "invalid", reason: "hash_mismatch" } as const };
    const invalid = await verifySavedMemory(contradictory);
    expect(invalid.memoryBundle).toBeUndefined(); expect(invalid.memoryValidation?.status).toBe("invalid");
    const corrupted = memoryTask(); corrupted.memoryBundle!.input_snapshot.context_artifact.payload += " alteration";
    expect((await verifySavedMemory(corrupted)).memoryValidation).toBeDefined();
  });
  it("rejects envelope numeric flags, extra fields, unreferenced artifacts and unsafe JSON leaf data", async () => {
    const task = memoryTask(); const changed = structuredClone(task.memoryBundle!);
    changed.decision_snapshot.contract.effective_history_parameters.auto_adjust = 0 as never;
    await expect(verifyMemoryBundle(changed, task.evidenceBundle)).rejects.toThrow("malformed");
    const unreferenced = await artifact("text", "Unreferenced data");
    const extra = structuredClone(task.memoryBundle!); extra.decision_snapshot.artifacts[unreferenced.sha256] = unreferenced;
    await expect(verifyMemoryBundle(extra, task.evidenceBundle)).rejects.toThrow("malformed");
    for (const payload of ['{"text":"C:\\\\private\\\\file"}', '{"Authorization":"Bearer fictional-secret"}', '{"url":"https://example.com/data?token=private"}', '{"constructor":{}}']) expect(() => copyArtifact({ kind: "canonical_json", payload, sha256: "a".repeat(64) })).toThrow("unsafe_content");
    expect(copyArtifact(await artifact("canonical_json", '{"text":"Decision:\\nFictional"}')).payload).toBe('{"text":"Decision:\\nFictional"}');
  });
  it("rejects duplicate JSON keys while hashing original numeric syntax", () => {
    expect(() => parsePayload('{"a":1,"\\u0061":2}')).toThrow("malformed");
    expect(() => parsePayload('{"a":1e999}')).toThrow("malformed");
    expect(parsePayload('{"price":1.0}')).toEqual({ price: 1 });
    expect(foldInstrument("ABC.ßİ")).toBe("abc.ßİ");
  });
  it.each(["password=[redacted]synthetic-credential", "password=[REDACTED]", "HTTPS://example.com/data", "https://EXAMPLE.com/data", "https://example.com:443/data", "https://example.com/data?", "https://example.com/data#", "+٠٨:٠٠"])("rejects noncanonical or unsafe cross-language input %s", async (value) => {
    if (value.startsWith("+")) {
      const task = memoryTask(); const changed = structuredClone(task.memoryBundle!);
      changed.decision_snapshot.contract.host_utc_offset = value;
      await expect(verifyMemoryBundle(changed, task.evidenceBundle)).rejects.toThrow("malformed");
    } else expect(() => copyArtifact({ kind: "text", payload: value, sha256: "a".repeat(64) })).toThrow("unsafe_content");
  });
  it("admits only an exact redaction placeholder and canonical public URL", () => {
    expect(copyArtifact({ kind: "text", payload: "password=[redacted]; https://example.com/data", sha256: "a".repeat(64) }).payload).toContain("[redacted]");
    expect(copyArtifact({ kind: "text", payload: "https://123.example.com/data", sha256: "a".repeat(64) }).payload).toBe("https://123.example.com/data");
  });
  it.each(["local", "internal", "localhost", "invalid", "test"])("rejects private DNS suffix %s even with a trailing dot", (suffix) => {
    expect(() => copyArtifact({ kind: "text", payload: `https://example.${suffix}./private`, sha256: "a".repeat(64) })).toThrow("unsafe_content");
  });
  it("compares temporal availability at microsecond precision", () => {
    expect(stamp("2025-02-13T12:01:00.000001Z") > stamp("2025-02-13T12:01:00Z")).toBe(true);
    const context = structuredClone(memoryTask().memoryBundle!.input_snapshot);
    context.selected_at = "2025-02-13T12:01:00.000000Z"; context.availability_cutoff = context.selected_at;
    context.decisions[0].reflection!.reflected_at = "2025-02-13T12:01:00.000001Z";
    expect(() => copyContextSnapshot(context)).toThrow("temporal_mismatch");
  });
  it("requires observed and reflected times, not only endpoint dates, before prior input", () => {
    const context = structuredClone(memoryTask().memoryBundle!.input_snapshot);
    context.decisions[0].outcome!.observed_at = "2025-02-14T12:00:00.000001Z";
    context.decisions[0].reflection!.reflected_at = "2025-02-14T12:00:00.000002Z";
    expect(() => copyContextSnapshot(context)).toThrow("temporal_mismatch");
  });
  it("validates exact inventory partition and later dated review identity", async () => {
    const task = memoryTask(); const review = await reviewFor(task.memoryBundle!.decision_snapshot);
    await expect(verifyReviewAttachment(review, task.memoryBundle)).resolves.toEqual(review);
    const event = { type: "memory_inventory", schema_version: 1, requested_ids: [review.decision_id], reviews: [review], missing_ids: [], timestamp: "12:00:00" };
    expect((await verifyMemoryInventory(event, [review.decision_id])).reviews[0]).toEqual(review);
    await expect(verifyMemoryInventory({ ...event, missing_ids: [review.decision_id] }, [review.decision_id])).rejects.toThrow("reference_mismatch");
    await expect(verifyMemoryInventory({ type: "ready" }, [review.decision_id])).rejects.toThrow("malformed");
    await expect(verifyMemoryInventory({ type: "memory_inventory", schema_version: 1, requested_ids: [], reviews: [], missing_ids: [] }, [])).rejects.toThrow("malformed");
  });
});
