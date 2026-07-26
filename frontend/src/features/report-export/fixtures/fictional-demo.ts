import type { AnalysisTask, ReportVersion, SystemLanguage } from "@/lib/types";

export const FICTIONAL_DEMO_TASK_ID = "evidenceloom-fictional-demo";
const createdAt = "2025-02-15T09:30:00.000Z";

const content = {
  zh: {
    instrumentName: "星帆材料（完全虚构）",
    outputLanguage: "中文",
    decision: "Hold",
    reports: {
      market_report: `**数据截止：2025-02-14（虚构）**

EVDM.TEST 在虚构的星港交易所收于 42.60，近 20 个交易日围绕 41.20–44.10 震荡。短期均线仍向上，但成交量只有虚构 20 日均值的 78%，不足以确认突破。

| 信号 | 虚构读数 | 解读 |
| --- | ---: | --- |
| 20 日区间 | 41.20–44.10 | 仍处箱体 |
| 相对成交量 | 0.78x | 突破可信度不足 |
| 波动率 | 24% | 中等 |`,
      sentiment_report: `**覆盖期间：2025-02-08 至 2025-02-14（虚构）**

虚构媒体“北辰通讯”对新产线持正面态度，但虚构论坛“星港议事板”主要担心交付延期。样本量仅 36 条，整体情绪为轻微乐观，置信度偏低。

| 方向 | 虚构来源 | 证据 |
| --- | --- | --- |
| 正面 | 北辰通讯 | 试产良率改善 |
| 负面 | 星港议事板 | 两家客户推迟验收 |`,
      news_report: `过去一周有两项完全虚构的事件：星帆材料宣布“云晶二号”试产；供应商“远潮化学”同时提示运输周期可能延长。前者改善中期产能预期，后者可能压缩下一季度交付窗口。`,
      fundamentals_report: `星帆材料的所有财务数字均为演示数据。虚构年度收入增长 12%，毛利率从 31% 降至 28%，现金覆盖短期债务 1.8 倍。增长仍在，但利润率下滑意味着估值扩张需要更强证据。

| 指标 | 虚构数值 |
| --- | ---: |
| 收入增速 | 12% |
| 毛利率 | 28% |
| 现金/短债 | 1.8x |`,
      investment_plan: `### Bull Researcher Analysis
新产线试产和收入增长支持中期上行，若放量突破 44.10，市场可能重新定价产能。

### Bear Researcher Analysis
毛利率下滑、交付风险和偏低成交量削弱了追涨理由；当前价格尚未证明突破。

### Research Manager Decision
**Recommendation**: Hold

**Rationale**: 上行催化与执行风险并存，现有证据不足以偏向任一侧。

**Strategic Actions**: 等待交付确认或价格放量突破箱体。`,
      trader_investment_plan: `**Action**: Hold

**Reasoning**: 当前缺少成交量和交付进展的双重确认。保留观察名单，不在箱体中部新增仓位。

FINAL TRANSACTION PROPOSAL: **HOLD**`,
      final_trade_decision: `### Aggressive Analyst Analysis
若新产线提前达产，44.10 上方可能出现快速重估。

### Conservative Analyst Analysis
交付延期与毛利率下降同时出现时，应优先保护资本。

### Neutral Analyst Analysis
用价格突破和客户验收作为两个独立触发器，可以降低单一叙事误导。

### Portfolio Manager Decision
**Rating**: Hold

**Executive Summary**: 暂不建立新仓位；等待虚构价格站稳 44.10 且交付得到确认。

**Investment Thesis**: 当前证据显示增长与执行风险大致平衡。报告行情截止于 2025-02-14，任何后续判断都必须先刷新数据。

**Time Horizon**: 4–8 weeks`,
    },
  },
  en: {
    instrumentName: "Vela Meridian Materials (Entirely Fictional)",
    outputLanguage: "English",
    decision: "Hold",
    reports: {
      market_report: `**Data cutoff: 2025-02-14 (fictional)**

EVDM.TEST closed at a fictional 42.60 on the fictional Aster Exchange and remained inside a 41.20–44.10 twenty-session range. Short averages slope upward, but volume is only 78% of the fictional twenty-day average.

| Signal | Fictional reading | Interpretation |
| --- | ---: | --- |
| 20-day range | 41.20–44.10 | Range intact |
| Relative volume | 0.78x | Breakout unconfirmed |
| Volatility | 24% | Moderate |`,
      sentiment_report: `**Coverage: 2025-02-08 to 2025-02-14 (fictional)**

The fictional Northstar Wire welcomed the pilot line, while the fictional Aster Board focused on delayed acceptance tests. With only 36 fictional observations, sentiment is mildly positive with low confidence.

| Direction | Fictional source | Evidence |
| --- | --- | --- |
| Positive | Northstar Wire | Pilot yield improved |
| Negative | Aster Board | Two customers delayed acceptance |`,
      news_report: `Two entirely fictional events occurred: Vela Meridian announced pilot production for “Cloudglass II,” while fictional supplier Far Tide Chemicals warned of longer shipping times. Capacity expectations improved, but the delivery window became less certain.`,
      fundamentals_report: `Every financial figure is fictional. Revenue grew 12%, gross margin declined from 31% to 28%, and cash covered short-term debt 1.8 times. Growth persists, but margin pressure raises the evidence threshold for valuation expansion.

| Metric | Fictional value |
| --- | ---: |
| Revenue growth | 12% |
| Gross margin | 28% |
| Cash / short debt | 1.8x |`,
      investment_plan: `### Bull Researcher Analysis
Pilot production and revenue growth support medium-term upside. A volume-backed move above 44.10 could reprice capacity.

### Bear Researcher Analysis
Margin compression, delivery risk, and weak volume make a breakout premature.

### Research Manager Decision
**Recommendation**: Hold

**Rationale**: Upside catalysts and execution risks remain balanced.

**Strategic Actions**: Wait for delivery confirmation or a volume-backed range breakout.`,
      trader_investment_plan: `**Action**: Hold

**Reasoning**: Neither volume nor delivery progress confirms a trade. Keep the instrument on a watchlist and avoid adding exposure in the middle of the range.

FINAL TRANSACTION PROPOSAL: **HOLD**`,
      final_trade_decision: `### Aggressive Analyst Analysis
Early ramp completion could create a rapid repricing above 44.10.

### Conservative Analyst Analysis
Delivery delays combined with margin pressure favor capital preservation.

### Neutral Analyst Analysis
Using price and customer acceptance as independent triggers reduces narrative risk.

### Portfolio Manager Decision
**Rating**: Hold

**Executive Summary**: Do not initiate a position. Wait for a fictional close above 44.10 and delivery confirmation.

**Investment Thesis**: Growth and execution evidence are balanced. Market data ends on 2025-02-14; any later decision must refresh the data first.

**Time Horizon**: 4–8 weeks`,
    },
  },
} as const;

