import { sha256 } from "@/features/evidence/lib/validation";
import type { ContextSnapshot, DecisionSnapshot } from "../types";
import { copyArtifact, copyDecisionSnapshot, verifyDecisionSnapshot } from "./decision";
import { assert, bounded, clone, exact, foldInstrument, hash, stamp, text, timestamp, verifyHash } from "./guards";

export function renderMemoryContext(instrument: string, decisions: DecisionSnapshot[], selector: ContextSnapshot["selector_version"] = "recent-reflections-v1"): string {
  const same = decisions.filter((item) => foldInstrument(item.decision.instrument) === foldInstrument(instrument));
  const cross = decisions.filter((item) => foldInstrument(item.decision.instrument) !== foldInstrument(instrument));
  return ([{ records: same, heading: `Past analyses of ${instrument} (most recent first):`, full: true }, { records: cross, heading: "Recent cross-instrument lessons:", full: false }]).filter(({ records }) => records.length).map(({ records, heading, full }) => [heading, ...records.map((item) => {
    const { decision, outcome, reflection, artifacts } = item; assert(outcome && reflection && outcome.calculation_sha256);
    const lines = [`Memory decision ${item.run_id} | ${decision.instrument} | ${decision.analysis_date} | ${decision.rating}`, "Research reference evaluation; not execution or realized strategy profit."];
    if (full) lines.push("Decision:", artifacts[decision.decision_text_sha256].payload);
    if (selector === "recent-reflections-v2") {
      if (item.contract.schema_version === 1) {
        lines.push("Legacy completed reference: target was not frozen at research start; request/entity alignment is unknown.");
      } else {
        for (const target of item.contract.target_binding.targets) {
          lines.push(`Frozen ${target.role} request: yfinance/yahoo_finance_ticker/${target.request_symbol}; relation: ${target.relation}; request only, not provider/entity confirmation.`);
        }
      }
    }
    lines.push(`Frozen benchmark: ${item.contract.resolved_benchmark}; horizon: ${item.contract.holding_period_days} common complete provider daily rows.`, `Outcome observed at: ${outcome.observed_at}`, "Saved calculation:", artifacts[outcome.calculation_sha256].payload, `Reflection completed at: ${reflection.reflected_at}`, artifacts[reflection.response_sha256].payload);
    return lines.join("\n");
  })].join("\n\n")).join("\n\n");
}

export function copyContextSnapshot(value: unknown): ContextSnapshot {
  bounded(value); exact(value, ["schema_version", "instrument", "selected_at", "research_cutoff", "availability_cutoff", "selector_version", "same_ticker_limit", "cross_ticker_limit", "decisions", "context_artifact", "raw_text_sha256", "context_sha256", "input_sha256"]);
  assert(value.schema_version === 1 && ["recent-reflections-v1", "recent-reflections-v2"].includes(String(value.selector_version)) && text(value.instrument) && value.instrument && timestamp(value.selected_at) && timestamp(value.research_cutoff) && timestamp(value.availability_cutoff));
  assert(stamp(value.availability_cutoff) === [stamp(value.selected_at), stamp(value.research_cutoff)].sort()[0], "temporal_mismatch");
  assert(hash(value.raw_text_sha256) && hash(value.context_sha256) && hash(value.input_sha256));
  for (const key of ["same_ticker_limit", "cross_ticker_limit"]) assert(typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= 0 && value[key] <= 128);
  assert(Array.isArray(value.decisions) && value.decisions.length <= 128);
  const decisions = value.decisions.map(copyDecisionSnapshot); const ids = new Set();
  for (const item of decisions) {
    assert(!ids.has(item.run_id) && item.outcome?.status === "available" && item.reflection); ids.add(item.run_id);
    assert(value.selector_version !== "recent-reflections-v1" || item.contract.schema_version === 1, "reference_mismatch");
    assert([item.decision.recorded_at, item.outcome.observed_at, item.reflection.reflected_at].every((time) => stamp(time) <= stamp(value.availability_cutoff as string)), "temporal_mismatch");
  }
  const same = decisions.filter((item) => foldInstrument(item.decision.instrument) === foldInstrument(value.instrument as string));
  const cross = decisions.filter((item) => foldInstrument(item.decision.instrument) !== foldInstrument(value.instrument as string));
  assert(same.length <= (value.same_ticker_limit as number) && cross.length <= (value.cross_ticker_limit as number));
  const order = (a: DecisionSnapshot, b: DecisionSnapshot) => {
    for (const [first, second] of [[stamp(a.reflection!.reflected_at), stamp(b.reflection!.reflected_at)], [stamp(a.decision.recorded_at), stamp(b.decision.recorded_at)], [a.run_id, b.run_id]]) { if (first !== second) return first < second ? 1 : -1; } return 0;
  };
  assert([...same.sort(order), ...cross.sort(order)].every((item, index) => item.run_id === decisions[index].run_id));
  const artifact = copyArtifact(value.context_artifact); assert(artifact.kind === "text" && artifact.payload === renderMemoryContext(value.instrument, decisions, value.selector_version as ContextSnapshot["selector_version"]), "reference_mismatch");
  return clone(value) as unknown as ContextSnapshot;
}
export async function verifyContextSnapshot(value: unknown): Promise<ContextSnapshot> {
  const context = copyContextSnapshot(value); await Promise.all(context.decisions.map(verifyDecisionSnapshot));
  await verifyHash(context as unknown as Record<string, unknown>, "input_sha256"); await verifyHash(context.context_artifact as unknown as Record<string, unknown>, "sha256");
  assert(await sha256(context.context_artifact.payload) === context.context_sha256, "hash_mismatch");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(context.context_artifact.payload));
  assert(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") === context.raw_text_sha256, "hash_mismatch"); return context;
}
