import { createTranslator } from "./i18n";
import type { AnalysisEvent, AnalysisForm, AnalysisStats, AnalysisTask, AnalystKey, AssetType, GlobalSettings, NewTaskDraft, SystemLanguage } from "./types";

export const initialStats: AnalysisStats = {
  llmCalls: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  elapsedSeconds: 0,
};

export const defaultGlobalSettings = (): GlobalSettings => ({
  llmProvider: "openai",
  backendUrl: "",
  quickThinkLlm: "gpt-5.4-mini",
  deepThinkLlm: "gpt-5.5",
  apiKey: "",
  temperature: "",
  openaiReasoningEffort: "",
  googleThinkingLevel: "",
  anthropicEffort: "",
  alphaVantageApiKey: "",
  coreStockApis: "eastmoney,yfinance",
  technicalIndicators: "yfinance",
  fundamentalData: "akshare,yfinance",
  newsData: "yfinance",
  newsArticleLimit: 20,
  globalNewsArticleLimit: 10,
  globalNewsLookbackDays: 7,
  maxDebateRounds: 0,
  maxRiskRounds: 0,
  analystConcurrencyLimit: 1,
  benchmarkTicker: "",
  checkpointEnabled: false,
  pythonPath: "",
  projectRoot: "",
  systemLanguage: "zh",
  providerConfigured: false,
  alphaVantageConfigured: false,
});

export const defaultTaskDraft = (): NewTaskDraft => ({
  ticker: "SPY",
  instrumentName: "SPDR S&P 500 ETF Trust",
  analysisDate: new Date().toISOString().slice(0, 10),
  assetType: "stock",
  researchDepth: 1,
  analysts: ["market", "social", "news", "fundamentals"],
  outputLanguage: "中文",
});

export const defaultAnalysisForm = (): AnalysisForm => ({
  ...defaultGlobalSettings(),
  ...defaultTaskDraft(),
});

export function normalizeGlobalSettings(parsed: Partial<AnalysisForm>): GlobalSettings {
  const defaults = defaultGlobalSettings();
  return {
    ...defaults,
    llmProvider: nonEmptyString(parsed.llmProvider, defaults.llmProvider),
    backendUrl: parsed.backendUrl ?? "",
    quickThinkLlm: nonEmptyString(parsed.quickThinkLlm, defaults.quickThinkLlm),
    deepThinkLlm: nonEmptyString(parsed.deepThinkLlm, defaults.deepThinkLlm),
    apiKey: parsed.apiKey ?? "",
    temperature: parsed.temperature ?? "",
    openaiReasoningEffort: parsed.openaiReasoningEffort ?? "",
    googleThinkingLevel: parsed.googleThinkingLevel ?? "",
    anthropicEffort: parsed.anthropicEffort ?? "",
    alphaVantageApiKey: parsed.alphaVantageApiKey ?? "",
    coreStockApis: parsed.coreStockApis ?? defaults.coreStockApis,
    technicalIndicators: parsed.technicalIndicators ?? defaults.technicalIndicators,
    fundamentalData: parsed.fundamentalData ?? defaults.fundamentalData,
    newsData: parsed.newsData ?? defaults.newsData,
    newsArticleLimit: positiveInt(parsed.newsArticleLimit, defaults.newsArticleLimit),
    globalNewsArticleLimit: positiveInt(parsed.globalNewsArticleLimit, defaults.globalNewsArticleLimit),
    globalNewsLookbackDays: positiveInt(parsed.globalNewsLookbackDays, defaults.globalNewsLookbackDays),
    maxDebateRounds: positiveInt(parsed.maxDebateRounds, defaults.maxDebateRounds),
    maxRiskRounds: positiveInt(parsed.maxRiskRounds, defaults.maxRiskRounds),
    analystConcurrencyLimit: positiveInt(parsed.analystConcurrencyLimit, defaults.analystConcurrencyLimit),
    benchmarkTicker: parsed.benchmarkTicker ?? "",
    checkpointEnabled: parsed.checkpointEnabled ?? false,
    pythonPath: parsed.pythonPath ?? "",
    projectRoot: parsed.projectRoot ?? "",
    systemLanguage: parsed.systemLanguage ?? "zh",
    providerConfigured: parsed.providerConfigured ?? false,
    alphaVantageConfigured: parsed.alphaVantageConfigured ?? false,
  };
}

