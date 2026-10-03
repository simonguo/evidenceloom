import { describe, expect, it } from "vitest";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { buildReportDocument } from "./report-document";
import { reportExportFilename, sanitizeFilenamePart } from "./filename";
import { renderReportHtml } from "./render-html";
import { renderReportMarkdown } from "./render-markdown";

describe("report export renderers", () => {
  it("exports frozen format limitations identically in HTML and Markdown", () => {
    const task = createFictionalDemoTask("en");
    const version = {
      ...task.reportVersions[0],
      outputQuality: {
        portfolio_manager: {
          status: "unvalidated_text", schema: "PortfolioDecision", source: "raw_response", reason: "schema_validation_failed",
          error: "sensitive-error-body", endpoint: "https://private.invalid",
        },
      },
    };
    const document = buildReportDocument(task.id, task.origin, version as never, "en");
    for (const rendered of [renderReportHtml(document), renderReportMarkdown(document)]) {
      expect(rendered).toContain("Text fallback · format unvalidated");
      expect(rendered).toContain("Original response retained");
      expect(rendered).toContain("no structured guarantees for ratings or fields");
      expect(rendered).not.toMatch(/sensitive-error-body|private.invalid/);
    }
  });

  it("does not infer format validation from a legacy rating", () => {
    const task = createFictionalDemoTask("zh");
    const document = buildReportDocument(task.id, task.origin, task.reportVersions[0], "zh");
    expect(renderReportMarkdown(document)).toContain("未记录输出格式质量");
    expect(renderReportHtml(document)).toContain("无法确认是否经过结构化验证");
  });

  it("renders stable ordered Markdown with sanitized run metadata", () => {
    const task = createFictionalDemoTask("zh");
    const version = task.reportVersions[0];
    const document = buildReportDocument(task.id, task.origin, version, "zh");
    const markdown = renderReportMarkdown(document);

    expect(markdown).toContain("完全虚构");
    expect(markdown.indexOf("## 1. 分析师报告")).toBeLessThan(markdown.indexOf("## 2. 多空研究讨论"));
    expect(markdown.indexOf("## 2. 多空研究讨论")).toBeLessThan(markdown.indexOf("## 3. 交易计划"));
    expect(markdown.indexOf("## 3. 交易计划")).toBeLessThan(markdown.indexOf("## 4. 风险讨论与最终决策"));
    expect(markdown).toContain("fictional-provider");
    expect(markdown).not.toContain("apiKey");
    expect(markdown).not.toContain("backendUrl");
    expect(markdown).not.toContain("projectRoot");
  });

  it("produces script-free self-contained HTML and omits remote images", () => {
    const task = createFictionalDemoTask("en");
    const version = {
      ...task.reportVersions[0],
      reportSections: {
        ...task.reportVersions[0].reportSections,
        market_report: "<script>alert('x')</script>\n\n![remote](https://example.com/a.png)\n\n[bad](javascript:alert(1))",
      },
    };
    const html = renderReportHtml(buildReportDocument(task.id, task.origin, version, "en"));

    expect(html).toContain("Content-Security-Policy");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("src=\"https://example.com");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("[remote omitted]");
    expect(html).not.toContain("<link");
  });

  it("creates cross-platform safe export names", () => {
    const task = createFictionalDemoTask("en");
    const version = {
      ...task.reportVersions[0],
      task: { ...task.reportVersions[0].task, ticker: "../A:BC*?<>|\\", analysisDate: "2025/02/14" },
    };

    expect(sanitizeFilenamePart(".. /A:B* ")).toBe("_A_B_");
    expect(reportExportFilename(version, "html")).toBe("EvidenceLoom__A_BC_______2025_02_14_v1.html");
  });
});
