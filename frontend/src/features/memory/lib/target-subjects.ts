import { canonicalJson } from "@/features/evidence/lib/validation";
import { NumberLexeme, parseRawJson, rawObject, type RawJson } from "@/features/numeric-review/lib/raw-json";
import type { EvaluationContractV2 } from "../types";
import { assert, exact, MemoryError, object, parsePayload } from "./guards";

const factKeys = [
  "schema_version", "decision_sha256", "contract_sha256", "observation_cutoff",
  "sources", "limitations", "target_binding_sha256",
];
const sourceKeys = [
  "role", "provider", "requested_symbol", "resolved_symbol", "request_namespace",
  "relation", "request_parameters", "observed_at", "timezone", "currency",
  "publication_at", "price_vintage", "revision", "exchange_calendar_coverage", "rows", "issue",
];
const calculationKeys = [
  "schema_version", "contract_sha256", "target_binding_sha256", "reference_subjects",
  "entry_after_date", "entry_date", "exit_date", "holding_period_days", "holding_period_unit",
  "complete_instrument_dates", "complete_benchmark_dates", "common_complete_dates",
  "selected_common_dates", "endpoints", "raw_return", "benchmark_return", "return_difference",
  "raw_return_formula", "benchmark_return_formula", "difference_formula", "currency_policy", "interpretation",
];

function lexicalJson(value: RawJson): string {
  if (value instanceof NumberLexeme) return value.raw;
  if (Array.isArray(value)) return `[${value.map(lexicalJson).join(",")}]`;
  if (rawObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${lexicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSharedObservations(payload: string): void {
  let raw: RawJson;
  try {
    raw = parseRawJson(payload);
  } catch {
    throw new MemoryError();
  }
  assert(rawObject(raw) && Array.isArray(raw.sources));
  const observations = new Map<string, string>();
  for (const source of raw.sources) {
    assert(rawObject(source));
    // Physical request grouping follows parsed parameter values. The observation
    // body below deliberately retains the original JSON number spellings.
    const key = canonicalJson(JSON.parse(lexicalJson([
      source.provider, source.request_namespace, source.resolved_symbol, source.request_parameters,
    ])));
    const body = lexicalJson(Object.fromEntries(Object.entries(source)
      .filter(([field]) => !["role", "requested_symbol", "relation"].includes(field))));
    assert(!observations.has(key) || observations.get(key) === body, "reference_mismatch");
    observations.set(key, body);
  }
}

/** Saved subject references only; this does not independently replay arithmetic. */
export function assertTargetSubjects(
  decision: Record<string, unknown>,
  contract: EvaluationContractV2,
  outcome: unknown,
  artifacts: Record<string, unknown>,
): void {
  if (outcome === null) return;
  assert(object(outcome));
  const binding = contract.target_binding;
  if (outcome.facts_sha256 !== null) {
    const artifact = artifacts[String(outcome.facts_sha256)];
    assert(object(artifact) && typeof artifact.payload === "string", "reference_mismatch");
    const facts = parsePayload(artifact.payload);
    exact(facts, factKeys);
    assert(facts.schema_version === 2
      && facts.decision_sha256 === decision.decision_sha256
      && facts.contract_sha256 === contract.contract_sha256
      && facts.target_binding_sha256 === binding.binding_sha256, "reference_mismatch");
    assert(Array.isArray(facts.sources) && facts.sources.length === 2);
    for (const [index, target] of binding.targets.entries()) {
      const source = facts.sources[index];
      exact(source, sourceKeys);
      assert(source.role === target.role
        && source.provider === binding.provider
        && source.request_namespace === binding.request_namespace
        && source.requested_symbol === target.requested_symbol
        && source.resolved_symbol === target.request_symbol
        && source.relation === target.relation, "reference_mismatch");
    }
    assertSharedObservations(artifact.payload);
  }
  if (outcome.calculation_sha256 !== null) {
    const artifact = artifacts[String(outcome.calculation_sha256)];
    assert(object(artifact) && typeof artifact.payload === "string", "reference_mismatch");
    const calculation = parsePayload(artifact.payload);
    exact(calculation, calculationKeys);
    assert(calculation.schema_version === 2
      && calculation.contract_sha256 === contract.contract_sha256
      && calculation.target_binding_sha256 === binding.binding_sha256
      && canonicalJson(calculation.reference_subjects) === canonicalJson(binding.targets), "reference_mismatch");
    assert(Array.isArray(calculation.endpoints) && calculation.endpoints.length === 2);
    for (const [index, target] of binding.targets.entries()) {
      const endpoint = calculation.endpoints[index];
      exact(endpoint, ["role", "resolved_symbol", "entry", "exit"]);
      assert(endpoint.role === target.role && endpoint.resolved_symbol === target.request_symbol,
        "reference_mismatch");
    }
  }
}
