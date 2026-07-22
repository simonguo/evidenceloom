import type { AgentStatus, TaskStatus } from "@/lib/types";
import type { I18nKey } from "@/lib/i18n";

export const agentStatusDotStyle: Record<AgentStatus, string> = {
  pending: "bg-zinc-600",
  in_progress: "bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.6)]",
  completed: "bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.45)]",
  error: "bg-rose-400 shadow-[0_0_18px_rgba(251,113,133,0.5)]",
};

export const agentStatusTextStyle: Record<AgentStatus, string> = {
  pending: "text-zinc-500",
  in_progress: "text-sky-300",
  completed: "text-emerald-300",
  error: "text-rose-300",
};

export const taskStatusStyle: Record<TaskStatus, string> = {
  idle: "border-slate-600/50 bg-zinc-800/50 text-zinc-300",
  queued: "border-amber-300/50 bg-amber-400/10 text-amber-100",
  running: "border-zinc-600 bg-zinc-900 text-zinc-100",
  completed: "border-emerald-300/50 bg-emerald-400/10 text-emerald-100",
  error: "border-rose-300/50 bg-rose-400/10 text-rose-100",
  stopped: "border-zinc-600/60 bg-zinc-800/40 text-zinc-300",
};

export const reportWorkflow: Array<{ key: string; agent: string; team: string }> = [
  { key: "market_report", agent: "Market Analyst", team: "Analyst Team" },
  { key: "sentiment_report", agent: "Sentiment Analyst", team: "Analyst Team" },
  { key: "news_report", agent: "News Analyst", team: "Analyst Team" },
  { key: "fundamentals_report", agent: "Fundamentals Analyst", team: "Analyst Team" },
  { key: "investment_plan", agent: "Research Manager", team: "Research Team" },
  { key: "trader_investment_plan", agent: "Trader", team: "Trading Team" },
  { key: "final_trade_decision", agent: "Portfolio Manager", team: "Portfolio" },
];

export const agentLabelKeys: Record<string, I18nKey> = {
  "Market Analyst": "marketAnalyst",
  "Sentiment Analyst": "sentimentAnalyst",
  "News Analyst": "newsAnalyst",
  "Fundamentals Analyst": "fundamentalsAnalyst",
  "Bull Researcher": "bullResearcher",
  "Bear Researcher": "bearResearcher",
  "Research Manager": "researchManager",
  Trader: "trader",
  "Aggressive Analyst": "aggressiveAnalyst",
  "Neutral Analyst": "neutralAnalyst",
  "Conservative Analyst": "conservativeAnalyst",
  "Portfolio Manager": "portfolioManager",
};

export const teamLabelKeys: Record<string, I18nKey> = {
  "Analyst Team": "analystTeamGroup",
  "Research Team": "researchTeam",
  "Trading Team": "tradingTeam",
  "Risk Management": "riskManagement",
  Portfolio: "portfolio",
};

export const teamMandateKeys: Record<string, I18nKey> = {
  "Analyst Team": "analystTeamMandate",
  "Research Team": "researchTeamMandate",
  "Trading Team": "tradingTeamMandate",
  "Risk Management": "riskManagementMandate",
  Portfolio: "portfolioMandate",
};

export const agentRoleKeys: Record<string, I18nKey> = {
  "Market Analyst": "roleMarketAnalyst",
  "Sentiment Analyst": "roleSentimentAnalyst",
  "News Analyst": "roleNewsAnalyst",
  "Fundamentals Analyst": "roleFundamentalsAnalyst",
  "Bull Researcher": "roleBullResearcher",
  "Bear Researcher": "roleBearResearcher",
  "Research Manager": "roleResearchManager",
  Trader: "roleTrader",
  "Aggressive Analyst": "roleAggressiveAnalyst",
  "Neutral Analyst": "roleNeutralAnalyst",
  "Conservative Analyst": "roleConservativeAnalyst",
  "Portfolio Manager": "rolePortfolioManager",
};

export const reportTitleKeys: Record<string, I18nKey> = {
  market_report: "marketAnalysis",
  sentiment_report: "sentimentAnalysis",
  news_report: "newsAnalysis",
  fundamentals_report: "fundamentalsAnalysis",
  investment_plan: "researchTeamDecision",
  trader_investment_plan: "tradingTeamPlan",
  final_trade_decision: "portfolioDecision",
};

export const decisionLabelKeys: Record<string, I18nKey> = {
  overweight: "decisionOverweight",
  underweight: "decisionUnderweight",
  neutral: "decisionNeutral",
  buy: "decisionBuy",
  sell: "decisionSell",
  hold: "decisionHold",
  long: "decisionLong",
  short: "decisionShort",
};
