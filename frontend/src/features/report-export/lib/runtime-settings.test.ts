import { describe, expect, it } from "vitest";
import { defaultAnalysisForm } from "@/lib/analysis";
import type { RuntimeRunSettings } from "@/lib/types";
import { createRunContext } from "./versioning";
import { mergeRuntimeManifest } from "./runtime-settings";

describe("runtime report provenance", () => {
  it("records actual safe runner settings ahead of the submitted form", () => {
    const requested = createRunContext(defaultAnalysisForm(), "run-1").manifest;
    const result = mergeRuntimeManifest(requested, {
      core_version: "0.2.5+evidenceloom", upstream_revision: "8b22d43", llm_provider: "deepseek",
      quick_think_llm: "deepseek-flash", deep_think_llm: "deepseek-v4-pro",
      max_debate_rounds: 3, max_risk_discuss_rounds: 2,
      data_vendors: { core_stock_apis: "eastmoney,yfinance", news_data: "yfinance" },
      tool_vendors: { get_news: "alpha_vantage" }, temperature: .2, max_tokens: 2048,
    });
    expect(result).toMatchObject({ coreVersion: "0.2.5+evidenceloom", llmProvider: "deepseek",
      quickThinkLlm: "deepseek-flash", maxDebateRounds: 3, maxRiskRounds: 2,
      toolVendors: { get_news: "alpha_vantage" },
      runtimeRunSettings: { upstream_revision: "8b22d43", temperature: .2, max_tokens: 2048 },
    });
    expect(requested.llmProvider).toBe(defaultAnalysisForm().llmProvider);
  });

  it("never persists arbitrary keys, endpoints, local paths or vendor credentials", () => {
    const untrusted = {
      core_version: "test", backend_url: "https://user:secret@proxy/v1", api_key: "secret",
      results_dir: "/private/path", data_vendors: { core_stock_apis: "eastmoney,yfinance" },
      tool_vendors: { get_news: "https://proxy/?api_key=secret" },
    } as RuntimeRunSettings;
    const result = mergeRuntimeManifest(createRunContext(defaultAnalysisForm(), "run-1").manifest, untrusted);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private/path");
    expect(result.runtimeRunSettings).toEqual({ core_version: "test", data_vendors: { core_stock_apis: "eastmoney,yfinance" }, tool_vendors: {} });
  });
});
