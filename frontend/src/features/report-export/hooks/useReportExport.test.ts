import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../../tests/fixtures/evidence_bundle_v1.json";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import * as validation from "@/features/evidence/lib/validation";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { useReportExport } from "./useReportExport";
import type { ExportFormat } from "../types";
import { reviewFor } from "@/features/memory/fixtures/test-data";
import { numericFixture } from "@/features/numeric-review/fixtures/fictional-numeric";
import { targetMemoryTask } from "@/features/memory/fixtures/target-memory";

const { saveTextExport } = vi.hoisted(() => ({ saveTextExport: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ getRuntimeAdapter: () => ({ saveTextExport }) }));

describe("verified report export snapshot", () => {
  let container: HTMLDivElement;
  let root: Root;
  let exportSelected: (format: ExportFormat) => Promise<void>;

  function Session({ task }: { task: AnalysisTask }) {
    const session = useReportExport(task, "en");
    exportSelected = session.exportVersion;
    return createElement("p", { role: "status" }, session.message);
  }
  function taskWithEvidence() {
    const task = createFictionalDemoTask("en");
    const bundle = validation.copyEvidenceBundle(fixture);
    const version: ReportVersion = {
      ...task.reportVersions[0], runId: bundle.run_id,
      task: { ...task.reportVersions[0].task, ticker: bundle.instrument, analysisDate: bundle.analysis_date },
      reportSections: { market_report: "Original frozen report." }, evidenceBundle: bundle,
    };
    return { ...task, reportVersions: [version] };
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("crypto", webcrypto);
    saveTextExport.mockReset().mockResolvedValue({ status: "saved" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["html", "md", "json"] as const)("rejects corrupted evidence before saving %s", async (format) => {
    const task = taskWithEvidence();
    const bundle = task.reportVersions[0].evidenceBundle!;
    bundle.artifacts[bundle.records[0].output_sha256].payload += " corrupted";
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected(format));
    expect(saveTextExport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Export failed");
    expect(container.textContent).toContain("hash_mismatch");
  });

  it("blocks a known invalid marker even when its bundle has valid hashes", async () => {
    const task = taskWithEvidence();
    task.reportVersions[0].evidenceValidation = { status: "invalid", reason: "hash_mismatch" };
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected("html"));
    expect(saveTextExport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Evidence bundle is invalid");
  });

  it.each(["html", "md", "json"] as const)("blocks corrupted memory review before saving %s", async (format) => {
    const task = createFictionalDemoTask("en", true);
    const version = task.reportVersions[0];
    const review = await reviewFor(version.memoryBundle!.decision_snapshot);
    version.evaluationReviews = [review];
    review.snapshot.artifacts[review.snapshot.reflection!.response_sha256].payload += " corrupted";
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected(format));
    expect(saveTextExport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("hash_mismatch");
  });

  it("publishes the explicitly scoped verification metadata only after v2 memory hashes pass", async () => {
    const task = targetMemoryTask();
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected("json"));
    expect(saveTextExport).toHaveBeenCalledOnce();
    const exported = JSON.parse(saveTextExport.mock.calls[0][0].content);
    expect(exported.memory_bundle).toEqual(task.memoryBundle);
    expect(exported.memory_verification_scope).toMatchObject({ content_checks: "structure_references_and_hashes", arithmetic_replay: "not_performed_by_exporter", model_eligibility: "not_established_by_exporter" });
  });

  it.each(["html", "md", "json"] as const)("blocks a marked completed version with missing memory before saving %s", async (format) => {
    const task = targetMemoryTask();
    delete task.reportVersions[0].memoryBundle;
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected(format));
    expect(saveTextExport).not.toHaveBeenCalled();
    expect(container.textContent).toContain("reference_mismatch");
  });

  it.each(["html", "md", "json"] as const)("blocks invalid numeric review hashes before saving %s", async (format) => {
    const task = numericFixture(); task.reportVersions[0].numericReviews!.at(-1)!.review_sha256 = "f".repeat(64);
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected(format));
    expect(saveTextExport).not.toHaveBeenCalled(); expect(container.textContent).toContain("hash_mismatch");
  });
  it.each(["html", "md", "json"] as const)("preserves exact numeric snapshot/history when inputs mutate during %s verification", async (format) => {
    const task = numericFixture(), original = structuredClone(task.reportVersions[0]);
    const verify = validation.verifyEvidenceBundle;
    vi.spyOn(validation, "verifyEvidenceBundle").mockImplementation(async (value, reports) => {
      const result = await verify(value, reports);
      task.reportVersions[0].numericReviews![0].numeric_span.text = "CHANGED-NUMBER";
      task.reportVersions[0].reportTextSnapshot!.report_sections.market_report = "CHANGED-SNAPSHOT";
      return result;
    });
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected(format));
    expect(saveTextExport).toHaveBeenCalledOnce(); const content = saveTextExport.mock.calls[0][0].content;
    expect(content).not.toMatch(/CHANGED-/); expect(content).toContain(original.reportTextSnapshot!.snapshot_sha256);
    if (format === "json") {
      const exported = JSON.parse(content); expect(exported.report_text_snapshot).toEqual(original.reportTextSnapshot); expect(exported.numeric_reviews).toEqual(original.numericReviews);
    }
  });

  it.each(["html", "md", "json"] as const)("keeps exact frozen memory when original inputs mutate during %s verification", async (format) => {
    const task = createFictionalDemoTask("en", true); const original = structuredClone(task.reportVersions[0].memoryBundle!);
    const verify = validation.verifyEvidenceBundle;
    vi.spyOn(validation, "verifyEvidenceBundle").mockImplementation(async (value, reports) => {
      const verified = await verify(value, reports);
      task.reportVersions[0].memoryBundle!.input_snapshot.context_artifact.payload = "CHANGED-MEMORY-INPUT";
      task.reportVersions[0].reportSections.final_trade_decision = "CHANGED-DECISION";
      return verified;
    });
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected(format));
    expect(saveTextExport).toHaveBeenCalledOnce();
    const content = saveTextExport.mock.calls[0][0].content;
    expect(content).not.toMatch(/CHANGED-/); expect(content).toContain(original.bundle_sha256);
    if (format === "json") expect(JSON.parse(content).memory_bundle).toEqual(original);
  });

  it.each(["html", "md", "json"] as const)("exports the independently verified copy when inputs change during %s verification", async (format) => {
    const task = taskWithEvidence();
    const originalId = task.id;
    const verify = validation.verifyEvidenceBundle;
    vi.spyOn(validation, "verifyEvidenceBundle").mockImplementation(async (value, reports) => {
      const verified = await verify(value, reports);
      const passed = value as EvidenceBundle;
      passed.artifacts[passed.records[0].output_sha256].payload += " CHANGED-VERIFIER-INPUT";
      const original = task.reportVersions[0];
      original.evidenceBundle!.artifacts[original.evidenceBundle!.records[0].output_sha256].payload += " CHANGED-ORIGINAL-PAYLOAD";
      original.reportSections.market_report = "CHANGED-ORIGINAL-REPORT";
      original.task.ticker = "CHANGED-TICKER";
      task.id = "CHANGED-TASK-ID";
      task.origin = "analysis";
      return verified;
    });
    await act(async () => root.render(createElement(Session, { task })));
    await act(async () => exportSelected(format));
    expect(saveTextExport).toHaveBeenCalledOnce();
    const request = saveTextExport.mock.calls[0][0];
    expect(request.suggestedName).toContain(fixture.instrument);
    expect(request.content).not.toMatch(/CHANGED-/);
    if (format === "json") {
      const exported = JSON.parse(request.content);
      expect(exported).toMatchObject({ schema_version: 1, kind: "research_report", evidence_bundle: fixture, memory_bundle: null, evaluation_reviews: [] });
      expect(exported.report.task_id).toBe(originalId);
      expect(exported.report.reportSections.market_report).toBe("Original frozen report.");
    } else {
      expect(request.content).toContain(originalId);
      expect(request.content).toContain("Original frozen report.");
      expect(request.content).toContain("Entirely fictional demo report");
      expect(request.content).toContain(fixture.bundle_sha256);
    }
  });
});
