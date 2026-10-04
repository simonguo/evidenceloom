import { describe, expect, it } from "vitest";
import type { ReportRunManifest, ReportVersion } from "@/lib/types";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { reportJson } from "./report-json";
import { comparisonMetadata, comparisonVersionLabel, publicComparisonManifest } from "./comparison-metadata";

const task = createFictionalDemoTask("en");
const version = task.reportVersions[0];

describe("saved comparison metadata projection", () => {
  it("matches the existing public run JSON fields and sanitized nested settings without exposing saved extensions", () => {
    const run = {
      ...version.run!, coreVersion: "literal-core", holdingPeriodDays: 12,
      toolVendors: { stock: "yfinance", private_url: "https://private.invalid/path" },
      runtimeRunSettings: { temperature: "0.1250", analysts: ["market"], llm_provider: "openai", max_tool_rounds: 4,
        privateExtension: "OWNED-PRIVATE-NESTED-SENTINEL", data_vendors: { core_stock_apis: "yfinance", private_url: "https://private.invalid/path" } },
      privateExtension: { body: "OWNED-PRIVATE-MANIFEST-SENTINEL" },
    } as ReportRunManifest;
    const before = JSON.stringify(run);
    const projected = publicComparisonManifest(run);
    expect(JSON.parse(JSON.stringify(projected))).toEqual(JSON.parse(JSON.stringify(reportJson(task.id, task.origin, { ...version, run }).report.run)));
    expect(projected?.runtimeRunSettings?.temperature).toBe("0.1250");
    expect(projected?.toolVendors).toEqual({ stock: "yfinance" });
    expect(JSON.stringify(projected)).not.toContain("SENTINEL");
    expect(JSON.stringify(projected)).not.toContain("private.invalid");
    expect(JSON.stringify(run)).toBe(before);
  });

  it("shows absent or unsupported metadata as unknown without coercing arbitrary saved objects", () => {
    const unsupported = { privateSentinel: "UNSUPPORTED-METADATA-BODY", toString: false, valueOf: false };
    const malformed = { ...version, task: null, runId: unsupported, createdAt: unsupported,
      legacy: unsupported, decision: unsupported, versionNumber: unsupported } as unknown as ReportVersion;
    const metadata = comparisonMetadata(malformed);
    expect(metadata.unavailable).toBe(true);
    for (const field of ["runId", "createdAt", "ticker", "instrumentName", "analysisDate", "legacy", "rating"] as const) expect(metadata[field]).toBeUndefined();
    expect(comparisonVersionLabel(malformed, "unknown")).toBe("unknown");
    expect(JSON.stringify(metadata)).not.toContain("UNSUPPORTED-METADATA-BODY");
    expect(publicComparisonManifest({ llmProvider: unsupported, maxDebateRounds: unsupported, runtimeRunSettings: null, toolVendors: false })).toEqual({});
  });

  it.each([null, undefined, false, "raw", [], 13])("withholds unsupported saved manifest containers (%#)", value => {
    expect(publicComparisonManifest(value)).toBeNull();
  });
});
