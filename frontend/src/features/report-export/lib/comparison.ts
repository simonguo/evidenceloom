import type { ReportVersion } from "@/lib/types";
import type { ComparedSection, ComparisonSelection, OriginalSection, ReportSectionKey } from "../comparison-types";

export const reportSectionKeys: readonly ReportSectionKey[] = [
  "market_report", "sentiment_report", "news_report", "fundamentals_report",
  "investment_plan", "trader_investment_plan", "final_trade_decision",
];

export function originalSection(reports: unknown, key: ReportSectionKey): OriginalSection {
  if (typeof reports !== "object" || reports === null || Array.isArray(reports)) return { state: "unsupported" };
  if (!Object.prototype.hasOwnProperty.call(reports, key)) return { state: "missing" };
  const value = (reports as Record<string, unknown>)[key];
  if (value === null) return { state: "null" };
  if (typeof value !== "string") return { state: "unsupported" };
  return { state: value === "" ? "empty" : /^\s+$/.test(value) ? "whitespace" : "text", value };
}

export function compareReportSections(baseline: ReportVersion, target: ReportVersion): ComparedSection[] {
  return reportSectionKeys.map((key) => {
    const left = originalSection(baseline.reportSections, key);
    const right = originalSection(target.reportSections, key);
    if (left.state === "unsupported" || right.state === "unsupported") return { key, status: "unavailable", baseline: left, target: right };
    const same = left.state === right.state
      && (!("value" in left) || ("value" in right && left.value === right.value));
    return { key, status: same ? "same" : "changed", baseline: left, target: right };
  });
}

export function hasDuplicateVersionIds(versions: readonly ReportVersion[]): boolean {
  return new Set(versions.map((version) => version.id)).size !== versions.length;
}

export function hasSelectableVersionId(version: ReportVersion): boolean {
  return typeof version?.id === "string" && version.id !== "";
}

export function newestReportVersions(versions: readonly ReportVersion[]): ReportVersion[] {
  const number = (version: ReportVersion) => typeof version.versionNumber === "number" && Number.isSafeInteger(version.versionNumber)
    ? version.versionNumber : 0;
  return [...versions].sort((left, right) => number(right) - number(left));
}

export function resolveComparisonSelection(
  taskId: string,
  versions: readonly ReportVersion[],
  previous?: ComparisonSelection,
): ComparisonSelection {
  const ordered = newestReportVersions(versions);
  const defaults = { taskId, baselineId: (ordered[1] ?? ordered[0])?.id ?? "", targetId: ordered[0]?.id ?? "" };
  if (previous?.taskId !== taskId) return defaults;
  return {
    taskId,
    baselineId: ordered.some((version) => version.id === previous.baselineId) ? previous.baselineId : defaults.baselineId,
    targetId: ordered.some((version) => version.id === previous.targetId) ? previous.targetId : defaults.targetId,
  };
}
