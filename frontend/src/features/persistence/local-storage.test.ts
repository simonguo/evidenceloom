import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyTask, defaultGlobalSettings, defaultTaskDraft } from "@/lib/analysis";
import { createFictionalDemoTask } from "@/features/report-export/fixtures/fictional-demo";
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

  it("restores safe output quality while removing untrusted quality fields", () => {
    const task = createEmptyTask(defaultTaskDraft(), "quality-task");
    saveTasks([{
      ...task,
      outputQuality: {
        portfolio_manager: { status: "unvalidated_text", schema: "PortfolioDecision", source: "raw_response", reason: "schema_validation_failed", error: "private body" },
      } as never,
    }]);
    expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).not.toContain("private body");
    const [loaded] = loadTasks();
    expect(loaded.outputQuality?.portfolio_manager?.status).toBe("unvalidated_text");
    expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).not.toContain("private body");
  });

  it("filters task and frozen-version quality at write time without changing other fields", () => {
    const task = createFictionalDemoTask("en");
    const safe = {
      portfolio_manager: { status: "unvalidated_text", schema: "PortfolioDecision", source: "raw_response", reason: "no_tool_call" },
    };
    const dirty = {
      portfolio_manager: { ...safe.portfolio_manager, error: "sensitive-body", endpoint: "https://private.invalid" },
      research_manager: { status: "validated_schema", schema: "ResearchPlan", source: "raw_response" },
      trader: { status: "unvalidated_text", schema: "TraderProposal", source: "structured", reason: "no_tool_call" },
      unknown_agent: { error: "sensitive-body" },
    };
    const input = {
      ...task,
      outputQuality: dirty as never,
      reportVersions: [{ ...task.reportVersions[0], extraSnapshotMetadata: { retained: true }, outputQuality: dirty as never }],
    };
    saveTasks([input]);
    const raw = window.localStorage.getItem("evidenceloom.analysisTasks.v1")!;
    const [stored] = JSON.parse(raw);
    expect(raw).not.toMatch(/sensitive-body|private.invalid|unknown_agent/);
    expect(stored.outputQuality).toEqual(safe);
    expect(stored.reportVersions[0].outputQuality).toEqual(safe);
    expect(stored).toEqual(JSON.parse(JSON.stringify({ ...input, outputQuality: safe, reportVersions: [{ ...input.reportVersions[0], outputQuality: safe, numericReviews: [] }] })));
    expect(input.outputQuality).toBe(dirty);
  });

  it("omits contradictory quality and preserves legacy field absence before any load", () => {
    const legacy = { id: "old-task", custom: "retained" };
    saveTasks([legacy as never]);
    expect(JSON.parse(window.localStorage.getItem("evidenceloom.analysisTasks.v1")!)).toEqual([legacy]);

    const task = createFictionalDemoTask("en");
    saveTasks([{
      ...task,
      outputQuality: { portfolio_manager: { status: "validated_schema", schema: "PortfolioDecision", source: "raw_response" } } as never,
      reportVersions: [{ ...task.reportVersions[0], outputQuality: { trader: { status: "unvalidated_text", schema: "TraderProposal", source: "raw_response", reason: "secret error" } } as never }],
    }]);
    const [stored] = JSON.parse(window.localStorage.getItem("evidenceloom.analysisTasks.v1")!);
    expect(stored).not.toHaveProperty("outputQuality");
    expect(stored.reportVersions[0]).not.toHaveProperty("outputQuality");
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
