import { describe, expect, it } from "vitest";
import { reportJson } from "@/features/report-export/lib/report-json";
import { buildReportDocument } from "@/features/report-export/lib/report-document";
import { renderReportHtml } from "@/features/report-export/lib/render-html";
import { renderReportMarkdown } from "@/features/report-export/lib/render-markdown";
import { identityFixture } from "../fixtures/fictional-identity";
import { changeFixture } from "../fixtures/modified-identity";
import { verifiedIdentityExport } from "./export";
describe("complete request assessment report exports", () => {
  it.each(["html", "md", "json"])(
    "hybrid owner metadata cannot bypass the %s export binding",
    async (format) => {
      const task = identityFixture();
      const original = task.reportVersions[0];
      const version = {
        ...original,
        task: { ...original.task, ticker: "OTHER" },
        runId: "00000000-0000-4000-8000-000000000001",
        status: "completed",
        ticker: task.ticker,
        analysisDate: task.analysisDate,
      };
      await expect(verifiedIdentityExport(version)).rejects.toThrow("reference_mismatch");
      const doc = buildReportDocument(task.id, task.origin, version, "en");
      expect(() =>
        format === "json"
          ? reportJson(task.id, task.origin, version)
          : format === "html"
            ? renderReportHtml(doc)
            : renderReportMarkdown(doc),
      ).toThrow("reference_mismatch");
    },
  );
  it("all three formats retain the full frozen attachment and original payloads", async () => {
    const task = identityFixture(),
      frozen = await verifiedIdentityExport(task.reportVersions[0]);
    const value = reportJson(task.id, task.origin, frozen);
    expect(value.effective_request_identity).toEqual(task.effectiveRequestIdentity);
    expect(value.evidence_bundle).toEqual(task.evidenceBundle);
    expect(value.report_text_snapshot).toEqual(task.reportTextSnapshot);
    const document = buildReportDocument(task.id, task.origin, frozen, "en");
    for (const content of [renderReportHtml(document), renderReportMarkdown(document)]) {
      expect(content).toContain(task.effectiveRequestIdentity!.assessment_sha256);
      for (const record of task.effectiveRequestIdentity!.records)
        expect(content).toContain(record.evidence_id);
      expect(content).toContain("Provider request unknown / entity unknown");
      expect(content).toContain("does not confirm venue");
    }
  });
  it.each(["html", "md", "json"])(
    "invalid assessment blocks %s, legacy absence remains exportable",
    async (format) => {
      const task = identityFixture(),
        version = task.reportVersions[0];
      version.effectiveRequestIdentity!.summary.conflict_count = 0;
      await expect(verifiedIdentityExport(version)).rejects.toThrow("reference_mismatch");
      const document = buildReportDocument(task.id, task.origin, version, "en");
      expect(() =>
        format === "json"
          ? reportJson(task.id, task.origin, version)
          : format === "html"
            ? renderReportHtml(document)
            : renderReportMarkdown(document),
      ).toThrow("reference_mismatch");
      const legacy = task.reportVersions[1];
      expect(reportJson(task.id, task.origin, legacy).effective_request_identity).toBeNull();
    },
  );
  it("valid archived conflict does not replace its original Buy rating or claim provider identity", async () => {
    const task = await changeFixture((value) => {
      value.decision = "Buy";
      value.reportSections.final_trade_decision = "Rating: Buy";
    });
    const version = await verifiedIdentityExport(task.reportVersions[0]);
    const value = reportJson(task.id, task.origin, version);
    expect(value.report.decision).toBe("Buy");
    expect(value.effective_request_identity!.summary.conflict_count).toBe(1);
    expect(
      value
        .effective_request_identity!.records.flatMap((record) => record.sources)
        .every((source) => source.provider_entity === "unknown"),
    ).toBe(true);
  });
  it("legal malicious-looking report text remains text with escaped full HTML appendices", async () => {
    const task = await changeFixture((value) => {
      value.reportSections.market_report +=
        "\nENTRY_END\nREFLECTION\n<script>fictional</script>\n```";
    });
    const version = await verifiedIdentityExport(task.reportVersions[0]),
      doc = buildReportDocument(task.id, task.origin, version, "en");
    expect(
      reportJson(task.id, task.origin, version).report_text_snapshot!.report_sections.market_report,
    ).toContain("<script>fictional</script>");
    const html = renderReportHtml(doc);
    expect(html).not.toContain("<script>fictional</script>");
    expect(html).toContain("&lt;script&gt;fictional&lt;/script&gt;");
    expect(renderReportMarkdown(doc)).toContain("ENTRY_END");
  });
});
