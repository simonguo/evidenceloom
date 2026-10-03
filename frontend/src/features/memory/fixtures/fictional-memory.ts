import memoryFixture from "../../../../../tests/fixtures/memory_bundle_v1.json";
import evidenceFixture from "../../../../../tests/fixtures/memory_evidence_bundle_v1.json";
import type { AnalysisTask } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import type { MemoryBundle } from "../types";

/** An offline, dated example. Its opaque numeric payloads are Python-generated. */
export function attachFictionalMemory(task: AnalysisTask): AnalysisTask {
  const memory = structuredClone(memoryFixture) as MemoryBundle;
  const evidence = structuredClone(evidenceFixture) as EvidenceBundle;
  const text = memory.decision_snapshot.artifacts[memory.decision_snapshot.decision.decision_text_sha256].payload;
  const reportSections = { ...task.reportSections, final_trade_decision: text };
  const version = { ...task.reportVersions[0], runId: memory.run_id, createdAt: memory.decision_snapshot.decision.recorded_at,
    reportSections: structuredClone(reportSections), memoryBundle: structuredClone(memory), evidenceBundle: structuredClone(evidence), evaluationReviews: [],
    run: task.reportVersions[0].run ? { ...task.reportVersions[0].run, benchmarkTicker: memory.decision_snapshot.contract.resolved_benchmark, holdingPeriodDays: memory.decision_snapshot.contract.holding_period_days } : null };
  return { ...task, reportSections, memoryBundle: memory, evidenceBundle: evidence, evaluationReviews: [], reportVersions: [version] };
}
