import fixture from "../../../../../tests/fixtures/evidence_bundle_v1.json";
import type { AnalysisTask } from "@/lib/types";
import type { EvidenceBundle, EvidenceRecord, JsonValue } from "@/features/evidence/types";
import { canonicalJson, sha256 } from "@/features/evidence/lib/validation";
import { createFictionalDemoTask } from "@/features/report-export/fixtures/fictional-demo";
import type { MarketVerificationQuality } from "../lib/quality";
import { indicatorWarmup, requiredChecks, requiredIndicators } from "../lib/policy";
import type { InputCheck, ResearchReadiness, ResearchReadinessPolicy } from "../types";
import { deriveChecks } from "../lib/checks";
import { deriveStatus } from "../lib/validation";

export async function component<T extends object, K extends string>(value: T, key: K): Promise<T & Record<K, string>> {
  const body = Object.fromEntries(Object.entries(value).filter(([field]) => field !== key));
  return { ...value, [key]: await sha256(body) } as T & Record<K, string>;
}
export function qualityFixture(instrument = "EVDM.TEST"): MarketVerificationQuality {
  return { kind: "market_verification_quality", schema_version: 1, policy_version: "provider-daily-integrity-v1", symbol: instrument,
    analysis_date: "2025-02-14", observed_at: "2025-02-14T12:00:02.000001Z", provider: "tencent", source_timezone: "UTC", timezone_origin: "timestamp",
    requested_window: { start: "2024-01-01", end: "2025-02-14" }, integrity_status: "valid", completion_status: "complete_provider_daily_rows",
    completion_policy: "original_local_and_utc_dates_elapsed_midnight_daily_label", price_basis: { status: "observed", value: "auto_adjust=True requested; actions=False" }, revision_status: "unknown", calendar_coverage_status: "unknown",
    rows: { received: 300, in_window: 300, valid: 300, invalid: 0, conflicting_duplicate_dates: [], identical_duplicates_collapsed: 0, provisional: 0, unknown_completion: 0, usable_complete: 300, latest_received_date: "2025-02-13", latest_usable_date: "2025-02-13" },
    issues: [], indicator_assessments: Object.fromEntries(requiredIndicators.map((name) => [name, { status: "available", required_rows: indicatorWarmup[name], usable_rows: 300, value: 123.45678901234567 }])) };
}
export function providerTable(count = 300, latest = "2025-02-13"): { columns: string[]; rows: JsonValue[][] } {
  const end = Date.parse(`${latest}T00:00:00Z`);
  return { columns: ["Date", "Open", "High", "Low", "Close", "Volume", "SourceTimestamp", "SourceTimezone", "SourceUTCOffset", "TimezoneOrigin"],
    rows: Array.from({ length: count }, (_, index) => {
      const date = new Date(end - (count - index - 1) * 86_400_000).toISOString().slice(0, 10), price = 100.12345678901235 + index * 0.1;
      return [`${date}T00:00:00`, price, price + 2, price - 2, price, 10_000, `${date}T00:00:00Z`, "UTC", "+00:00", "timestamp"];
    }) };
}
export async function changeMarketRows(task: AnalysisTask, change: (table: ReturnType<typeof providerTable>) => void): Promise<AnalysisTask> {
  const saved = structuredClone(task), evidence = saved.evidenceBundle!;
  const record = evidence.records.find((item) => item.tool === "get_verified_market_snapshot")!;
  const source = record.sources.find((item) => item.provider !== "local_calculation")!;
  const old = source.data_sha256!, table = JSON.parse(evidence.artifacts[old].payload) as ReturnType<typeof providerTable>;
  change(table);
  const artifact = { kind: "normalized_data" as const, payload: canonicalJson(table) }; source.data_sha256 = await sha256(artifact);
  evidence.artifacts[source.data_sha256] = artifact;
  const labels = table.rows.map((row) => String(row[0]).slice(0, 10)).sort();
  source.observed_window = labels.length ? { start: labels[0], end: labels.at(-1)! } : null;
  if (!evidence.records.some((item) => item.sources.some((input) => input.data_sha256 === old))) delete evidence.artifacts[old];
  return reassessTask(saved);
}
export async function readinessFixture(quality = qualityFixture()): Promise<AnalysisTask> {
  const task = createFictionalDemoTask("en");
  const evidence = structuredClone(fixture) as EvidenceBundle;
  const policy: ResearchReadinessPolicy = await component({ schema_version: 1 as const, policy_version: "research-readiness-v1" as const, selected_analysts: ["market" as const], required_checks: requiredChecks(["market"]),
    research_started_at: "2025-02-14T12:00:00.000000Z", research_as_of: evidence.research_as_of, research_calendar_date: "2025-02-14", host_utc_offset: "+00:00", temporal_mode: "same_host_date" as const, max_tool_rounds: 20, max_complete_row_age_days: 3 as const, required_indicators: [...requiredIndicators] }, "policy_sha256");
  const normalized = { kind: "normalized_data" as const, payload: canonicalJson(quality) }; const qualityHash = await sha256(normalized);
  const id = "ev-22222222222222222222222222222222";
  const text = { kind: "tool_text" as const, payload: `[E:${id}]\nFictional provider input only; no exchange-calendar or price-vintage proof.` }; const textHash = await sha256(text);
  evidence.artifacts[qualityHash] = normalized; evidence.artifacts[textHash] = text;
  const table = providerTable(), tableArtifact = { kind: "normalized_data" as const, payload: canonicalJson(table) }, tableHash = await sha256(tableArtifact);
  evidence.artifacts[tableHash] = tableArtifact;
  const provider = { ...structuredClone(evidence.records[0].sources[0]), data_sha256: tableHash, observed_window: { start: String(table.rows[0][0]).slice(0, 10), end: "2025-02-13" } };
  const record: EvidenceRecord = { ...structuredClone(evidence.records[0]), id, tool: "get_verified_market_snapshot", fetched_at: "2025-02-14T12:00:03.000000Z", output_sha256: textHash, parameters: { symbol: evidence.instrument, curr_date: evidence.analysis_date, look_back_days: "30" },
    sources: [provider, { provider: "local_calculation", url: null, observed_window: { start: "2024-01-01", end: "2025-02-13" }, publication_dates: null, historical_availability: "unknown", units: null, adjustments: null, transformations: ["Fictional offline quality fixture"], data_sha256: qualityHash }] };
  evidence.records.push(record);
  evidence.manifest = { ...evidence.manifest, max_tool_rounds: 20, research_readiness_policy_sha256: policy.policy_sha256 };
  evidence.manifest_sha256 = await sha256(evidence.manifest); evidence.citation_audit = {};
  const savedEvidence = await component(evidence, "bundle_sha256");
  const inputs = savedEvidence.records.map((row) => ({ record_id: row.id, output_sha256: row.output_sha256, data_sha256s: [...new Set(row.sources.flatMap((source) => source.data_sha256 ? [source.data_sha256] : []))].sort() })).sort((a, b) => a.record_id.localeCompare(b.record_id));
  const refs = (records: EvidenceRecord[]) => ({ evidence_ids: records.map((row) => row.id).sort(), artifact_sha256s: [...new Set(records.flatMap((row) => row.sources.flatMap((source) => source.data_sha256 ? [source.data_sha256] : [])))].sort() });
  const checks: InputCheck[] = [
    { key: "temporal_availability", required: true, status: "passed", reason_codes: [], ...refs(savedEvidence.records) },
    { key: "market_verification", required: true, status: "passed", reason_codes: [], ...refs([record]) },
    { key: "indicator_warmup", required: true, status: "passed", reason_codes: [], ...refs([record]) },
    { key: "selected_sources.market", required: true, status: "passed", reason_codes: [], ...refs(savedEvidence.records) },
    { key: "price_vintage", required: false, status: "unknown", reason_codes: ["unknown_price_vintage"], ...refs([record]) },
    { key: "exchange_calendar_coverage", required: false, status: "unknown", reason_codes: ["unknown_exchange_calendar"], ...refs([record]) },
  ];
  const readiness: ResearchReadiness = await component({ schema_version: 1 as const, run_id: evidence.run_id, instrument: evidence.instrument, analysis_date: evidence.analysis_date, policy, evidence_inputs: inputs, checks, status: "ready" as const, recommendation_allowed: true }, "assessment_sha256");
  const reports = { market_report: "Fictional complete provider inputs; all figures are offline fixtures.", final_trade_decision: "**Rating**: Hold\n**Investment Thesis**: Fictional balanced observations, not an investment recommendation." };
  const version = { ...task.reportVersions[0], task: { ...task.reportVersions[0].task, analysts: ["market" as const] }, runId: evidence.run_id, evidenceBundle: structuredClone(savedEvidence), researchReadiness: structuredClone(readiness), reportSections: { ...reports } };
  return { ...task, analysts: ["market"], evidenceBundle: savedEvidence, researchReadiness: readiness, reportSections: reports, reportVersions: [version] };
}
export async function reassessTask(task: AnalysisTask): Promise<AnalysisTask> {
  const saved = structuredClone(task); const evidence = saved.evidenceBundle!; const assessment = saved.researchReadiness!;
  assessment.policy = await component(assessment.policy, "policy_sha256");
  evidence.manifest.research_readiness_policy_sha256 = assessment.policy.policy_sha256;
  evidence.manifest.analysts = [...assessment.policy.selected_analysts]; evidence.manifest.max_tool_rounds = assessment.policy.max_tool_rounds;
  evidence.manifest_sha256 = await sha256(evidence.manifest);
  saved.evidenceBundle = await component(evidence, "bundle_sha256");
  assessment.evidence_inputs = [...evidence.records].sort((a,b) => a.id.localeCompare(b.id)).map((record) => ({ record_id: record.id, output_sha256: record.output_sha256, data_sha256s: [...new Set(record.sources.flatMap((source) => source.data_sha256 ? [source.data_sha256] : []))].sort() }));
  assessment.checks = deriveChecks(evidence, assessment.policy); assessment.status = deriveStatus(assessment.checks); assessment.recommendation_allowed = assessment.status === "ready";
  saved.researchReadiness = await component(assessment, "assessment_sha256");
  saved.analysts = [...assessment.policy.selected_analysts];
  if (!assessment.recommendation_allowed) { saved.decision = "REVIEW"; saved.reportSections.final_trade_decision = "**Rating**: REVIEW\nSaved input conditions require review; prior prose is exploratory."; }
  saved.reportVersions = [{ ...saved.reportVersions[0], task: { ...saved.reportVersions[0].task, analysts: [...saved.analysts] }, decision: saved.decision, reportSections: { ...saved.reportSections }, evidenceBundle: structuredClone(saved.evidenceBundle), researchReadiness: structuredClone(saved.researchReadiness) }];
  return saved;
}
export async function changeQuality(task: AnalysisTask, change: (value: MarketVerificationQuality) => void) {
  const saved = structuredClone(task); const evidence = saved.evidenceBundle!;
  const record = evidence.records.find((item) => item.tool === "get_verified_market_snapshot")!;
  const source = record.sources.find((item) => item.provider === "local_calculation")!;
  const previous = source.data_sha256!; const quality = JSON.parse(evidence.artifacts[previous].payload) as MarketVerificationQuality;
  change(quality); const next = { kind: "normalized_data" as const, payload: canonicalJson(quality) };
  source.data_sha256 = await sha256(next); evidence.artifacts[source.data_sha256] = next; delete evidence.artifacts[previous];
  return reassessTask(saved);
}
