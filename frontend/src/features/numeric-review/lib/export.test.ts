import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { reportJson } from "@/features/report-export/lib/report-json";
import { buildReportDocument } from "@/features/report-export/lib/report-document";
import { renderReportHtml } from "@/features/report-export/lib/render-html";
import { renderReportMarkdown } from "@/features/report-export/lib/render-markdown";
import { numericFixture } from "../fixtures/fictional-numeric";
import { verifiedNumericExport } from "./export";
beforeAll(() => Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }));
describe("complete frozen numeric exports", () => {
    it("round-trips exact snapshot/reviews and opaque source numbers in JSON, HTML and Markdown", async () => {
        const task = numericFixture(), version = await verifiedNumericExport(task.id, task.reportVersions[0]);
        const json = JSON.parse(JSON.stringify(reportJson(task.id, "demo", version)));
        expect(json.report_text_snapshot).toEqual(version.reportTextSnapshot);
        expect(json.numeric_reviews).toEqual(version.numericReviews);
        expect(json.evidence_bundle).toEqual(version.evidenceBundle);
        expect(json.report.reportSections).toEqual(version.reportSections);
        const document = buildReportDocument(task.id, "demo", version, "en"), html = renderReportHtml(document), markdown = renderReportMarkdown(document);
        const parsed = new DOMParser().parseFromString(html, "text/html");
        expect(JSON.parse(parsed.querySelector("#numeric-review-attachments")!.textContent!)).toEqual({ report_text_snapshot: version.reportTextSnapshot, numeric_reviews: version.numericReviews });
        const blocks = [...markdown.matchAll(/^(`{3,})json\n([\s\S]*?)\n\1(?:\n|$)/gm)].map((match) => JSON.parse(match[2]));
        expect(blocks.find((block) => block.report_text_snapshot)).toEqual({ report_text_snapshot: version.reportTextSnapshot, numeric_reviews: version.numericReviews });
        expect(markdown).toContain("source_reliability");
        expect(html).toContain("historical_vintage");
        expect(html).toContain("125.02345678901236");
        expect(markdown).toContain("125.02345678901236");
    });
    it("blocks an invalid marker across all renderers and lets valid mismatch/missing reviews export", async () => {
        const task = numericFixture(), version = task.reportVersions[0];
        expect(version.numericReviews!.some((review) => review.result.status === "mismatch")).toBe(true);
        await expect(verifiedNumericExport(task.id, version)).resolves.toBeDefined();
        version.numericValidation = { status: "invalid", reason: "reference_mismatch" };
        expect(() => reportJson(task.id, "demo", version)).toThrow("reference_mismatch");
        const document = buildReportDocument(task.id, "demo", version, "en");
        expect(() => renderReportHtml(document)).toThrow("reference_mismatch");
        expect(() => renderReportMarkdown(document)).toThrow("reference_mismatch");
    });
});
