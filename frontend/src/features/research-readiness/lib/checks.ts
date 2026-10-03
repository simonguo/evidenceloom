import type { EvidenceBundle, EvidenceRecord } from "@/features/evidence/types";
import { stamp } from "@/features/memory/lib/guards";
import type { InputCheck, InputCheckStatus, ReadinessReason, ResearchReadinessPolicy } from "../types";
import { qualitiesFor } from "./quality";
import { observedSources } from "./observed-sources";

type Finding = [InputCheckStatus, ReadinessReason];
const precedence: InputCheckStatus[] = ["invalid", "unavailable", "missing", "partial", "unknown", "not_selected"];
export function recordRefs(records: EvidenceRecord[]) {
  return { evidence_ids: records.map((record) => record.id).sort(), artifact_sha256s: [...new Set(records.flatMap((record) => record.sources.flatMap((source) => source.data_sha256 ? [source.data_sha256] : [])))].sort() };
}
function check(key: string, required: boolean, records: EvidenceRecord[], findings: Finding[] = []): InputCheck {
  return { key, required, status: precedence.find((status) => findings.some(([value]) => value === status)) ?? "passed", reason_codes: [...new Set(findings.map(([, reason]) => reason))].sort(), ...recordRefs(records) };
}
function receiptFindings(record: EvidenceRecord): Finding[] {
  switch (record.status) {
    case "available": return [];
    case "unavailable": return [["unavailable", "provider_unavailable"]];
    case "withheld": return [["unavailable", "source_withheld"]];
    case "empty": return [["missing", "empty_observations"]];
    case "partial": return [["partial", "partial_observations"]];
  }
}
export function deriveChecks(evidence: EvidenceBundle, policy: ResearchReadinessPolicy): InputCheck[] {
  const records = [...evidence.records].sort((a, b) => a.id.localeCompare(b.id));
  const temporal: Finding[] = policy.temporal_mode !== "same_host_date" ? [["unknown", policy.temporal_mode === "historical_date_only" ? "historical_availability_unknown" : "future_analysis_date"]]
    : records.some((record) => stamp(record.fetched_at) > stamp(policy.research_as_of)) ? [["unknown", "historical_availability_unknown"]] : [];
  const checks = [check("temporal_availability", true, records, temporal)];
  const market = records.filter((record) => record.analyst === "market" && record.tool === "get_verified_market_snapshot" && record.parameters.curr_date === evidence.analysis_date && record.parameters.symbol === evidence.instrument);
  const marketFindings: Finding[] = []; const indicatorFindings: Finding[] = []; const bases = new Set<string>();
  if (!policy.selected_analysts.includes("market")) marketFindings.push(["not_selected", "market_not_selected"]);
  else if (!market.length) marketFindings.push(["missing", "missing_required_verification"]);
  else for (const record of market) {
    marketFindings.push(...receiptFindings(record));
    const { qualities, malformed } = qualitiesFor(record, evidence, policy);
    if (malformed || qualities.length !== 1) {
      marketFindings.push(["unknown", "verification_quality_unknown"]); indicatorFindings.push(["unknown", "verification_quality_unknown"]); continue;
    }
    const quality = qualities[0]; const rows = quality.rows;
    if (quality.integrity_status === "invalid") marketFindings.push(["invalid", "invalid_ohlcv"]);
    if (rows.conflicting_duplicate_dates.length) marketFindings.push(["invalid", "conflicting_daily_rows"]);
    if (quality.integrity_status === "empty") marketFindings.push(["missing", "empty_observations"]);
    if (rows.unknown_completion || quality.source_timezone === null || quality.timezone_origin === "unknown") marketFindings.push(["unknown", "unknown_bar_completion"]);
    if (!rows.usable_complete) marketFindings.push(rows.provisional ? ["partial", "provisional_daily_rows"] : ["unknown", "unknown_bar_completion"]);
    else if ((Date.parse(`${evidence.analysis_date}T00:00:00Z`) - Date.parse(`${rows.latest_usable_date}T00:00:00Z`)) / 86_400_000 > policy.max_complete_row_age_days) marketFindings.push(["unknown", "stale_or_unknown_session_coverage"]);
    if (quality.price_basis.status === "unknown") marketFindings.push(["unknown", "unknown_price_basis"]);
    else bases.add(quality.price_basis.value!);
    for (const name of policy.required_indicators) {
      const status = quality.indicator_assessments[name]?.status ?? "unavailable_input";
      if (status === "insufficient_warmup") indicatorFindings.push(["partial", "insufficient_indicator_history"]);
      else if (status === "unsupported") indicatorFindings.push(["partial", "unsupported_indicator"]);
      else if (status === "calculation_failed") indicatorFindings.push(["partial", "indicator_calculation_failed"]);
      else if (status === "unavailable_input") indicatorFindings.push(["unknown", "verification_quality_unknown"]);
    }
  }
  if (bases.size > 1) marketFindings.push(["unknown", "price_basis_conflict"]);
  checks.push(check("market_verification", true, market, marketFindings), check("indicator_warmup", true, market, [...marketFindings, ...indicatorFindings]));
  for (const analyst of policy.selected_analysts) {
    const selected = records.filter((record) => record.analyst === analyst); const findings = selected.flatMap(receiptFindings);
    if (!selected.length) findings.push(["missing", "missing_selected_source"]);
    else if (!selected.some((record) => record.status === "available" && observedSources(record, evidence).length)) findings.push(["unknown", "unknown_source_provenance"]);
    for (const record of selected) if (record.status === "available" && !observedSources(record, evidence).length) findings.push(["unknown", "unknown_source_provenance"]);
    checks.push(check(`selected_sources.${analyst}`, true, selected, findings));
  }
  checks.push(check("price_vintage", false, market, [["unknown", "unknown_price_vintage"]]), check("exchange_calendar_coverage", false, market, [["unknown", "unknown_exchange_calendar"]]));
  return checks;
}
