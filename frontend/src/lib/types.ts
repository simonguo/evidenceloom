export type AnalystKey = "market" | "social" | "news" | "fundamentals";
export type AssetType = "stock" | "crypto";
export type AgentStatus = "pending" | "in_progress" | "completed" | "error";
export type EventType = "started" | "progress" | "message" | "report" | "stats" | "completed" | "error";
export type TaskStatus = "idle" | "queued" | "running" | "completed" | "error" | "stopped";
export type SystemLanguage = "zh" | "en";

export type PublicSettings = {
  llmProvider: string;
  backendUrl: string;
  quickThinkLlm: string;
  deepThinkLlm: string;
  temperature: string;
  openaiReasoningEffort: string;
  googleThinkingLevel: string;
  anthropicEffort: string;
  coreStockApis: string;
  technicalIndicators: string;
  fundamentalData: string;
  newsData: string;
  newsArticleLimit: number;
  globalNewsArticleLimit: number;
  globalNewsLookbackDays: number;
  maxDebateRounds: number;
  maxRiskRounds: number;
  analystConcurrencyLimit: number;
  benchmarkTicker: string;
  checkpointEnabled: boolean;
  pythonPath: string;
  projectRoot: string;
  systemLanguage: SystemLanguage;
  providerConfigured: boolean;
  alphaVantageConfigured: boolean;
};

export type SessionSecrets = {
  apiKey: string;
  alphaVantageApiKey: string;
};

export type GlobalSettings = PublicSettings & SessionSecrets;

export type AnalysisForm = GlobalSettings & {
  ticker: string;
  analysisDate: string;
  assetType: AssetType;
  researchDepth: number;
  analysts: AnalystKey[];
  outputLanguage: string;
};

export type OhlcvBar = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type AnalysisStats = {
  llmCalls: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  elapsedSeconds: number;
};

export type LogEntry = {
  id: string;
  type: string;
  message: string;
  timestamp: string;
  agent?: string;
};

export type AnalysisTask = {
  id: string;
  ticker: string;
  instrumentName: string;
  analysisDate: string;
  assetType: AssetType;
  researchDepth: number;
  analysts: AnalystKey[];
  outputLanguage: string;
  status: TaskStatus;
  queuedAt: string;
  queueOrder: number | null;
  createdAt: string;
  updatedAt: string;
  decision: string;
  stats: AnalysisStats;
  agentStatuses: Record<string, AgentStatus>;
  reportSections: Record<string, string | null>;
  logs: LogEntry[];
  error: string;
};

export type NewTaskDraft = {
  ticker: string;
  instrumentName: string;
  analysisDate: string;
  assetType: AssetType;
  researchDepth: number;
  analysts: AnalystKey[];
  outputLanguage: string;
};

export type ResolvedInstrumentAlternative = {
  ticker: string;
  displayName: string;
  assetType: AssetType;
  quoteType: string;
  exchange: string;
  market: string;
  confidence: number;
  reason: string;
};

export type ResolvedInstrument = ResolvedInstrumentAlternative & {
  query: string;
  alternatives: ResolvedInstrumentAlternative[];
};

export type AnalysisEvent = {
  type: EventType;
  timestamp?: string;
  message?: string;
  messageType?: string;
  agentStatuses?: Record<string, AgentStatus>;
  reportSections?: Record<string, string | null>;
  stats?: AnalysisStats;
  decision?: string;
  finalState?: Record<string, unknown>;
  error?: string;
  agent?: string;
};

export type AnalystLabelKey = "market" | "sentiment" | "news" | "fundamentals";

export const analystOptions: Array<{ key: AnalystKey; labelKey: AnalystLabelKey; descriptionKey: `${AnalystLabelKey}Description` }> = [
  { key: "market", labelKey: "market", descriptionKey: "marketDescription" },
  { key: "social", labelKey: "sentiment", descriptionKey: "sentimentDescription" },
  { key: "news", labelKey: "news", descriptionKey: "newsDescription" },
  { key: "fundamentals", labelKey: "fundamentals", descriptionKey: "fundamentalsDescription" },
];

export const agentTeams: Array<{ team: string; agents: string[] }> = [
  { team: "Analyst Team", agents: ["Market Analyst", "Sentiment Analyst", "News Analyst", "Fundamentals Analyst"] },
  { team: "Research Team", agents: ["Bull Researcher", "Bear Researcher", "Research Manager"] },
  { team: "Trading Team", agents: ["Trader"] },
  { team: "Risk Management", agents: ["Aggressive Analyst", "Neutral Analyst", "Conservative Analyst"] },
  { team: "Portfolio", agents: ["Portfolio Manager"] },
];

export const reportTitles: Record<string, string> = {
  market_report: "Market Analysis",
  sentiment_report: "Sentiment Analysis",
  news_report: "News Analysis",
  fundamentals_report: "Fundamentals Analysis",
  investment_plan: "Research Team Decision",
  trader_investment_plan: "Trading Team Plan",
  final_trade_decision: "Portfolio Decision",
};
