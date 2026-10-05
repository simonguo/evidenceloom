import sharedPolicy from "../../../../../docs/contracts/numeric_review_policy_v1.json";
export const numericPolicy = Object.freeze(sharedPolicy);
export const numericPolicyHash = "0bef4bf9c45e94a4e850c054553cb7a80725b0873745d8187bc3de8cb87d52bf";
export const sectionKeys = ["market_report", "sentiment_report", "news_report", "fundamentals_report", "investment_plan", "trader_investment_plan", "final_trade_decision"];
export const contextKeys = ["instrument", "row_date", "units"] as const;
