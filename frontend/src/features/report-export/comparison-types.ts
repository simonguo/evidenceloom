export type ReportSectionKey = "market_report" | "sentiment_report" | "news_report" | "fundamentals_report"
  | "investment_plan" | "trader_investment_plan" | "final_trade_decision";

export type OriginalSection = { state: "missing" | "null" | "unsupported" } | {
  state: "empty" | "whitespace" | "text";
  value: string;
};

export type ComparedSection = {
  key: ReportSectionKey;
  status: "same" | "changed" | "unavailable";
  baseline: OriginalSection;
  target: OriginalSection;
};

export type ComparisonSelection = { taskId: string; baselineId: string; targetId: string };
