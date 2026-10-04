import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { ReportVersionsPanel } from "./ReportVersionsPanel";
import { numericFixture } from "@/features/numeric-review/fixtures/fictional-numeric";
import { proxyTargetMemoryTask, targetMemoryReviewFor } from "@/features/memory/fixtures/target-memory";

const { saveTextExport } = vi.hoisted(() => ({ saveTextExport: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ getRuntimeAdapter: () => ({ saveTextExport }) }));

describe("selected immutable report review", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("crypto", webcrypto);
    saveTextExport.mockReset().mockResolvedValue({ status: "saved" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("replaces the combined saved numeric panel on legacy selection and restores only the selected receipt", async () => {
    const task = numericFixture(), saved = task.reportVersions[0], legacy = task.reportVersions[1];
    await act(async () => root.render(createElement(ReportVersionsPanel, { task, language: "zh" })));
    const numericHeadings = () => [...container.querySelectorAll("h4")].filter((heading) => heading.textContent === "保存数值字段审阅");
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain(saved.numericReviews![0].review_id); });
    expect(numericHeadings()).toHaveLength(1);
    expect(container.textContent).toContain("所选数值相符");
    const select = container.querySelector<HTMLSelectElement>("#report-version-select")!;
    await act(async () => { select.value = legacy.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("此历史版本没有冻结原文快照，不能创建数值审阅。"); });
    expect(numericHeadings()).toHaveLength(1);
    expect(container.textContent).not.toContain("所选数值相符");
    expect(container.textContent).not.toContain(saved.numericReviews![0].review_id);
    expect(container.textContent).toContain("审阅选中的报告 v1");
    await act(async () => { select.value = saved.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain(saved.numericReviews![0].review_id); });
    expect(numericHeadings()).toHaveLength(1);
    expect(container.textContent).toContain("所选数值相符");
    expect(container.textContent).not.toContain("此历史版本没有冻结原文快照，不能创建数值审阅。");
    expect(container.textContent).toContain("审阅选中的报告 v2");
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("selects the same frozen report and quality for preview and export", async () => {
    const task = createFictionalDemoTask("en");
    const first = {
      ...task.reportVersions[0],
      decision: "Buy",
      reportSections: { final_trade_decision: "Rating: Buy\n\nFirst frozen report." },
      outputQuality: {
        portfolio_manager: { status: "unvalidated_text", schema: "PortfolioDecision", source: "raw_response", reason: "no_tool_call" },
      } as const,
    };
    const second = {
      ...first, id: "version-2", runId: "run-2", versionNumber: 2,
      decision: "Sell",
      reportSections: { final_trade_decision: "Rating: Sell\n\nSecond frozen report." },
      outputQuality: {
        portfolio_manager: { status: "validated_schema", schema: "PortfolioDecision", source: "structured" },
      } as const,
    };
    const currentTask = { ...task, decision: second.decision, reportSections: second.reportSections, outputQuality: second.outputQuality, reportVersions: [first, second] };
    await act(async () => root.render(createElement(ReportVersionsPanel, { task: currentTask, language: "en" })));
    expect(container.textContent).toContain("Second frozen report.");
    expect(container.textContent).toContain("Format validated");

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = first.id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Review selected report v1");
    expect(container.textContent).toContain("First frozen report.");
    expect(container.textContent).not.toContain("Second frozen report.");
    expect(container.textContent).toContain("Text fallback · format unvalidated");

    const exportButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Markdown")!;
    await act(async () => exportButton.click());
    const request = saveTextExport.mock.calls[0][0];
    expect(request.content).toContain("First frozen report.");
    expect(request.content).not.toContain("Second frozen report.");
    expect(request.content).toContain("Text fallback · format unvalidated");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Report downloaded");
  });

  it("isolates selected v2 proxy memory and later facts from a legacy version and its export", async () => {
    const task = await proxyTargetMemoryTask();
    const current = { ...task.reportVersions[0], versionNumber: 2, evaluationReviews: [await targetMemoryReviewFor(task)] };
    const legacy = { ...current, id: "absent-memory-version", runId: "44444444-4444-4444-8444-444444444444", versionNumber: 1,
      createdAt: "2025-02-13T12:05:00.000000Z", memoryBundle: undefined, evidenceBundle: undefined, evaluationReviews: [], legacy: true };
    task.reportVersions = [legacy, current];
    await act(async () => root.render(createElement(ReportVersionsPanel, { task, language: "en" })));
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("US500 → ^GSPC"); });
    expect(container.textContent).toContain("Later evaluation review");
    const select = container.querySelector<HTMLSelectElement>("#report-version-select")!;
    await act(async () => { select.value = legacy.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("No immutable memory attachment was saved for this version"); });
    expect(container.querySelectorAll('[aria-label="Immutable research memory"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("US500 → ^GSPC");
    expect(container.textContent).not.toContain("Later evaluation review");
    const json = [...container.querySelectorAll("button")].find((button) => button.textContent === "Report JSON")!;
    await act(async () => json.click());
    const exported = JSON.parse(saveTextExport.mock.calls[0][0].content);
    expect(exported.memory_bundle).toBeNull();
    expect(exported.evaluation_reviews).toEqual([]);
    expect(exported).not.toHaveProperty("memory_verification_scope");
    await act(async () => { select.value = current.id; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain("US500 → ^GSPC"); });
    expect(container.textContent).toContain("Later evaluation review");
    expect(container.querySelectorAll('[aria-label="Immutable research memory"]')).toHaveLength(1);
  });
});