function nonEmptyString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function positiveInt(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

export function createEmptyTask(draft: NewTaskDraft, id = crypto.randomUUID(), createdAt = new Date().toISOString()): AnalysisTask {
  const now = new Date().toISOString();
  return {
    id,
    origin: "analysis",
    ticker: normalizeTicker(draft.ticker),
    instrumentName: draft.instrumentName.trim(),
    analysisDate: draft.analysisDate,
    assetType: draft.assetType,
    researchDepth: draft.researchDepth,
    analysts: draft.analysts,
    outputLanguage: draft.outputLanguage,
    status: "idle",
    queuedAt: "",
    queueOrder: null,
    createdAt,
    updatedAt: now,
    decision: "",
    stats: initialStats,
    agentStatuses: {},
    reportSections: {},
    reportVersions: [],
    logs: [],
    error: "",
  };
}

export function buildRunForm(task: AnalysisTask, settings: GlobalSettings): AnalysisForm {
  const assetType = detectAssetType(task.ticker, task.assetType);
  return {
    ...settings,
    assetType,
    researchDepth: task.researchDepth,
    ticker: normalizeTicker(task.ticker),
    analysisDate: task.analysisDate,
    analysts: normalizeAnalystsForAssetType(task.analysts, assetType),
    outputLanguage: task.outputLanguage,
  };
}

export function normalizeTicker(ticker: string) {
  return ticker.trim().toUpperCase();
}

export function inferInstrumentName(ticker: string) {
  const normalized = normalizeTicker(ticker);
  const names: Record<string, string> = {
    "002594.SZ": "比亚迪",
    "300750.SZ": "宁德时代",
    "300766.SZ": "每日互动",
    "600519.SS": "贵州茅台",
    "688503.SS": "聚和材料",
    AAPL: "Apple Inc.",
    MSFT: "Microsoft Corporation",
    NVDA: "NVIDIA Corporation",
    SPY: "SPDR S&P 500 ETF Trust",
    TSLA: "Tesla, Inc.",
    "BTC-USD": "Bitcoin USD",
    "ETH-USD": "Ethereum USD",
  };
  return names[normalized] ?? "";
}

export function detectAssetType(ticker: string, fallback: AssetType = "stock"): AssetType {
  const normalized = normalizeTicker(ticker);
  if (["-USD", "-USDT", "-USDC", "-BTC", "-ETH"].some((suffix) => normalized.endsWith(suffix))) return "crypto";
  return fallback;
}

export function normalizeAnalystsForAssetType(analysts: NewTaskDraft["analysts"], assetType: AssetType): AnalystKey[] {
  const normalized: AnalystKey[] = assetType === "crypto" ? analysts.filter((analyst) => analyst !== "fundamentals") : [...analysts];
  return normalized.length > 0 ? normalized : ["market"];
}

export function validateTaskDraft(draft: Pick<NewTaskDraft, "ticker" | "analysisDate" | "analysts">, assetType: AssetType, language: SystemLanguage = "zh") {
  const t = createTranslator(language);
  const errors: string[] = [];
  if (!draft.ticker.trim()) errors.push(t("tickerRequired"));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.analysisDate)) errors.push(t("invalidDateFormat"));
  if (new Date(draft.analysisDate) > new Date()) errors.push(t("dateCannotBeFuture"));
  const analysts = normalizeAnalystsForAssetType(draft.analysts, assetType);
  if (analysts.length === 0) errors.push(t("analystRequired"));
  return errors;
}

export function validateForm(form: AnalysisForm) {
  return validateTaskDraft({ ticker: form.ticker, analysisDate: form.analysisDate, analysts: form.analysts }, form.assetType, form.systemLanguage);
}

export async function streamAnalysis(
  form: AnalysisForm,
  onEvent: (event: AnalysisEvent) => void,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(form),
    signal,
  });

  if (!response.ok || !response.body) {
    const message = await response.text();
    throw new Error(message || `Request failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      onEvent(JSON.parse(line) as AnalysisEvent);
    }
  }

  if (buffer.trim()) {
    onEvent(JSON.parse(buffer) as AnalysisEvent);
  }
}
