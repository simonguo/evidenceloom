import type { ReportRunManifest, RuntimeRunSettings } from "@/lib/types";

const stringKeys = ["version", "core_version", "upstream_revision", "trade_date", "asset_type", "llm_provider", "quick_think_llm", "deep_think_llm", "output_language"] as const;
const numberKeys = ["max_debate_rounds", "max_risk_discuss_rounds", "max_tool_rounds", "analyst_concurrency_limit", "temperature", "max_tokens"] as const;

export function sanitizeRuntimeSettings(settings: RuntimeRunSettings): RuntimeRunSettings {
  const safe: RuntimeRunSettings = {};
  for (const key of stringKeys) {
    const value = settings[key];
    if (typeof value === "string" && value.trim()) safe[key] = value;
  }
  for (const key of numberKeys) {
    const value = settings[key];
    if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
  }
  if (Number.isSafeInteger(settings.holding_period_days) && (settings.holding_period_days ?? 0) > 0) safe.holding_period_days = settings.holding_period_days;
  if (typeof settings.benchmark_ticker === "string" && /^[A-Za-z0-9^=._-]{1,128}$/.test(settings.benchmark_ticker)) safe.benchmark_ticker = settings.benchmark_ticker;
  if (settings.temperature === null) safe.temperature = null;
  if (typeof settings.temperature === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(settings.temperature) && Number.isFinite(Number(settings.temperature))) {
    safe.temperature = settings.temperature;
  }
  if (Array.isArray(settings.analysts)) safe.analysts = settings.analysts.filter((value) => typeof value === "string");
  for (const key of ["data_vendors", "tool_vendors"] as const) {
    if (settings[key] && typeof settings[key] === "object") {
      safe[key] = Object.fromEntries(Object.entries(settings[key]).filter(
        ([name, value]) => /^[\w]+$/.test(name) && typeof value === "string" && /^[\w, -]+$/.test(value),
      ));
    }
  }
  return safe;
}

export function mergeRuntimeManifest(manifest: ReportRunManifest, settings?: RuntimeRunSettings): ReportRunManifest {
  if (!settings) return { ...manifest };
  const safe = sanitizeRuntimeSettings(settings);
  const vendors = safe.data_vendors;
  return {
    ...manifest,
    ...((safe.core_version ?? safe.version) ? { coreVersion: safe.core_version ?? safe.version } : {}),
    llmProvider: safe.llm_provider ?? manifest.llmProvider,
    quickThinkLlm: safe.quick_think_llm ?? manifest.quickThinkLlm,
    deepThinkLlm: safe.deep_think_llm ?? manifest.deepThinkLlm,
    coreStockApis: vendors?.core_stock_apis ?? manifest.coreStockApis,
    technicalIndicators: vendors?.technical_indicators ?? manifest.technicalIndicators,
    fundamentalData: vendors?.fundamental_data ?? manifest.fundamentalData,
    newsData: vendors?.news_data ?? manifest.newsData,
    maxDebateRounds: safe.max_debate_rounds ?? manifest.maxDebateRounds,
    maxRiskRounds: safe.max_risk_discuss_rounds ?? manifest.maxRiskRounds,
    benchmarkTicker: safe.benchmark_ticker ?? manifest.benchmarkTicker,
    ...(safe.holding_period_days !== undefined ? { holdingPeriodDays: safe.holding_period_days } : {}),
    toolVendors: { ...(safe.tool_vendors ?? {}) },
    runtimeRunSettings: safe,
  };
}
