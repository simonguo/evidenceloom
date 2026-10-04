import type { ReportRunManifest, ReportVersion, RuntimeRunSettings } from "@/lib/types";
import { sanitizeRuntimeSettings } from "./runtime-settings";

export function savedMetadataText(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function comparisonVersionLabel(version: ReportVersion, unknown: string): string {
  return Number.isSafeInteger(version.versionNumber) && version.versionNumber > 0
    ? `v${version.versionNumber}` : unknown;
}

export function comparisonMetadata(version: ReportVersion) {
  const task = record(version.task);
  const run = record(version.run);
  const id = savedMetadataText(version.id);
  const runId = savedMetadataText(version.runId);
  const createdAt = savedMetadataText(version.createdAt);
  const ticker = savedMetadataText(task?.ticker);
  const instrumentName = savedMetadataText(task?.instrumentName);
  const analysisDate = savedMetadataText(task?.analysisDate);
  const legacy = typeof version.legacy === "boolean" ? version.legacy : undefined;
  const rating = savedMetadataText(version.decision);
  const provider = savedMetadataText(run?.llmProvider);
  const quickModel = savedMetadataText(run?.quickThinkLlm);
  const deepModel = savedMetadataText(run?.deepThinkLlm);
  const unavailable = !id || !runId || !createdAt || !ticker || !analysisDate
    || legacy === undefined || !rating || !Number.isSafeInteger(version.versionNumber) || version.versionNumber <= 0
    || (task?.instrumentName !== undefined && typeof task.instrumentName !== "string")
    || (version.run !== null && (!run || !provider || !quickModel || !deepModel));
  return { id, runId, createdAt, ticker, instrumentName, analysisDate, legacy, rating, provider, quickModel, deepModel, unavailable };
}

/** Display only the public run fields, retaining valid saved literals without inspecting attachments. */
export function publicComparisonManifest(value: unknown): Partial<ReportRunManifest> | null {
  const run = record(value);
  if (!run) return null;
  const strings = ["appVersion", "coreVersion", "llmProvider", "quickThinkLlm", "deepThinkLlm", "coreStockApis",
    "technicalIndicators", "fundamentalData", "newsData", "benchmarkTicker"] as const;
  const numbers = ["maxDebateRounds", "maxRiskRounds", "holdingPeriodDays"] as const;
  const safe: Record<string, unknown> = {};
  for (const key of strings) if (typeof run[key] === "string") safe[key] = run[key];
  for (const key of numbers) if (typeof run[key] === "number" && Number.isFinite(run[key])) safe[key] = run[key];
  const vendors = record(run.toolVendors);
  if (vendors) safe.toolVendors = sanitizeRuntimeSettings({ tool_vendors: vendors as Record<string, string> }).tool_vendors;
  const settings = record(run.runtimeRunSettings);
  if (settings) safe.runtimeRunSettings = sanitizeRuntimeSettings(settings as RuntimeRunSettings);
  return safe as Partial<ReportRunManifest>;
}

export function recordedValidationReason(value: unknown): string | undefined {
  return savedMetadataText(record(value)?.reason);
}
