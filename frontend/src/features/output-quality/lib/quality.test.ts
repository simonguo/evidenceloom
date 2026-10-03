import { describe, expect, it } from "vitest";
import { createEmptyTask, defaultTaskDraft } from "@/lib/analysis";
import { buildOutputQualityView, mergeEventOutputQuality, normalizeOutputQuality, normalizeTaskOutputQuality } from "./quality";

const validated = { status: "validated_schema", schema: "ResearchPlan", source: "structured" } as const;
const fallback = {
  status: "unvalidated_text", schema: "PortfolioDecision", source: "raw_response", reason: "schema_validation_failed",
} as const;

describe("output format quality boundary", () => {
  it("copies only fixed agent/schema/status/source/reason combinations", () => {
    const input = {
      research_manager: { ...validated, error: "secret response", endpoint: "https://private.invalid" },
      portfolio_manager: { ...fallback, apiKey: "secret-key" },
      arbitrary_agent: { ...fallback },
    };
    const safe = normalizeOutputQuality(input);
    expect(safe).toEqual({ research_manager: validated, portfolio_manager: fallback });
    expect(safe?.research_manager).not.toBe(input.research_manager);
    expect(JSON.stringify(safe)).not.toMatch(/secret|private|endpoint|apiKey/);
  });

  it("rejects inconsistent success claims, unknown schemas and raw error reasons", () => {
    const invalid = [
      null, [], "validated_schema", {},
      { research_manager: { ...validated, schema: "UnknownSchema" } },
      { research_manager: { ...validated, source: "raw_response" } },
      { research_manager: { ...validated, reason: "no_tool_call" } },
      { portfolio_manager: { ...fallback, source: "structured" } },
      { portfolio_manager: { ...fallback, reason: "HTTP 401: secret-key at /private/path" } },
      { trader: { ...fallback } },
    ];
    for (const value of invalid) expect(normalizeOutputQuality(value)).toBeUndefined();
  });

  it("merges partial progress and final state metadata without sharing mutable records", () => {
    const progress = mergeEventOutputQuality(undefined, { type: "progress", outputQuality: { research_manager: validated } });
    const completed = mergeEventOutputQuality(progress, { type: "completed", finalState: { output_quality: { portfolio_manager: fallback } } });
    expect(completed).toEqual({ research_manager: validated, portfolio_manager: fallback });
    expect(completed?.research_manager).not.toBe(progress?.research_manager);
    expect(mergeEventOutputQuality(completed, { type: "stats" })).toEqual(completed);
  });

  it("keeps missing historical metadata distinct from validation success", () => {
    for (const value of [undefined, {}, { unknown: validated }]) {
      const view = buildOutputQualityView(value, "en");
      expect(view.entries).toEqual([]);
      expect(view.emptyMessage).toContain("was not recorded");
      expect(view.disclaimer).toContain("does not establish the accuracy");
    }
    const view = buildOutputQualityView({ research_manager: validated, portfolio_manager: fallback }, "zh");
    expect(view.hasUnvalidatedText).toBe(true);
    expect(view.entries.map((entry) => entry.status)).toEqual(["格式已验证", "文本回退 · 格式未验证"]);
    expect(view.disclaimer).toContain("不证明事实");
  });

  it("distinguishes a fresh free-text generation from retained raw text", () => {
    const view = buildOutputQualityView({
      trader: { status: "unvalidated_text", schema: "TraderProposal", source: "plain_generation", reason: "structured_unavailable" },
    }, "en");
    expect(view.entries[0].source).toBe("Free-text generation");
    expect(view.entries[0].reason).toBe("Structured output was unavailable.");
    expect(view.entries[0].validated).toBe(false);
  });

  it("explains unknown missing records even when a partial map contains validated output", () => {
    const partial = { research_manager: validated };
    expect(buildOutputQualityView(partial, "en").entries).toHaveLength(1);
    expect(buildOutputQualityView(partial, "en").disclaimer).toContain("structured validation cannot be confirmed for missing records");
    expect(buildOutputQualityView(partial, "zh").disclaimer).toContain("仅展示有记录的角色输出；未记录的输出无法确认结构化验证状态");
  });

  it("sanitizes persisted tasks and independently freezes version quality", () => {
    const task = createEmptyTask(defaultTaskDraft(), "quality-task");
    const normalized = normalizeTaskOutputQuality({
      ...task, outputQuality: { portfolio_manager: fallback },
      reportVersions: [{ id: "old-version", outputQuality: { research_manager: validated } } as never],
    });
    expect(normalized.outputQuality).toEqual({ portfolio_manager: fallback });
    expect(normalized.reportVersions[0].outputQuality).toEqual({ research_manager: validated });
    expect(normalized.reportVersions[0].outputQuality?.research_manager).not.toBe(validated);
  });
});
