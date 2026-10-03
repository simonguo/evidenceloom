import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../../tests/fixtures/evidence_bundle_v1.json";
import { createEmptyTask, defaultAnalysisForm, defaultTaskDraft } from "@/lib/analysis";
import { loadTasks, saveTasks, saveVerifiedTasks } from "@/features/persistence/local-storage";
import { appendCompletedReportVersion, createRunContext } from "@/features/report-export/lib/versioning";
import { buildReportDocument } from "@/features/report-export/lib/report-document";
import { renderReportHtml } from "@/features/report-export/lib/render-html";
import { renderReportMarkdown } from "@/features/report-export/lib/render-markdown";
import type { EvidenceBundle } from "../types";
import { canonicalJson, citationReferences, copyEvidenceBundle, normalizeTaskEvidence, sha256, verifyEvidenceBundle, verifyTaskEvidence } from "./validation";

async function citedFixture() {
  const bundle = copyEvidenceBundle(fixture);
  const id = bundle.records[0].id;
  bundle.citation_audit.market_report = { referenced_ids: [id, "missing-source"], unresolved_ids: ["missing-source"], status: "unresolved" };
  const { bundle_sha256: _, ...body } = bundle;
  bundle.bundle_sha256 = await sha256(body);
  return { bundle, reports: { market_report: `A fictional source [E:${id}] and unresolved [E:missing-source].` } };
}
describe("saved research evidence", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); window.localStorage.clear(); });
  afterEach(() => vi.unstubAllGlobals());

  it("verifies independently generated Python hashes without rounding normalized values", async () => {
    const bundle = await verifyEvidenceBundle(fixture);
    expect(bundle).toEqual(fixture);
    expect(bundle).not.toBe(fixture);
    const payload = Object.values(bundle.artifacts).find((artifact) => artifact.kind === "normalized_data")!.payload;
    expect(payload).toBe('{"close":123.45678901234567,"integral":1.0,"tiny":1e-07}');
    expect(await sha256(bundle.manifest)).toBe(fixture.manifest_sha256);
    expect(canonicalJson(bundle)).toContain("123.45678901234567");
  });

  it("keeps exact bundle values through frozen history, browser save/load, HTML and Markdown", async () => {
    const { bundle, reports } = await citedFixture();
    const task = { ...createEmptyTask({ ...defaultTaskDraft(), ticker: bundle.instrument, analysisDate: bundle.analysis_date }), status: "completed" as const, evidenceBundle: bundle, reportSections: reports };
    const versioned = appendCompletedReportVersion(task, { type: "completed", reportSections: reports, evidenceBundle: bundle }, createRunContext(defaultAnalysisForm()));
    const version = versioned.reportVersions[0];
    expect(version.runId).toBe(bundle.run_id);
    expect(version.evidenceBundle).toEqual(bundle);
    expect(version.evidenceBundle).not.toBe(bundle);
    await saveVerifiedTasks([versioned]);
    const [loaded] = await Promise.all(loadTasks().map(verifyTaskEvidence));
    expect(loaded.evidenceBundle).toEqual(bundle);
    expect(loaded.reportVersions[0].evidenceBundle).toEqual(bundle);
    const document = buildReportDocument(loaded.id, loaded.origin, loaded.reportVersions[0], "en");
    expect(document.metadata.some(([label]) => label === "Configured market adapters")).toBe(true);
    expect(document.evidence.bundle?.records[0].sources[0].provider).toBe("tencent");
    const html = renderReportHtml(document);
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(JSON.parse(dom.querySelector("#evidence-bundle-json")!.textContent!)).toEqual(bundle);
    expect(dom.querySelector(`a[href="#${bundle.records[0].id}"]`)).not.toBeNull();
    expect(dom.getElementById(bundle.records[0].id)).not.toBeNull();
    const markdown = renderReportMarkdown(document);
    const embedded = markdown.match(/```json\n([\s\S]*?)\n```/)![1];
    expect(JSON.parse(embedded)).toEqual(bundle);
    expect(html).toContain(bundle.bundle_sha256);
    expect(html).toContain("Configured market adapters");
    expect(html).toContain("tencent");
    expect(markdown).toContain("missing-source");
    expect(markdown).toContain("does not prove factual support");
    bundle.records[0].sources[0].provider = "unknown";
    expect(loaded.reportVersions[0].evidenceBundle?.records[0].sources[0].provider).toBe("tencent");
    const rerun = { ...loaded, status: "running" as const, evidenceBundle: undefined, reportSections: {} };
    await saveVerifiedTasks([rerun]);
    expect(loadTasks()[0].reportVersions[0].evidenceBundle).toEqual(version.evidenceBundle);
  });

  it("records corruption explicitly and never exports private fields", async () => {
    const { bundle, reports } = await citedFixture();
    const altered = structuredClone(bundle);
    altered.artifacts[altered.records[0].output_sha256].payload += " changed";
    await expect(verifyEvidenceBundle(altered)).rejects.toMatchObject({ reason: "hash_mismatch" });
    const task = { ...createEmptyTask(defaultTaskDraft()), evidenceBundle: altered, reportSections: reports };
    const invalid = await verifyTaskEvidence(task);
    expect(invalid.evidenceBundle).toBeUndefined();
    expect(invalid.evidenceValidation).toEqual({ status: "invalid", reason: "hash_mismatch" });
    const secret = { ...bundle, error: "private error body", backend_url: "https://private.invalid" };
    expect(() => copyEvidenceBundle(secret)).toThrow();
    saveTasks([{ ...task, evidenceBundle: secret as EvidenceBundle }]);
    expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).not.toMatch(/private error body|private.invalid/);
    const unsafe = structuredClone(bundle);
    unsafe.records[0].sources[0].url = "https://user:secret@example.com/path?api_key=secret";
    expect(() => copyEvidenceBundle(unsafe)).toThrow();
  });

  it("rejects metadata-only, orphaned, future and mismatched citation manifests", async () => {
    const { bundle, reports } = await citedFixture();
    await expect(verifyEvidenceBundle({ ...bundle, artifacts: {} })).rejects.toThrow();
    const orphan = structuredClone(bundle);
    orphan.artifacts["f".repeat(64)] = { kind: "tool_text", payload: "orphan" };
    expect(() => copyEvidenceBundle(orphan)).toThrow();
    const future = structuredClone(bundle);
    future.records[0].sources[0].observed_window!.end = "2025-02-15";
    expect(() => copyEvidenceBundle(future)).toThrow();
    await expect(verifyEvidenceBundle(bundle, { market_report: reports.market_report + " [E:new-missing]" })).rejects.toMatchObject({ reason: "citation_mismatch" });
    const legacy = await verifyTaskEvidence(createEmptyTask(defaultTaskDraft()));
    expect(legacy.evidenceBundle).toBeUndefined();
    expect(legacy.evidenceValidation).toBeUndefined();
  });

  it("rejects browser storage failure without reporting a successful save", async () => {
    const { bundle } = await citedFixture();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
    await expect(saveVerifiedTasks([{ ...createEmptyTask(defaultTaskDraft()), evidenceBundle: bundle }])).rejects.toThrow("Quota exceeded");
    spy.mockRestore();
  });

  it("keeps malformed citation tags explicitly unresolved alongside a saved source", async () => {
    const bundle = copyEvidenceBundle(fixture);
    const id = bundle.records[0].id;
    const reports = { market_report: `Source [E:${id}], malformed [E:bad id] and unclosed [E:` };
    expect(citationReferences(reports.market_report)).toEqual([id, "invalid-citation"]);
    bundle.citation_audit.market_report = { referenced_ids: [id, "invalid-citation"], unresolved_ids: ["invalid-citation"], status: "unresolved" };
    const { bundle_sha256: _, ...body } = bundle;
    bundle.bundle_sha256 = await sha256(body);
    await expect(verifyEvidenceBundle(bundle, reports)).resolves.toEqual(bundle);
    const unsafe = structuredClone(bundle);
    unsafe.manifest.data_vendors = { raw_endpoint: "https://example.com" };
    expect(() => copyEvidenceBundle(unsafe)).toThrow();
  });

  it("rejects a contradictory verified bundle and invalid marker instead of erasing the marker", async () => {
    const task = { ...createEmptyTask({ ...defaultTaskDraft(), ticker: fixture.instrument, analysisDate: fixture.analysis_date }), evidenceBundle: copyEvidenceBundle(fixture), evidenceValidation: { status: "invalid", reason: "hash_mismatch" } as const };
    const saved = await verifyTaskEvidence(task);
    expect(saved.evidenceBundle).toBeUndefined();
    expect(saved.evidenceValidation).toEqual({ status: "invalid", reason: "malformed" });
    const wrongInstrument = normalizeTaskEvidence({ ...task, ticker: "OTHER", evidenceValidation: undefined });
    expect(wrongInstrument.evidenceBundle).toBeUndefined();
    expect(wrongInstrument.evidenceValidation).toEqual({ status: "invalid", reason: "malformed" });
  });
});
