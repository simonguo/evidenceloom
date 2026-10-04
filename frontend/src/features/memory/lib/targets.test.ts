import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@/features/evidence/lib/validation";
import type { DecisionSnapshot, EvaluationTarget } from "../types";
import { artifact, component, memoryTask } from "../fixtures/test-data";
import { targetMemoryFixture, targetMemoryReview, targetMemoryTask } from "../fixtures/target-memory";
import { copyContextSnapshot, renderMemoryContext } from "./context";
import { copyDecisionSnapshot, verifyDecisionSnapshot } from "./decision";
import { copyMemoryBundle, memoryFromEvent, verifyMemoryBundle, verifyReviewAttachment, verifySavedMemory } from "./validation";
import { deriveEvaluationTarget } from "./targets";
import { targetPolicyArtifact } from "./target-policy";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

async function changeFacts(snapshot: DecisionSnapshot, mutate: (payload: string) => string) {
  const saved = structuredClone(snapshot);
  const outcome = saved.outcome!;
  const previous = outcome.facts_sha256!;
  const changed = await artifact("canonical_json", mutate(saved.artifacts[previous].payload));
  delete saved.artifacts[previous];
  saved.artifacts[changed.sha256] = changed;
  saved.outcome = await component({ ...outcome, facts_sha256: changed.sha256 }, "outcome_sha256");
  if (saved.reflection) saved.reflection = await component({ ...saved.reflection, outcome_sha256: saved.outcome.outcome_sha256 }, "reflection_sha256");
  return component(saved, "snapshot_sha256");
}

async function sameRequestSnapshot(firstNumber: string, secondNumber = firstNumber): Promise<DecisionSnapshot> {
  const saved = structuredClone(targetMemoryFixture.available_snapshot) as unknown as DecisionSnapshot;
  if (saved.contract.schema_version !== 2) throw new Error();
  const binding = await component({
    ...saved.contract.target_binding,
    targets: [saved.contract.target_binding.targets[0], deriveEvaluationTarget("benchmark", saved.decision.instrument)] as [EvaluationTarget, EvaluationTarget],
  }, "binding_sha256");
  saved.contract = await component({ ...saved.contract, target_binding: binding, resolved_benchmark: saved.decision.instrument }, "contract_sha256");
  saved.decision = await component({ ...saved.decision, contract_sha256: saved.contract.contract_sha256 }, "decision_sha256");
  const oldOutcome = saved.outcome!;
  const facts = JSON.parse(saved.artifacts[oldOutcome.facts_sha256!].payload);
  facts.decision_sha256 = saved.decision.decision_sha256;
  facts.contract_sha256 = saved.contract.contract_sha256;
  facts.target_binding_sha256 = binding.binding_sha256;
  const first = canonicalJson(facts.sources[0]).replace(/"value":[^,}]+/, `"value":${firstNumber}`);
  const second = canonicalJson({ ...facts.sources[0], role: "benchmark", requested_symbol: saved.decision.instrument }).replace(/"value":[^,}]+/, `"value":${secondNumber}`);
  const factPayload = `{${Object.keys(facts).sort().map((key) => `${JSON.stringify(key)}:${key === "sources" ? `[${first},${second}]` : canonicalJson(facts[key])}`).join(",")}}`;
  const factArtifact = await artifact("canonical_json", factPayload);
  const calculation = JSON.parse(saved.artifacts[oldOutcome.calculation_sha256!].payload);
  calculation.contract_sha256 = saved.contract.contract_sha256;
  calculation.target_binding_sha256 = binding.binding_sha256;
  calculation.reference_subjects = binding.targets;
  calculation.endpoints[1] = { ...structuredClone(calculation.endpoints[0]), role: "benchmark", resolved_symbol: saved.decision.instrument };
  calculation.benchmark_return = calculation.raw_return;
  calculation.return_difference = 0;
  const calculationArtifact = await artifact("canonical_json", canonicalJson(calculation));
  delete saved.artifacts[oldOutcome.facts_sha256!];
  delete saved.artifacts[oldOutcome.calculation_sha256!];
  saved.artifacts[factArtifact.sha256] = factArtifact;
  saved.artifacts[calculationArtifact.sha256] = calculationArtifact;
  saved.outcome = await component({ ...oldOutcome, contract_sha256: saved.contract.contract_sha256, facts_sha256: factArtifact.sha256, calculation_sha256: calculationArtifact.sha256 }, "outcome_sha256");
  if (saved.reflection) saved.reflection = await component({ ...saved.reflection, outcome_sha256: saved.outcome.outcome_sha256 }, "reflection_sha256");
  return component(saved, "snapshot_sha256");
}

