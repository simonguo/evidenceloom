import { describe, expect, it } from "vitest";
import type { ReportVersion } from "@/lib/types";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { compareReportSections, hasDuplicateVersionIds, originalSection, resolveComparisonSelection } from "./comparison";

const version = createFictionalDemoTask("en").reportVersions[0];
function saved(id: string, versionNumber: number, reports: ReportVersion["reportSections"] = {}): ReportVersion {
  return { ...version, id, versionNumber, reportSections: reports };
}

describe("original saved section comparison", () => {
  it("compares all seven original sections without changing the frozen source", () => {
    const baseline = saved("older", 1, Object.freeze({
      market_report: "  001.2300\r\n<script>untrusted</script>\r\n", sentiment_report: null,
      news_report: "", fundamentals_report: " \t\r\n", investment_plan: "same", final_trade_decision: "Hold",
    }));
    const target = saved("newer", 2, Object.freeze({
      market_report: "  001.2300\n<script>untrusted</script>\n", news_report: null,
      fundamentals_report: " \t\n", investment_plan: "same", trader_investment_plan: "", final_trade_decision: "Hold",
    }));
    Object.freeze(baseline); Object.freeze(target);
    const captured = JSON.stringify([baseline, target]);
    const result = compareReportSections(baseline, target);
    expect(result.map((section) => [section.key, section.status])).toEqual([
      ["market_report", "changed"], ["sentiment_report", "changed"], ["news_report", "changed"],
      ["fundamentals_report", "changed"], ["investment_plan", "same"], ["trader_investment_plan", "changed"], ["final_trade_decision", "same"],
    ]);
    expect(result[0].baseline).toEqual({ state: "text", value: baseline.reportSections.market_report });
    expect(result[1]).toMatchObject({ baseline: { state: "null" }, target: { state: "missing" } });
    expect(result[2]).toMatchObject({ baseline: { state: "empty", value: "" }, target: { state: "null" } });
    expect(result[3].baseline).toEqual({ state: "whitespace", value: " \t\r\n" });
    expect(JSON.stringify([baseline, target])).toBe(captured);
  });

  it.each([
    [{}, {}, "same"], [{}, { market_report: null }, "changed"],
    [{ market_report: null }, { market_report: null }, "same"], [{ market_report: null }, { market_report: "" }, "changed"],
    [{ market_report: "" }, { market_report: "" }, "same"], [{ market_report: "" }, { market_report: " " }, "changed"],
    [{ market_report: " " }, { market_report: "\t" }, "changed"], [{ market_report: "\t" }, { market_report: "\t" }, "same"],
    [{ market_report: "a\r\nb" }, { market_report: "a\nb" }, "changed"],
    [{ market_report: "a " }, { market_report: "a" }, "changed"],
    [{ market_report: "e\u0301" }, { market_report: "é" }, "changed"],
    [{ market_report: "1.2300" }, { market_report: "1.23" }, "changed"],
  ] as const)("retains literal and absence distinctions (%#)", (left, right, expected) => {
    expect(compareReportSections(saved("left", 1, left), saved("right", 2, right))[0].status).toBe(expected);
  });

  it("does not inherit section content from the prototype", () => {
    const reports = Object.create({ market_report: "not saved" }) as ReportVersion["reportSections"];
    expect(originalSection(reports, "market_report")).toEqual({ state: "missing" });
  });

  it.each([undefined, null, false, 12, "raw-container", [], ["string"]])("withholds unsupported section containers (%#)", (reports) => {
    expect(originalSection(reports, "market_report")).toEqual({ state: "unsupported" });
  });

  it.each([undefined, false, 12, { body: "untrusted-object" }, ["untrusted-array"]])("withholds non-string saved values without returning their content (%#)", (value) => {
    expect(originalSection({ market_report: value }, "market_report")).toEqual({ state: "unsupported" });
  });

  it("does not label matching corrupt values or containers as unchanged", () => {
    const malformed = { ...saved("malformed", 1), reportSections: null } as unknown as ReportVersion;
    expect(compareReportSections(malformed, malformed).map((section) => section.status)).toEqual(Array(7).fill("unavailable"));
    const malformedField = { ...saved("malformed-field", 2), reportSections: { market_report: 123 } } as unknown as ReportVersion;
    expect(compareReportSections(malformedField, saved("valid", 3, { market_report: "123" }))[0].status).toBe("unavailable");
  });
});

describe("task-owned comparison selection", () => {
  it("defaults to the two newest saved versions without sorting the caller's list", () => {
    const versions = [saved("old", 1), saved("new", 3), saved("middle", 2)];
    expect(resolveComparisonSelection("task", versions)).toEqual({ taskId: "task", baselineId: "middle", targetId: "new" });
    expect(versions.map((entry) => entry.id)).toEqual(["old", "new", "middle"]);
  });

  it("preserves independent choices when new saved versions arrive, including an explicit same-version choice", () => {
    const versions = [saved("old", 1), saved("new", 2), saved("arrived", 3)];
    const selection = { taskId: "task", baselineId: "old", targetId: "old" };
    expect(resolveComparisonSelection("task", versions, selection)).toEqual(selection);
  });

  it("resets ownership for another task even when version IDs collide", () => {
    const versions = [saved("old", 1), saved("new", 2)];
    expect(resolveComparisonSelection("another-task", versions, { taskId: "task", baselineId: "new", targetId: "old" }))
      .toEqual({ taskId: "another-task", baselineId: "old", targetId: "new" });
  });

  it("recovers absent selections while preserving a retained side", () => {
    const versions = [saved("old", 1), saved("new", 2), saved("latest", 3)];
    expect(resolveComparisonSelection("task", versions, { taskId: "task", baselineId: "removed", targetId: "old" }))
      .toEqual({ taskId: "task", baselineId: "new", targetId: "old" });
    expect(resolveComparisonSelection("task", [])).toEqual({ taskId: "task", baselineId: "", targetId: "" });
    expect(resolveComparisonSelection("task", [versions[0]])).toEqual({ taskId: "task", baselineId: "old", targetId: "old" });
  });

  it("identifies ambiguous saved IDs even when their runs and original text differ", () => {
    expect(hasDuplicateVersionIds([saved("duplicate", 1, { market_report: "one" }), saved("duplicate", 2, { market_report: "two" })])).toBe(true);
    expect(hasDuplicateVersionIds([saved("one", 1), saved("two", 2)])).toBe(false);
    expect(hasDuplicateVersionIds([])).toBe(false);
  });
});
