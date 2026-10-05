import { day, exact, hash, offset, stamp, timestamp } from "@/features/memory/lib/guards";
import type { AnalystKey } from "@/lib/types";
import type { ResearchReadinessPolicy } from "../types";
import { assert } from "./validation-guards";

export const analysts: AnalystKey[] = ["market", "social", "news", "fundamentals"];
export const requiredChecks = (selected: AnalystKey[]) => ["temporal_availability", "market_verification", "indicator_warmup", ...selected.map((key) => `selected_sources.${key}`)];
export const advisoryChecks = ["price_vintage", "exchange_calendar_coverage"];
export const indicatorWarmup: Record<string, number> = { close_10_ema: 10, close_50_sma: 50, close_200_sma: 200, rsi: 15, boll: 20, boll_ub: 20, boll_lb: 20, macd: 26, macds: 34, macdh: 34, atr: 15 };
export const requiredIndicators = Object.keys(indicatorWarmup);
export function localCalendar(started: string, utcOffset: string) {
  const sign = utcOffset[0] === "-" ? -1 : 1;
  const [hours, minutes] = utcOffset.slice(1).split(":").map(Number);
  const value = new Date(started.slice(0, 19) + "Z").getTime() + sign * (hours * 60 + minutes) * 60_000;
  assert(Number.isFinite(value));
  const result = new Date(value).toISOString().slice(0, 10);
  assert(day(result), "temporal_mismatch");
  return result;
}
export function validatePolicy(value: unknown, analysisDate: string): asserts value is ResearchReadinessPolicy {
  exact(value, ["schema_version", "policy_version", "selected_analysts", "required_checks", "research_started_at", "research_as_of", "research_calendar_date", "host_utc_offset", "temporal_mode", "max_tool_rounds", "max_complete_row_age_days", "required_indicators", "policy_sha256"]);
  assert(value.schema_version === 1 && value.policy_version === "research-readiness-v1" && hash(value.policy_sha256));
  assert(Array.isArray(value.selected_analysts) && value.selected_analysts.length >= 1 && value.selected_analysts.every((key) => analysts.includes(key as AnalystKey)) && new Set(value.selected_analysts).size === value.selected_analysts.length);
  assert(JSON.stringify(value.required_checks) === JSON.stringify(requiredChecks(value.selected_analysts as AnalystKey[])), "reference_mismatch");
  assert(timestamp(value.research_started_at) && /\.[0-9]{6}Z$/.test(value.research_started_at) && timestamp(value.research_as_of) && value.research_as_of === `${analysisDate}T23:59:59.999999Z`);
  assert(day(value.research_calendar_date) && offset(value.host_utc_offset) && Number.isSafeInteger(value.max_tool_rounds) && (value.max_tool_rounds as number) >= 1 && (value.max_tool_rounds as number) <= 10000);
  const [offsetHours, offsetMinutes] = value.host_utc_offset.slice(1).split(":").map(Number);
  assert(offsetHours < 14 || offsetHours === 14 && offsetMinutes === 0);
  assert(value.host_utc_offset !== "-00:00");
  assert(value.max_complete_row_age_days === 3 && JSON.stringify(value.required_indicators) === JSON.stringify(requiredIndicators));
  assert(localCalendar(value.research_started_at, value.host_utc_offset) === value.research_calendar_date, "temporal_mismatch");
  const mode = analysisDate === value.research_calendar_date ? "same_host_date" : analysisDate < value.research_calendar_date ? "historical_date_only" : "future_date";
  assert(value.temporal_mode === mode, "temporal_mismatch");
  // Preserve microseconds when comparing with the separately frozen Memory start.
  stamp(value.research_started_at);
}
