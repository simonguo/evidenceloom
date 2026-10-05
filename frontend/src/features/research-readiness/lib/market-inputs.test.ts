import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvidenceBundle } from "@/features/evidence/types";
import { changeMarketRows, changeQuality, component, providerTable, qualityFixture, readinessFixture } from "../fixtures/test-data";
import { validateMarketObservations } from "./market-inputs";
import { verifyResearchReadiness } from "./validation";
import sharedEvidence from "../../../../../tests/fixtures/research_readiness_evidence_v1.json";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
function proofInputs(task: Awaited<ReturnType<typeof readinessFixture>>) {
  const evidence = task.evidenceBundle!, record = evidence.records.find((item) => item.tool === "get_verified_market_snapshot")!;
  const source = record.sources.find((item) => item.provider === "local_calculation")!;
  return { evidence, record, quality: JSON.parse(evidence.artifacts[source.data_sha256!].payload) as ReturnType<typeof qualityFixture> };
}
async function denied(task: Awaited<ReturnType<typeof readinessFixture>>) {
  expect(task.researchReadiness!.checks[1].reason_codes).toContain("verification_quality_unknown");
  expect(task.researchReadiness!.recommendation_allowed).toBe(false);
  await expect(verifyResearchReadiness(task.researchReadiness, task.evidenceBundle)).resolves.toBeDefined();
  const forged = structuredClone(task.researchReadiness!);
  for (const check of forged.checks.filter((item) => item.required)) { check.status = "passed"; check.reason_codes = []; }
  forged.status = "ready"; forged.recommendation_allowed = true;
  await expect(verifyResearchReadiness(await component(forged, "assessment_sha256"), task.evidenceBundle)).rejects.toThrow("reference_mismatch");
}
describe("saved market rows are independent input proof", () => {
  it("uses the original named zone over a captured New York DST transition", () => {
    const evidence = structuredClone(sharedEvidence) as EvidenceBundle, record = evidence.records[0];
    const quality = JSON.parse(evidence.artifacts[record.sources.at(-1)!.data_sha256!].payload);
    expect(() => validateMarketObservations(quality, record, evidence)).not.toThrow();
    const data = evidence.artifacts[record.sources[0].data_sha256!].payload;
    expect(data).toContain("-04:00"); expect(data).toContain("-05:00");
  });
  it.each([
    ["invented completion", (quality: ReturnType<typeof qualityFixture>) => { quality.completion_status = "unknown"; }],
    ["invented count", (quality: ReturnType<typeof qualityFixture>) => { quality.rows.in_window = 0; }],
    ["invented named zone", (quality: ReturnType<typeof qualityFixture>) => { quality.source_timezone = "Not_A_Real_Timezone"; }],
    ["invented convention", (quality: ReturnType<typeof qualityFixture>) => { quality.timezone_origin = "symbol_market_convention"; }],
    ["invented latest label", (quality: ReturnType<typeof qualityFixture>) => { quality.rows.latest_usable_date = quality.rows.latest_received_date = "2025-02-14"; }],
  ])("rejects a coherently rehashed %s quality claim", async (_, change) => {
    await denied(await changeQuality(await readinessFixture(), change));
  });
  it.each([
    ["missing original source clock", (table: ReturnType<typeof providerTable>) => { table.columns = table.columns.slice(0, 6); table.rows = table.rows.map((row) => row.slice(0, 6)); }],
    ["wrong source offset", (table: ReturnType<typeof providerTable>) => { table.rows[0][8] = "+01:00"; }],
    ["wrong zone case", (table: ReturnType<typeof providerTable>) => { table.rows.forEach((row) => { row[7] = "utc"; }); }],
    ["unknown source alias", (table: ReturnType<typeof providerTable>) => { table.rows.forEach((row) => { row[7] = "US/Eastern"; }); }],
    ["invalid OHLC", (table: ReturnType<typeof providerTable>) => { table.rows[0][2] = 80; table.rows[0][3] = 120; }],
    ["boolean volume", (table: ReturnType<typeof providerTable>) => { table.rows[0][5] = true; }],
    ["out-of-range numeric facts", (table: ReturnType<typeof providerTable>) => { table.rows[0][5] = 2 ** 53; }],
    ["inconsistent price basis metadata", (table: ReturnType<typeof providerTable>) => { table.columns.push("PriceBasis"); table.rows.forEach((row) => row.push("different_basis")); }],
    ["inconsistent original request start", (table: ReturnType<typeof providerTable>) => { table.columns.push("HistoryRequestStart"); table.rows.forEach((row) => row.push("2024-02-01")); }],
    ["nonexclusive original request end", (table: ReturnType<typeof providerTable>) => { table.columns.push("HistoryRequestEnd"); table.rows.forEach((row) => row.push("2025-02-14")); }],
    ["conflicting duplicate", (table: ReturnType<typeof providerTable>) => { const duplicate = [...table.rows[0]]; duplicate[4] = 101; table.rows.push(duplicate); }],
    ["same-day provisional rows", (table: ReturnType<typeof providerTable>) => { table.rows = providerTable(300, "2025-02-14").rows; }],
  ])("rejects an unchanged quality claim over saved %s", async (_, change) => {
    await denied(await changeMarketRows(await readinessFixture(), change));
  });
  it("preserves an honest unknown source clock without claiming completion", async () => {
    const task = await changeQuality(await changeMarketRows(await readinessFixture(), (table) => { table.rows.forEach((row) => { row[7] = "US/Eastern"; }); }), (quality) => {
      quality.source_timezone = null; quality.timezone_origin = "unknown"; quality.completion_status = "unknown";
      quality.rows.usable_complete = 0; quality.rows.unknown_completion = 300; quality.rows.latest_usable_date = null;
      for (const item of Object.values(quality.indicator_assessments)) { item.usable_rows = 0; item.status = "unavailable_input"; item.value = null; }
    });
    const { quality, record, evidence } = proofInputs(task);
    expect(() => validateMarketObservations(quality, record, evidence)).not.toThrow();
    expect(task.researchReadiness!.checks[1].reason_codes).toContain("unknown_bar_completion");
    expect(task.researchReadiness!.checks[1].reason_codes).not.toContain("verification_quality_unknown");
  });
  it.each(["-00:00", "+15:00", "+00:99"])("rejects a malformed captured %s offset before an unknown zone can hide it", async (offset) => {
    const { quality, record, evidence } = proofInputs(await readinessFixture()), source = record.sources[0];
    const table = providerTable(); table.rows.forEach((row) => { row[6] = String(row[6]).slice(0, -1) + offset; row[7] = null; row[8] = null; row[9] = "unknown"; });
    evidence.artifacts[source.data_sha256!].payload = JSON.stringify(table);
    quality.source_timezone = null; quality.timezone_origin = "unknown"; quality.completion_status = "unknown";
    quality.rows.usable_complete = 0; quality.rows.unknown_completion = 300; quality.rows.latest_usable_date = null;
    expect(() => validateMarketObservations(quality, record, evidence)).toThrow();
  });
  it.each([false, true])("accepts a bound provider-metadata clock without inventing timestamp-origin provenance (naive=%s)", async (naive) => {
    const task = await changeQuality(await changeMarketRows(await readinessFixture(), (table) => {
      table.rows.forEach((row) => { row[9] = "provider_metadata"; if (naive) { row[6] = String(row[6]).slice(0, -1); row[8] = null; } });
    }), (quality) => { quality.timezone_origin = "provider_metadata"; });
    await expect(verifyResearchReadiness(task.researchReadiness, task.evidenceBundle)).resolves.toMatchObject({ status: "ready" });
  });
  it("accepts exact duplicates only with matching independently derived counts", async () => {
    const task = await changeQuality(await changeMarketRows(await readinessFixture(), (table) => { table.rows.push([...table.rows[0]]); }), (quality) => {
      quality.rows.received = quality.rows.in_window = 301; quality.rows.identical_duplicates_collapsed = 1;
    });
    await expect(verifyResearchReadiness(task.researchReadiness, task.evidenceBundle)).resolves.toMatchObject({ status: "ready" });
  });
  it("requires every enriched same-provider table to agree with the assessment", async () => {
    const task = await readinessFixture(), { quality, record, evidence } = proofInputs(task);
    record.sources.push({ ...record.sources[0], observed_window: { start: "2025-02-13", end: "2025-02-13" }, data_sha256: "a".repeat(64) });
    evidence.artifacts["a".repeat(64)] = { kind: "normalized_data", payload: JSON.stringify(providerTable(1)) };
    expect(() => validateMarketObservations(quality, record, evidence)).toThrow();
  });
  it("binds explicit provider request metadata and price basis without rewriting them", async () => {
    const task = await changeMarketRows(await readinessFixture(), (table) => {
      table.columns.push("PriceBasis", "HistoryRequestStart", "HistoryRequestEnd");
      table.rows.forEach((row) => row.push("auto_adjust=True requested; actions=False", "2024-01-01", "2025-02-15"));
    });
    await expect(verifyResearchReadiness(task.researchReadiness, task.evidenceBundle)).resolves.toMatchObject({ status: "ready" });
  });
  it("rejects unsafe numeric duplicates before f64 can collapse their identity, even with an invalid assessment", async () => {
    const { evidence, record, quality } = proofInputs(await readinessFixture());
    const source = record.sources[0], artifact = evidence.artifacts[source.data_sha256!];
    const table = providerTable(), original = table.rows[0], duplicate = [...original];
    original[1] = 9007199254740992; duplicate[1] = 9007199254740992; table.rows.push(duplicate);
    // The original opaque JSON distinguishes these integers; JSON.parse cannot.
    artifact.payload = JSON.stringify(table).replace('9007199254740992', '9007199254740993');
    quality.integrity_status = "invalid"; quality.rows.received = quality.rows.in_window = 301;
    quality.rows.valid = quality.rows.usable_complete = 299; quality.rows.invalid = 2;
    quality.rows.conflicting_duplicate_dates = [String(original[0]).slice(0, 10)];
    const exact = artifact.payload;
    expect(() => validateMarketObservations(quality, record, evidence)).toThrow();
    expect(artifact.payload).toBe(exact); expect(exact).toContain('9007199254740993');
  });
  it("never treats withheld observations as available provider proof", async () => {
    const task = await readinessFixture(), { quality, record, evidence } = proofInputs(task);
    record.sources[0].historical_availability = "withheld";
    expect(() => validateMarketObservations(quality, record, evidence)).toThrow();
  });
});
