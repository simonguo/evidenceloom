import fixture from "../../../../../tests/fixtures/memory_target_binding_v2.json";
import type { AnalysisTask, AssetType } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import type { DecisionSnapshot, MemoryBundle, ReviewAttachment } from "../types";
import { artifact, component, memoryTask } from "./test-data";
import { stamp } from "../lib/guards";
import { deriveEvaluationTarget } from "../lib/targets";
import { sha256 } from "@/features/evidence/lib/validation";
import { NumberLexeme, parseRawJson, rawObject, type RawJson } from "@/features/numeric-review/lib/raw-json";

export const targetMemoryFixture = fixture;

/** Exact Python-produced saved data; no evaluation or provider call occurs. */
export function targetMemoryTask(): AnalysisTask {
  const task = memoryTask();
  const memory = structuredClone(fixture.bundle) as unknown as MemoryBundle;
  const evidence = structuredClone(fixture.evidence) as unknown as EvidenceBundle;
  const decision = memory.decision_snapshot.decision;
  const assetType = decision.asset_type as AssetType;
  const sections = {
    ...task.reportSections,
    final_trade_decision: memory.decision_snapshot.artifacts[decision.decision_text_sha256].payload,
  };
  const version = {
    ...task.reportVersions[0],
    runId: memory.run_id,
    createdAt: decision.recorded_at,
    decision: decision.rating,
    task: { ...task.reportVersions[0].task, ticker: memory.instrument, analysisDate: memory.analysis_date, assetType },
    reportSections: structuredClone(sections),
    memoryBundle: structuredClone(memory),
    evidenceBundle: structuredClone(evidence),
    evaluationReviews: [],
    run: task.reportVersions[0].run ? {
      ...task.reportVersions[0].run,
      benchmarkTicker: memory.decision_snapshot.contract.resolved_benchmark,
      holdingPeriodDays: memory.decision_snapshot.contract.holding_period_days,
    } : null,
  };
  return {
    ...task, ticker: memory.instrument, analysisDate: memory.analysis_date,
    assetType, decision: decision.rating,
    reportSections: sections, memoryBundle: memory, evidenceBundle: evidence,
    evaluationReviews: [], reportVersions: [version],
  };
}

export async function targetMemoryReview(snapshot = structuredClone(fixture.available_snapshot) as unknown as DecisionSnapshot): Promise<ReviewAttachment> {
  const times = [snapshot.decision.recorded_at, snapshot.outcome?.observed_at, snapshot.reflection?.reflected_at]
    .filter((time): time is string => time !== undefined).map(stamp).sort();
  return component({
    schema_version: 1 as const,
    decision_id: snapshot.run_id,
    reviewed_at: times.at(-1)!,
    snapshot,
  }, "attachment_sha256");
}

export async function proxyTargetMemoryTask(runId = "33333333-3333-4333-8333-333333333333"): Promise<AnalysisTask> {
  const task = targetMemoryTask();
  const memory = task.memoryBundle!;
  const saved = memory.decision_snapshot;
  if (saved.contract.schema_version !== 2) throw new Error("Fictional fixture requires a v2 contract.");
  const binding = await component({
    ...saved.contract.target_binding,
    targets: [saved.contract.target_binding.targets[0], deriveEvaluationTarget("benchmark", "US500")] as typeof saved.contract.target_binding.targets,
  }, "binding_sha256");
  saved.contract = await component({ ...saved.contract, target_binding: binding, resolved_benchmark: "^GSPC" }, "contract_sha256");
  const manifest = { ...task.evidenceBundle!.manifest, benchmark_ticker: "^GSPC", memory_target_binding_sha256: binding.binding_sha256 };
  const frozenEvidence = await component({ ...task.evidenceBundle!, run_id: runId, manifest, manifest_sha256: await sha256(manifest) }, "bundle_sha256");
  saved.run_id = runId;
  saved.decision = await component({ ...saved.decision, run_id: runId, decision_id: runId, contract_sha256: saved.contract.contract_sha256, evidence_bundle_sha256: frozenEvidence.bundle_sha256 }, "decision_sha256");
  memory.decision_snapshot = await component(saved, "snapshot_sha256");
  const frozenMemory = await component({ ...memory, run_id: runId, evidence_bundle_sha256: frozenEvidence.bundle_sha256 }, "bundle_sha256");
  const version = task.reportVersions[0];
  return {
    ...task,
    id: "fictional-memory-proxy-task",
    memoryBundle: frozenMemory,
    evidenceBundle: frozenEvidence,
    reportVersions: [{
      ...version, id: "fictional-memory-proxy-version", runId, memoryBundle: structuredClone(frozenMemory), evidenceBundle: structuredClone(frozenEvidence),
      run: version.run ? { ...version.run, benchmarkTicker: "^GSPC" } : null,
    }],
  };
}

