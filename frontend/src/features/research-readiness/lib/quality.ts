import { day, exact, object, parsePayload, stamp, text, timestamp } from "@/features/memory/lib/guards";
import type { EvidenceBundle, EvidenceRecord } from "@/features/evidence/types";
import type { ResearchReadinessPolicy } from "../types";
import { indicatorWarmup } from "./policy";
import { assert } from "./validation-guards";
import { observedSources } from "./observed-sources";
import { validateMarketObservations } from "./market-inputs";

export type IndicatorAssessment = { status: "available" | "insufficient_warmup" | "unavailable_input" | "unsupported" | "calculation_failed"; required_rows: number | null; usable_rows: number; value: number | null };
export type MarketVerificationQuality = {
  kind: "market_verification_quality"; schema_version: 1; policy_version: "provider-daily-integrity-v1";
  symbol: string; analysis_date: string; observed_at: string; provider: string;
  source_timezone: string | null; timezone_origin: "timestamp" | "provider_metadata" | "symbol_market_convention" | "unknown";
  requested_window: { start: string | null; end: string };
  integrity_status: "valid" | "invalid" | "empty"; completion_status: "complete_provider_daily_rows" | "provisional" | "unknown" | "empty";
  completion_policy: "original_local_and_utc_dates_elapsed_midnight_daily_label";
  price_basis: { status: "observed" | "unknown"; value: string | null };
  revision_status: "unknown"; calendar_coverage_status: "unknown";
  rows: { received: number; in_window: number; valid: number; invalid: number; conflicting_duplicate_dates: string[]; identical_duplicates_collapsed: number; provisional: number; unknown_completion: number; usable_complete: number; latest_received_date: string | null; latest_usable_date: string | null };
  issues: string[]; indicator_assessments: Record<string, IndicatorAssessment>;
};
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1000000;
const providers = ["yfinance", "eastmoney", "tencent", "alpha_vantage", "akshare"];
const issueCodes = ["invalid_source_timestamp", "missing_or_nonfinite_open", "missing_or_nonfinite_high", "missing_or_nonfinite_low", "missing_or_nonfinite_close", "missing_or_nonfinite_volume", "negative_volume", "nonpositive_price", "incoherent_ohlc", "conflicting_duplicate_date", "provisional_daily_rows", "source_timezone_unknown", "price_basis_unknown"];
export function validateQuality(value: unknown, instrument: string, analysisDate: string): asserts value is MarketVerificationQuality {
  exact(value, ["kind", "schema_version", "policy_version", "symbol", "analysis_date", "observed_at", "provider", "source_timezone", "timezone_origin", "requested_window", "integrity_status", "completion_status", "completion_policy", "price_basis", "revision_status", "calendar_coverage_status", "rows", "issues", "indicator_assessments"]);
  assert(value.kind === "market_verification_quality" && value.schema_version === 1 && value.policy_version === "provider-daily-integrity-v1" && value.completion_policy === "original_local_and_utc_dates_elapsed_midnight_daily_label");
  assert(value.symbol === instrument && value.analysis_date === analysisDate && timestamp(value.observed_at) && /\.[0-9]{6}Z$/.test(value.observed_at) && providers.includes(String(value.provider)), "reference_mismatch");
  assert(value.source_timezone === null || text(value.source_timezone) && value.source_timezone.length > 0 && value.source_timezone.length <= 128);
  assert(["timestamp", "provider_metadata", "symbol_market_convention", "unknown"].includes(String(value.timezone_origin)));
  exact(value.requested_window, ["start", "end"]);
  assert((value.requested_window.start === null || day(value.requested_window.start)) && day(value.requested_window.end) && value.requested_window.end <= analysisDate && (value.requested_window.start === null || value.requested_window.start <= value.requested_window.end));
  assert(["valid", "invalid", "empty"].includes(String(value.integrity_status)) && ["complete_provider_daily_rows", "provisional", "unknown", "empty"].includes(String(value.completion_status)) && value.revision_status === "unknown" && value.calendar_coverage_status === "unknown");
  exact(value.price_basis, ["status", "value"]);
  assert(value.price_basis.status === "unknown" && value.price_basis.value === null || value.price_basis.status === "observed" && text(value.price_basis.value) && value.price_basis.value.length > 0 && value.price_basis.value.length <= 1024);
  exact(value.rows, ["received", "in_window", "valid", "invalid", "conflicting_duplicate_dates", "identical_duplicates_collapsed", "provisional", "unknown_completion", "usable_complete", "latest_received_date", "latest_usable_date"]);
  const rows = value.rows;
  const countKeys = ["received", "in_window", "valid", "invalid", "identical_duplicates_collapsed", "provisional", "unknown_completion", "usable_complete"];
  for (const key of countKeys) assert(count(rows[key]));
  const counts = rows as unknown as MarketVerificationQuality["rows"];
  assert(countKeys.every((key) => (counts[key as keyof typeof counts] as number) <= counts.received));
  assert(counts.usable_complete + counts.provisional + counts.unknown_completion === counts.valid);
  assert(Array.isArray(rows.conflicting_duplicate_dates) && rows.conflicting_duplicate_dates.every((date) => day(date) && date <= analysisDate) && JSON.stringify(rows.conflicting_duplicate_dates) === JSON.stringify([...new Set(rows.conflicting_duplicate_dates)].sort()));
  assert(rows.latest_received_date === null || day(rows.latest_received_date) && rows.latest_received_date <= analysisDate);
  assert(rows.latest_usable_date === null || day(rows.latest_usable_date) && rows.latest_usable_date <= analysisDate);
  assert(Boolean(counts.usable_complete) === (rows.latest_usable_date !== null) && (rows.latest_usable_date === null || rows.latest_received_date !== null && rows.latest_usable_date <= rows.latest_received_date));
  assert(value.integrity_status === (counts.invalid ? "invalid" : counts.valid ? "valid" : "empty"));
  assert(Array.isArray(value.issues) && value.issues.every((issue) => issueCodes.includes(String(issue))) && JSON.stringify(value.issues) === JSON.stringify([...new Set(value.issues)].sort()));
  assert(object(value.indicator_assessments) && Object.keys(value.indicator_assessments).length <= 128);
  for (const [name, indicator] of Object.entries(value.indicator_assessments)) {
    assert(text(name) && name.length >= 1 && name.length <= 128); exact(indicator, ["status", "required_rows", "usable_rows", "value"]);
    assert(["available", "insufficient_warmup", "unavailable_input", "unsupported", "calculation_failed"].includes(String(indicator.status)) && count(indicator.usable_rows));
    assert(indicator.required_rows === null || count(indicator.required_rows) && indicator.required_rows > 0);
    assert(indicator.required_rows === (indicatorWarmup[name] ?? (name === "vwma" ? 14 : null)) && indicator.usable_rows === counts.usable_complete);
    assert(indicator.value === null || typeof indicator.value === "number" && Number.isFinite(indicator.value));
    assert(indicator.status === "available" ? indicator.value !== null && indicator.required_rows !== null && indicator.usable_rows >= indicator.required_rows : indicator.value === null);
  }
}
export function qualitiesFor(record: EvidenceRecord, evidence: EvidenceBundle, policy: ResearchReadinessPolicy) {
  const qualities: MarketVerificationQuality[] = [];
  let malformed = false;
  const hashes = [...new Set(record.sources.flatMap((source) => source.data_sha256 ? [source.data_sha256] : []))].sort();
  for (const hash of hashes) {
    try {
      const data = parsePayload(evidence.artifacts[hash].payload);
      if (!object(data) || data.kind !== "market_verification_quality") continue;
      assert(record.sources.some((source) => source.data_sha256 === hash && source.provider === "local_calculation"));
      validateQuality(data, evidence.instrument, evidence.analysis_date);
      assert(stamp(data.observed_at) >= stamp(policy.research_started_at) && stamp(data.observed_at) <= stamp(policy.research_as_of) && stamp(data.observed_at) <= stamp(record.fetched_at));
      assert(observedSources(record, evidence).some((source) => source.provider === data.provider));
      validateMarketObservations(data, record, evidence);
      qualities.push(data);
    } catch { malformed = true; }
  }
  return { qualities, malformed };
}
