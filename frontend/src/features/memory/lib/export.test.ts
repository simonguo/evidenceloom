import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReportDocument } from "@/features/report-export/lib/report-document";
import { renderReportHtml } from "@/features/report-export/lib/render-html";
import { renderReportMarkdown } from "@/features/report-export/lib/render-markdown";
import { component, memoryTask, reviewFor } from "../fixtures/test-data";
import { appendEvaluationReviews } from "./reviews";
import { verifiedExportVersion } from "./export";
import { reportJson } from "@/features/report-export/lib/report-json";
import { verifyMemoryBundle, verifyReviewAttachment } from "./validation";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());
describe("complete research-report attachments", () => {
  it("round-trips exact dated bundle, outcome/reflection, prior input and full precision in every format", async () => {
    const task = memoryTask();
    const review = await reviewFor(task.memoryBundle!.decision_snapshot, { response: "ENTRY_END\nREFLECTION\n<script>fictional()</script>\n```\nUntrusted model prose remains text." });
    const settled = appendEvaluationReviews(task, task.reportVersions[0].id, [review]);
    const version = await verifiedExportVersion(settled.reportVersions[0]);
    const report = buildReportDocument(task.id, task.origin, version, "en");
    const html = renderReportHtml(report); const parsed = new DOMParser().parseFromString(html, "text/html");
    expect(parsed.querySelector("script")).toBeNull();
    const htmlMemory = JSON.parse(parsed.getElementById("memory-bundle-json")!.textContent!);
    const htmlReviews = JSON.parse(parsed.getElementById("evaluation-reviews-json")!.textContent!);
    expect(htmlMemory).toEqual(version.memoryBundle); expect(htmlReviews).toEqual([review]);
    const markdown = renderReportMarkdown(report);
    const blocks = [...markdown.matchAll(/^(`{3,})json\n([\s\S]*?)\n\1$/gm)].map((match) => JSON.parse(match[2]));
    expect(blocks).toContainEqual(version.memoryBundle); expect(blocks).toContainEqual([review]);
    const json = JSON.parse(JSON.stringify(reportJson(task.id, task.origin, version)));
    expect(json).toMatchObject({ schema_version: 1, kind: "research_report", memory_bundle: version.memoryBundle, evaluation_reviews: [review] });
    expect(json.report).not.toHaveProperty("memoryBundle");
    await expect(verifyMemoryBundle(htmlMemory, json.evidence_bundle)).resolves.toEqual(version.memoryBundle);
    await expect(verifyReviewAttachment(htmlReviews[0], htmlMemory)).resolves.toEqual(review);
    for (const content of [html, markdown, JSON.stringify(json)]) {
      expect(content).toContain("123.45678901234567"); expect(content).toContain("1.0");
      expect(content).toContain("2025-02-21T12:00:00.000002Z");
    }
    expect(html).toContain("native currencies"); expect(html).toContain("Price vintage");
    expect(html).toContain("No complete evaluation facts saved; cause unknown");
    expect(html).not.toContain("<script>fictional");
  });
  it("refuses corrupted attachments and rehashed conflicting histories before format generation", async () => {
    const task = memoryTask(); const version = task.reportVersions[0];
    const review = await reviewFor(task.memoryBundle!.decision_snapshot);
    version.evaluationReviews = [review];
    review.snapshot.artifacts[review.snapshot.reflection!.response_sha256].payload += " tampered";
    await expect(verifiedExportVersion(version)).rejects.toThrow("hash_mismatch");
    const first = await reviewFor(task.memoryBundle!.decision_snapshot);
    const conflict = await reviewFor(task.memoryBundle!.decision_snapshot, { price: "9.0" });
    version.evaluationReviews = [first, await component({ ...conflict, reviewed_at: "2025-02-22T00:00:00Z" }, "attachment_sha256")];
    await expect(verifiedExportVersion(version)).rejects.toThrow("reference_mismatch");
  });
  it("exports legacy absence explicitly and shows memory-only retention limitations", async () => {
    const task = memoryTask(); const version = task.reportVersions[0];
    const original = version.memoryBundle!;
    version.memoryBundle = await component({ ...original, persistence_status: "memory_only" as const }, "bundle_sha256");
    const doc = buildReportDocument(task.id, task.origin, await verifiedExportVersion(version), "en");
    expect(renderReportMarkdown(doc)).toContain("memory_only · not retained for later inventory");
    delete version.memoryBundle; delete version.evidenceBundle;
    const legacy = reportJson(task.id, task.origin, version);
    expect(legacy.memory_bundle).toBeNull(); expect(legacy.evidence_bundle).toBeNull();
    expect(renderReportHtml(buildReportDocument(task.id, task.origin, version, "en"))).toContain("historical availability are unknown");
  });
  it("does not export arbitrary secret-bearing stored metadata as report JSON", () => {
    const task = memoryTask(); const version = task.reportVersions[0];
    const dirty = { ...version, apiKey: "UNEXPECTED-TOP-SECRET", task: { ...version.task, password: "UNEXPECTED-TASK-SECRET" },
      run: { ...version.run!, backendUrl: "UNEXPECTED-ENDPOINT", runtimeRunSettings: { core_version: "fictional", api_key: "UNEXPECTED-RUNTIME-SECRET" } },
      reportSections: { ...version.reportSections, apiKey: "UNEXPECTED-SECTION-SECRET" } };
    const content = JSON.stringify(reportJson(task.id, task.origin, dirty));
    expect(content).not.toContain("UNEXPECTED-");
    expect(JSON.parse(content).memory_bundle).toEqual(version.memoryBundle);
  });
  it("exports hundreds of thousands of separate untrusted backtick runs without argument overflow", async () => {
    const task = memoryTask(); const response = "`x".repeat(150_000) + "\n````\nENTRY_END\nREFLECTION";
    const review = await reviewFor(task.memoryBundle!.decision_snapshot, { response });
    const version = await verifiedExportVersion(appendEvaluationReviews(task, task.reportVersions[0].id, [review]).reportVersions[0]);
    const rendered = renderReportMarkdown(buildReportDocument(task.id, task.origin, version, "en"));
    const blocks = [...rendered.matchAll(/^(`{3,})json\n([\s\S]*?)\n\1$/gm)].map((match) => JSON.parse(match[2]));
    const exported = blocks.find((value) => Array.isArray(value) && value[0]?.attachment_sha256 === review.attachment_sha256);
    expect(exported[0].snapshot.artifacts[review.snapshot.reflection!.response_sha256].payload).toBe(response);
  });
});