function savedJson(value: RawJson): string {
  if (value instanceof NumberLexeme) return value.raw;
  if (Array.isArray(value)) return `[${value.map(savedJson).join(",")}]`;
  if (rawObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${savedJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Rebind fictional saved metadata while retaining every opaque price lexeme. */
export async function targetMemoryReviewFor(task: AnalysisTask): Promise<ReviewAttachment> {
  const saved = structuredClone(fixture.available_snapshot) as unknown as DecisionSnapshot;
  const pending = task.memoryBundle!.decision_snapshot;
  if (pending.contract.schema_version !== 2) throw new Error("Fictional fixture requires a v2 contract.");
  const previous = saved.outcome!;
  saved.run_id = pending.run_id;
  saved.contract = structuredClone(pending.contract);
  saved.decision = structuredClone(pending.decision);
  const binding = pending.contract.target_binding;
  const facts = parseRawJson(saved.artifacts[previous.facts_sha256!].payload);
  const calculation = parseRawJson(saved.artifacts[previous.calculation_sha256!].payload);
  if (!rawObject(facts) || !rawObject(calculation) || !Array.isArray(facts.sources) || !Array.isArray(calculation.endpoints)) throw new Error("Invalid fictional source fixture.");
  facts.decision_sha256 = saved.decision.decision_sha256;
  facts.contract_sha256 = saved.contract.contract_sha256;
  facts.target_binding_sha256 = binding.binding_sha256;
  calculation.contract_sha256 = saved.contract.contract_sha256;
  calculation.target_binding_sha256 = binding.binding_sha256;
  calculation.reference_subjects = binding.targets as unknown as RawJson;
  calculation.interpretation = binding.targets.some((target) => target.relation === "proxy")
    ? "provider_proxy_reference_not_requested_asset_performance_or_realized_profit"
    : "provider_request_target_reference_not_entity_confirmation_or_realized_profit";
  for (const [index, target] of binding.targets.entries()) {
    const source = facts.sources[index], endpoint = calculation.endpoints[index];
    if (!rawObject(source) || !rawObject(endpoint)) throw new Error("Invalid fictional source fixture.");
    Object.assign(source, { requested_symbol: target.requested_symbol, resolved_symbol: target.request_symbol, relation: target.relation });
    endpoint.resolved_symbol = target.request_symbol;
  }
  const newFacts = await artifact("canonical_json", savedJson(facts));
  const newCalculation = await artifact("canonical_json", savedJson(calculation));
  delete saved.artifacts[previous.facts_sha256!];
  delete saved.artifacts[previous.calculation_sha256!];
  saved.artifacts[newFacts.sha256] = newFacts;
  saved.artifacts[newCalculation.sha256] = newCalculation;
  saved.outcome = await component({ ...previous, contract_sha256: saved.contract.contract_sha256, facts_sha256: newFacts.sha256, calculation_sha256: newCalculation.sha256 }, "outcome_sha256");
  return targetMemoryReview(await component(saved, "snapshot_sha256"));
}
