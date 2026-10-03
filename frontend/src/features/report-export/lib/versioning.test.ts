import { describe, expect, it, vi } from "vitest";
import { createEmptyTask, defaultAnalysisForm, defaultTaskDraft } from "@/lib/analysis";
import type { AnalysisEvent } from "@/lib/types";
import {
  appendCompletedReportVersion,
  createRunContext,
  ensureLegacyReportVersion,
} from "./versioning";

describe("report versioning", () => {
  it("freezes one immutable version for a completed run", () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("run-1").mockReturnValueOnce("version-1") });
    const task = createEmptyTask(defaultTaskDraft(), "task-1", "2025-02-01T00:00:00.000Z");
    const context = createRunContext(defaultAnalysisForm());
    const completed: AnalysisEvent = {
      type: "completed",
      decision: "Hold",
      stats: { llmCalls: 2, toolCalls: 1, tokensIn: 10, tokensOut: 5, elapsedSeconds: 3 },
      reportSections: { market_report: "Frozen report" },
      outputQuality: {
        portfolio_manager: { status: "unvalidated_text", schema: "PortfolioDecision", source: "raw_response", reason: "schema_validation_failed" },
      },
    };

    const versioned = appendCompletedReportVersion(task, completed, context, "2025-02-02T00:00:00.000Z");
    const duplicate = appendCompletedReportVersion(versioned, completed, context, "2025-02-03T00:00:00.000Z");

    expect(versioned.reportVersions).toHaveLength(1);
    expect(versioned.reportVersions[0]).toMatchObject({
      id: "version-1",
      runId: "run-1",
      versionNumber: 1,
      decision: "Hold",
      reportSections: { market_report: "Frozen report" },
    });
    expect(duplicate.reportVersions).toEqual(versioned.reportVersions);
    expect(versioned.reportVersions[0].reportSections).not.toBe(completed.reportSections);
    expect(versioned.reportVersions[0].outputQuality).toEqual(completed.outputQuality);
    expect(versioned.reportVersions[0].outputQuality?.portfolio_manager).not.toBe(completed.outputQuality?.portfolio_manager);
    completed.outputQuality!.portfolio_manager = { status: "validated_schema", schema: "PortfolioDecision", source: "structured" };
    expect(versioned.reportVersions[0].outputQuality?.portfolio_manager?.status).toBe("unvalidated_text");
    vi.unstubAllGlobals();
  });

  it("does not version failed, stopped, empty, or demo runs", () => {
    const task = createEmptyTask(defaultTaskDraft(), "task-2");
    const context = createRunContext(defaultAnalysisForm(), "run-2");
    const errorEvent: AnalysisEvent = { type: "error", error: "failed", reportSections: { market_report: "draft" } };
    const emptyCompleted: AnalysisEvent = { type: "completed", reportSections: {} };
    const demo = { ...task, origin: "demo" as const };

    expect(appendCompletedReportVersion(task, errorEvent, context).reportVersions).toHaveLength(0);
    expect(appendCompletedReportVersion(task, emptyCompleted, context).reportVersions).toHaveLength(0);
    expect(appendCompletedReportVersion(demo, { type: "completed", reportSections: { market_report: "done" } }, context).reportVersions).toHaveLength(0);
  });

  it("creates sequential versions across separate runs", () => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("version-1").mockReturnValueOnce("version-2") });
    const task = createEmptyTask(defaultTaskDraft(), "task-3");
    const first = appendCompletedReportVersion(
      task,
      { type: "completed", reportSections: { market_report: "v1" } },
      createRunContext(defaultAnalysisForm(), "run-1"),
    );
    const second = appendCompletedReportVersion(
      { ...first, reportSections: {} },
      { type: "completed", reportSections: { market_report: "v2" } },
      createRunContext(defaultAnalysisForm(), "run-2"),
    );

    expect(second.reportVersions.map((version) => version.versionNumber)).toEqual([1, 2]);
    expect(second.reportVersions.map((version) => version.reportSections.market_report)).toEqual(["v1", "v2"]);
    vi.unstubAllGlobals();
  });

  it("backfills a legacy completed task exactly once", () => {
    const task = {
      ...createEmptyTask(defaultTaskDraft(), "legacy-task", "2025-01-01T00:00:00.000Z"),
      status: "completed" as const,
      updatedAt: "2025-01-02T00:00:00.000Z",
      reportSections: { final_trade_decision: "**Rating**: Hold" },
      decision: "Hold",
    };

    const migrated = ensureLegacyReportVersion(task);
    const secondPass = ensureLegacyReportVersion(migrated);

    expect(migrated.reportVersions).toHaveLength(1);
    expect(migrated.reportVersions[0]).toMatchObject({
      legacy: true,
      versionNumber: 1,
      run: null,
      createdAt: "2025-01-02T00:00:00.000Z",
    });
    expect(secondPass.reportVersions).toEqual(migrated.reportVersions);
    expect(migrated.reportVersions[0].outputQuality).toBeUndefined();
  });
});

it("freezes the backend's REVIEW and actual runtime provenance", () => {
  const task = createEmptyTask(defaultTaskDraft(), "task-runtime");
  const event: AnalysisEvent = {
    type: "completed", decision: "REVIEW", reportSections: { final_trade_decision: "Rating: Buy" },
    runSettings: { core_version: "core-test", llm_provider: "deepseek", tool_vendors: { get_news: "yfinance" } },
  };
  const versioned = appendCompletedReportVersion(task, event, createRunContext(defaultAnalysisForm(), "run-runtime"));
  expect(versioned.reportVersions[0]).toMatchObject({ decision: "REVIEW", run: {
    coreVersion: "core-test", llmProvider: "deepseek", toolVendors: { get_news: "yfinance" },
  } });
  event.runSettings!.tool_vendors!.get_news = "alpha_vantage";
  expect(versioned.reportVersions[0].run?.toolVendors?.get_news).toBe("yfinance");
});