describe("frozen provider request targets", () => {
  it("accepts the independently generated v2 contract and preserves v1 context and opaque prices", async () => {
    const task = targetMemoryTask();
    expect(await verifyMemoryBundle(task.memoryBundle, task.evidenceBundle)).toEqual(targetMemoryFixture.bundle);
    expect(await verifyDecisionSnapshot(targetMemoryFixture.available_snapshot)).toEqual(targetMemoryFixture.available_snapshot);
    expect(await verifyReviewAttachment(await targetMemoryReview(), task.memoryBundle)).toEqual(await targetMemoryReview());
    const prior = task.memoryBundle!.input_snapshot.decisions[0];
    expect(prior.contract.schema_version).toBe(1);
    expect(task.memoryBundle!.input_snapshot.context_artifact.payload).toContain("Legacy completed reference: target was not frozen at research start");
    expect(JSON.stringify(targetMemoryFixture.available_snapshot)).toContain("123.45678901234567");
    expect(targetPolicyArtifact).toEqual(targetMemoryFixture.policy_artifact);
    const original = memoryTask();
    expect(await verifyMemoryBundle(original.memoryBundle, original.evidenceBundle)).toEqual(original.memoryBundle);
    expect(renderMemoryContext(original.ticker, original.memoryBundle!.input_snapshot.decisions)).toBe(original.memoryBundle!.input_snapshot.context_artifact.payload);
  });

  it.each([
    ["sh600000", "600000.SS", "venue_notation"],
    ["600000.SH", "600000.SS", "venue_notation"],
    ["sz000001", "000001.SZ", "venue_notation"],
    ["700.HK", "0700.HK", "venue_notation"],
    ["BTCUSD", "BTC-USD", "pair_notation"],
    ["EURUSD", "EURUSD=X", "pair_notation"],
    ["XAUUSD", "GC=F", "proxy"],
    ["US500", "^GSPC", "proxy"],
    ["  aapl\t", "AAPL", "exact"],
    ["FICT.UNKNOWN", "FICT.UNKNOWN", "exact"],
    ["600000", null, "unknown"],
    ["XAUUSD+", null, "unknown"],
    ["证券", null, "unknown"],
    ["0000700.HK", null, "unknown"],
    ["999.SH", null, "unknown"],
    ["SH60000", null, "unknown"],
    ["600000.UNKNOWN", null, "unknown"],
    ["AAPL.HK", null, "unknown"],
    ["600000.SS", "600000.SS", "exact"],
  ])("derives %s only within the frozen request-notation policy", (requested, resolved, relation) => {
    expect(deriveEvaluationTarget("instrument", requested!)).toEqual({ role: "instrument", requested_symbol: requested, request_symbol: resolved, relation });
  });

  it("rejects omitted target marker and prevents a marker/legacy contract downgrade", async () => {
    const task = targetMemoryTask();
    const evidence = structuredClone(task.evidenceBundle!);
    delete evidence.manifest.memory_target_binding_sha256;
    expect(() => copyMemoryBundle(task.memoryBundle, evidence)).toThrow("reference_mismatch");
    const old = memoryTask();
    old.evidenceBundle!.manifest.memory_target_binding_sha256 = "a".repeat(64);
    expect(() => copyMemoryBundle(old.memoryBundle, old.evidenceBundle)).toThrow("reference_mismatch");
    const stripped = { ...task, memoryBundle: undefined };
    expect((await verifySavedMemory(stripped)).memoryValidation?.reason).toBe("reference_mismatch");
    expect((await verifySavedMemory({ ...stripped, status: "running" })).memoryValidation).toBeUndefined();
    const hybrid = { ...task.reportVersions[0], memoryBundle: undefined, status: "running" } as unknown as typeof task.reportVersions[0];
    expect((await verifySavedMemory(hybrid)).memoryValidation?.reason).toBe("reference_mismatch");
  });

  it("validates every present event representation, including explicit null", async () => {
    const task = targetMemoryTask();
    const event = { type: "completed", memoryBundle: null, finalState: { memory_bundle: task.memoryBundle } } as never;
    expect((await memoryFromEvent(event, task.evidenceBundle))?.memoryValidation?.reason).toBe("malformed");
  });

  it("freezes both event representations before asynchronous hashes", async () => {
    const task = targetMemoryTask();
    const event = { type: "completed" as const, memoryBundle: task.memoryBundle, finalState: { memory_bundle: structuredClone(task.memoryBundle) } };
    const original = structuredClone(task.memoryBundle);
    let release!: () => void;
    let signal!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { signal = resolve; });
    let first = true;
    vi.stubGlobal("crypto", { subtle: { digest: async (...args: Parameters<typeof webcrypto.subtle.digest>) => {
      if (first) { first = false; signal(); await gate; }
      return webcrypto.subtle.digest(...args);
    } } });
    const result = memoryFromEvent(event, task.evidenceBundle);
    await entered;
    event.finalState.memory_bundle!.persistence_status = "memory_only";
    task.evidenceBundle!.manifest.benchmark_ticker = "MUTATED.TEST";
    release();
    expect((await result)?.memoryBundle).toEqual(original);
  });

  it.each(["relation", "start", "benchmark", "policy", "extra"])("rejects a false %s binding before trusting its hash", (field) => {
    const saved = structuredClone(targetMemoryFixture.bundle.decision_snapshot) as unknown as DecisionSnapshot;
    if (saved.contract.schema_version !== 2) throw new Error();
    const binding = saved.contract.target_binding;
    if (field === "relation") binding.targets[0].relation = "proxy";
    if (field === "start") binding.research_started_at = "2025-02-14T11:58:00.000000Z";
    if (field === "benchmark") binding.targets[1] = deriveEvaluationTarget("benchmark", "OTHER.TEST");
    if (field === "policy") binding.policy_artifact_sha256 = "a".repeat(64);
    if (field === "extra") Object.assign(binding, { current_selector: "OTHER.TEST" });
    expect(() => copyDecisionSnapshot(saved)).toThrow();
  });

  it.each(["requested_symbol", "resolved_symbol", "request_namespace", "relation", "role"])("rejects a coherently rehashed facts %s mismatch", async (key) => {
    const snapshot = structuredClone(targetMemoryFixture.available_snapshot) as unknown as DecisionSnapshot;
    const changed = await changeFacts(snapshot, (payload) => {
      const body = JSON.parse(payload);
      body.sources[0][key] = "OTHER.TEST";
      return canonicalJson(body);
    });
    await expect(verifyDecisionSnapshot(changed)).rejects.toThrow("reference_mismatch");
  });

  it.each([["1", "1.0"], ["1e-7", "0.0000001"], ["9007199254740992", "9007199254740993"]])("rejects distinct saved number lexemes %s/%s in one shared observation", async (first, second) => {
    await expect(verifyDecisionSnapshot(await sameRequestSnapshot(first, second))).rejects.toThrow("reference_mismatch");
  });

  it("accepts one shared observation and ignores JSON key order or whitespace without rewriting payloads", async () => {
    const snapshot = await sameRequestSnapshot("1e-7");
    const facts = snapshot.artifacts[snapshot.outcome!.facts_sha256!].payload;
    expect((await verifyDecisionSnapshot(snapshot)).artifacts[snapshot.outcome!.facts_sha256!].payload).toBe(facts);
    const reordered = await changeFacts(snapshot, (payload) => {
      const parsed = JSON.parse(payload);
      return JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()), null, 2);
    });
    await expect(verifyDecisionSnapshot(reordered)).resolves.toEqual(reordered);
  });

  it("groups numerically equivalent request parameters while retaining distinct observation number spellings", async () => {
    const snapshot = await sameRequestSnapshot("1");
    const changed = await changeFacts(snapshot, (payload) => {
      let index = 0;
      return payload.replace(/"request_parameters":\{/g, () => {
        const number = index++ === 0 ? "1e-07" : "0.0000001";
        return `"request_parameters":{"foo":${number},`;
      });
    });
    await expect(verifyDecisionSnapshot(changed)).rejects.toThrow("reference_mismatch");
    const same = await changeFacts(snapshot, (payload) =>
      payload.replace(/"request_parameters":\{/g, '"request_parameters":{"foo":1e-07,'));
    await expect(verifyDecisionSnapshot(same)).resolves.toEqual(same);
  });

  it("rejects unknown selector but preserves unsupported code as historical integrity, not arithmetic eligibility", async () => {
    const context = structuredClone(targetMemoryFixture.bundle.input_snapshot);
    expect(() => copyContextSnapshot({ ...context, selector_version: "recent-reflections-v3" })).toThrow();
    const saved = structuredClone(targetMemoryFixture.bundle.decision_snapshot) as unknown as DecisionSnapshot;
    saved.contract.evaluator_code_sha256 = "a".repeat(64);
    saved.contract = await component(saved.contract, "contract_sha256");
    saved.decision = await component({ ...saved.decision, contract_sha256: saved.contract.contract_sha256 }, "decision_sha256");
    const rehashed = await component(saved, "snapshot_sha256");
    expect(await verifyDecisionSnapshot(rehashed)).toEqual(rehashed);
  });
});
