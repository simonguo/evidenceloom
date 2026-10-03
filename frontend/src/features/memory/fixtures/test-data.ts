import type { DecisionSnapshot, MemoryArtifact, ReviewAttachment } from "../types";
import { canonicalJson, sha256 } from "@/features/evidence/lib/validation";
import { createFictionalDemoTask } from "@/features/report-export/fixtures/fictional-demo";

export const memoryTask = () => createFictionalDemoTask("en", true);
export async function component<T extends object, K extends string>(value: T, key: K): Promise<T & Record<K, string>> {
  const body = Object.fromEntries(Object.entries(value).filter(([field]) => field !== key));
  return { ...value, [key]: await sha256(body) } as T & Record<K, string>;
}
export async function artifact(kind: MemoryArtifact["kind"], payload: string): Promise<MemoryArtifact> {
  return component({ kind, payload }, "sha256");
}
export async function reviewFor(snapshot: DecisionSnapshot, { reflection = true, price = "123.45678901234567", response = "Fictional later reflection." } = {}): Promise<ReviewAttachment> {
  const saved = structuredClone(snapshot);
  const facts = await artifact("canonical_json", `{"benchmark":1.0,"price":${price},"units":"native currencies"}`);
  const calculation = await artifact("canonical_json", '{"excess_return":0.011111111011111111,"raw_return":0.012345678901234567}');
  saved.outcome = await component({ schema_version: 1 as const, contract_sha256: saved.contract.contract_sha256,
    observed_at: "2025-02-20T12:00:00.000001Z", status: "available" as const, reason: null,
    facts_sha256: facts.sha256, calculation_sha256: calculation.sha256 }, "outcome_sha256");
  saved.artifacts[facts.sha256] = facts; saved.artifacts[calculation.sha256] = calculation;
  if (reflection) {
    const model = await artifact("canonical_json", canonicalJson({ model: "fictional-offline" }));
    const prompt = await artifact("text", "Recorded decision:\nFictional review of exact stored facts.");
    const answer = await artifact("text", response);
    saved.reflection = await component({ schema_version: 1 as const, outcome_sha256: saved.outcome.outcome_sha256,
      reflected_at: "2025-02-21T12:00:00.000002Z", model_context_sha256: model.sha256,
      prompt_sha256: prompt.sha256, response_sha256: answer.sha256 }, "reflection_sha256");
    for (const item of [model, prompt, answer]) saved.artifacts[item.sha256] = item;
  }
  return component({ schema_version: 1 as const, decision_id: saved.run_id,
    reviewed_at: reflection ? "2025-02-21T12:05:00.000000Z" : "2025-02-20T12:05:00.000000Z",
    snapshot: await component(saved, "snapshot_sha256") }, "attachment_sha256");
}
