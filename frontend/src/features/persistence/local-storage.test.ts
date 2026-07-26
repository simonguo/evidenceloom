import { beforeEach, describe, expect, it } from "vitest";
import { defaultGlobalSettings } from "@/lib/analysis";
import {
  loadGlobalSettings,
  loadLegacyDesktopData,
  loadTasks,
  saveGlobalSettings,
  saveTasks,
  stripSecretFields,
} from "./local-storage";

describe("local settings persistence", () => {
  beforeEach(() => window.localStorage.clear());

  it("never persists API keys", () => {
    saveGlobalSettings({
      ...defaultGlobalSettings(),
      apiKey: "llm-secret",
      alphaVantageApiKey: "market-data-secret",
    });

    const raw = window.localStorage.getItem("evidenceloom.globalSettings.v1") ?? "";
    expect(raw).not.toContain("llm-secret");
    expect(raw).not.toContain("market-data-secret");
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("alphaVantageApiKey");
  });

  it("removes legacy web secrets instead of copying them to the new key", () => {
    window.localStorage.setItem("tradingagents.globalSettings.v1", JSON.stringify({
      ...defaultGlobalSettings(),
      apiKey: "legacy-secret",
    }));

    const settings = loadGlobalSettings();

    expect(settings.apiKey).toBe("");
    expect(window.localStorage.getItem("tradingagents.globalSettings.v1")).toBeNull();
    expect(window.localStorage.getItem("evidenceloom.globalSettings.v1")).not.toContain("legacy-secret");
  });

  it("migrates non-secret settings from the previous brand key", () => {
    window.localStorage.setItem("marketquorum.globalSettings.v1", JSON.stringify({
      ...defaultGlobalSettings(),
      quickThinkLlm: "gpt-5-mini",
    }));

    const settings = loadGlobalSettings();

    expect(settings.quickThinkLlm).toBe("gpt-5-mini");
    expect(window.localStorage.getItem("marketquorum.globalSettings.v1")).toBeNull();
    expect(window.localStorage.getItem("evidenceloom.globalSettings.v1")).toContain("gpt-5-mini");
  });

  it("keeps legacy desktop secrets available until the native migration succeeds", () => {
    window.localStorage.setItem("tradingagents.globalSettings.v1", JSON.stringify({
      ...defaultGlobalSettings(),
      apiKey: "legacy-secret",
    }));

    const legacy = loadLegacyDesktopData();

    expect(legacy.settings?.apiKey).toBe("legacy-secret");
    expect(window.localStorage.getItem("tradingagents.globalSettings.v1")).toContain("legacy-secret");
  });

  it("strips secret fields from Tauri IPC payloads", () => {
    expect(stripSecretFields({ apiKey: "one", alphaVantageApiKey: "two", ticker: "SPY" }))
      .toEqual({ ticker: "SPY" });
  });

  it("backfills a read-only v1 for legacy completed reports", () => {
    saveTasks([{
      id: "legacy-task",
      ticker: "SPY",
      instrumentName: "SPY",
      analysisDate: "2025-01-01",
      assetType: "stock",
      researchDepth: 1,
      analysts: ["market"],
      outputLanguage: "English",
      status: "completed",
      queuedAt: "",
      queueOrder: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-02T00:00:00.000Z",
      decision: "Hold",
      stats: { llmCalls: 1, toolCalls: 1, tokensIn: 1, tokensOut: 1, elapsedSeconds: 1 },
      agentStatuses: {},
      reportSections: { final_trade_decision: "**Rating**: Hold" },
      logs: [],
      error: "",
    } as never]);

    const [task] = loadTasks();

    expect(task.origin).toBe("analysis");
    expect(task.reportVersions).toHaveLength(1);
    expect(task.reportVersions[0].legacy).toBe(true);
  });
});