export function getOrCreateFictionalDemoTask(
  tasks: AnalysisTask[],
  language: SystemLanguage,
): AnalysisTask {
  return tasks.find((task) => task.id === FICTIONAL_DEMO_TASK_ID)
    ?? createFictionalDemoTask(language);
}

export function createFictionalDemoTask(language: SystemLanguage): AnalysisTask {
  const localized = content[language];
  const stats = {
    llmCalls: 14,
    toolCalls: 9,
    tokensIn: 18420,
    tokensOut: 6370,
    elapsedSeconds: 96.4,
  };
  const reportSections = { ...localized.reports };
  const version: ReportVersion = {
    id: `fictional-demo-report-${language}-v1`,
    runId: `fictional-demo-run-${language}`,
    versionNumber: 1,
    createdAt,
    legacy: false,
    task: {
      ticker: "EVDM.TEST",
      instrumentName: localized.instrumentName,
      analysisDate: "2025-02-14",
      assetType: "stock",
      researchDepth: 1,
      analysts: ["market", "social", "news", "fundamentals"],
      outputLanguage: localized.outputLanguage,
    },
    run: {
      appVersion: "demo",
      llmProvider: "fictional-provider",
      quickThinkLlm: "fictional-quick-model",
      deepThinkLlm: "fictional-deep-model",
      coreStockApis: "fictional-aster-exchange",
      technicalIndicators: "fictional-aster-exchange",
      fundamentalData: "fictional-ledger",
      newsData: "fictional-newswire",
      maxDebateRounds: 1,
      maxRiskRounds: 1,
      benchmarkTicker: "FICTIONAL-100.TEST",
    },
    decision: localized.decision,
    stats,
    reportSections,
  };

  return {
    id: FICTIONAL_DEMO_TASK_ID,
    origin: "demo",
    ticker: "EVDM.TEST",
    instrumentName: localized.instrumentName,
    analysisDate: "2025-02-14",
    assetType: "stock",
    researchDepth: 1,
    analysts: ["market", "social", "news", "fundamentals"],
    outputLanguage: localized.outputLanguage,
    status: "completed",
    queuedAt: "",
    queueOrder: null,
    createdAt,
    updatedAt: createdAt,
    decision: localized.decision,
    stats,
    agentStatuses: {
      "Market Analyst": "completed",
      "Sentiment Analyst": "completed",
      "News Analyst": "completed",
      "Fundamentals Analyst": "completed",
      "Bull Researcher": "completed",
      "Bear Researcher": "completed",
      "Research Manager": "completed",
      Trader: "completed",
      "Aggressive Analyst": "completed",
      "Neutral Analyst": "completed",
      "Conservative Analyst": "completed",
      "Portfolio Manager": "completed",
    },
    reportSections,
    reportVersions: [version],
    logs: [{
      id: `fictional-demo-log-${language}`,
      type: "System",
      message: language === "zh"
        ? "已加载完全虚构的演示报告；没有调用模型或外部数据源。"
        : "Loaded an entirely fictional demo report without calling models or external data sources.",
      timestamp: "09:30:00",
    }],
    error: "",
  };
}
