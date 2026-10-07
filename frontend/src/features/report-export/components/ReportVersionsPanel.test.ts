import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { ReportVersionsPanel } from "./ReportVersionsPanel";
import { numericFixture } from "@/features/numeric-review/fixtures/fictional-numeric";
import { proxyTargetMemoryTask, targetMemoryReviewFor } from "@/features/memory/fixtures/target-memory";
import { loadTasks } from "@/features/persistence/local-storage";

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
    localStorage.clear();
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

  it("keeps comparison choices independent of single-version review/export and never reads arriving live task prose", async () => {
    const original = createFictionalDemoTask("en");
    const versions = [1, 2, 3].map((number) => ({ ...original.reportVersions[0], id: `saved-v${number}`, runId: `saved-run-${number}`,
      versionNumber: number, reportSections: { market_report: `FROZEN-${number}` } }));
    const task = { ...original, reportVersions: versions, reportSections: { market_report: "LIVE-NOT-SAVED" } };
    await act(async () => root.render(createElement(ReportVersionsPanel, { task, language: "en" })));
    const comparison = [...container.querySelectorAll("details")].find((details) => details.querySelector(":scope > summary")?.textContent === "Compare saved report versions")!;
    await act(async () => { comparison.open = true; comparison.dispatchEvent(new Event("toggle")); });
    const baselineLabel = [...container.querySelectorAll("label")].find((label) => label.textContent === "Baseline")!;
    const baseline = document.getElementById(baselineLabel.htmlFor) as HTMLSelectElement;
    const targetLabel = [...container.querySelectorAll("label")].find((label) => label.textContent === "Target")!;
    const target = document.getElementById(targetLabel.htmlFor) as HTMLSelectElement;
    await act(async () => { baseline.value = versions[0].id; baseline.dispatchEvent(new Event("change", { bubbles: true })); });
    const selected = container.querySelector<HTMLSelectElement>("#report-version-select")!;
    expect(selected.value).toBe(versions[2].id);
    const markdown = [...container.querySelectorAll("button")].find((button) => button.textContent === "Markdown")!;
    await act(async () => markdown.click());
    expect(saveTextExport.mock.calls[0][0].content).toContain("FROZEN-3");
    expect(saveTextExport.mock.calls[0][0].content).not.toContain("FROZEN-1");
    await act(async () => { selected.value = versions[1].id; selected.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(baseline.value).toBe(versions[0].id); expect(target.value).toBe(versions[2].id);
    await act(async () => root.render(createElement(ReportVersionsPanel, { task: { ...task, reportSections: { market_report: "ARRIVING-LIVE" } }, language: "en" })));
    expect(container.textContent).not.toContain("LIVE-NOT-SAVED"); expect(container.textContent).not.toContain("ARRIVING-LIVE");
    expect(comparison.textContent).toContain("FROZEN-1"); expect(comparison.textContent).toContain("FROZEN-3");
    expect(comparison.textContent).not.toContain("FROZEN-2");
    await act(async () => markdown.click());
    expect(saveTextExport.mock.calls[1][0].content).toContain("FROZEN-2");
    expect(saveTextExport.mock.calls[1][0].content).not.toContain("FROZEN-1");
    expect(saveTextExport.mock.calls[1][0].content).not.toContain("FROZEN-3");
  });

  it("keeps a healthy selected version exportable when comparison opens a stored old version with null task metadata", async () => {
    const task = createFictionalDemoTask("en");
    const older = { ...task.reportVersions[0], id: "stored-malformed-old", runId: "old-run", versionNumber: 1,
      task: null, reportSections: { market_report: "OLD-EXACT\r\n", final_trade_decision: "Rating: Hold" } };
    const latest = { ...task.reportVersions[0], id: "stored-healthy-latest", runId: "latest-run", versionNumber: 2,
      reportSections: { market_report: "LATEST-EXACT\r\n", final_trade_decision: "Rating: Hold" } };
    localStorage.setItem("evidenceloom.analysisTasks.v1", JSON.stringify([{ ...task, reportVersions: [older, latest] }]));
    const retained = loadTasks()[0];
    const frozen = JSON.stringify(retained);
    expect(retained.reportVersions[0].task).toBeNull();
    await act(async () => root.render(createElement(ReportVersionsPanel, { task: retained, language: "en" })));
    const disclosure = [...container.querySelectorAll<HTMLDetailsElement>("details")].find(d => d.querySelector(":scope > summary")?.textContent === "Compare saved report versions")!;
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
    const baseline = container.querySelector('[aria-label="Baseline v1"]')!;
    expect(baseline.textContent).toContain("Some saved version metadata is unavailable");
    const instrument = [...baseline.querySelectorAll("dt")].find(dt => dt.textContent === "Instrument")!;
    expect(instrument.nextElementSibling?.textContent).toBe("Not recorded · unknown");
    expect(container.querySelector('[aria-label="Baseline v1 · Market Analysis"] pre')?.textContent).toBe("OLD-EXACT\r\n");
    const selected = container.querySelector<HTMLSelectElement>("#report-version-select")!;
    expect(selected.value).toBe(latest.id);
    const targetLabel = [...container.querySelectorAll<HTMLLabelElement>("label")].find(l => l.textContent === "Target")!;
    const target = document.getElementById(targetLabel.htmlFor) as HTMLSelectElement;
    await act(async () => { target.value = older.id; target.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { target.value = latest.id; target.dispatchEvent(new Event("change", { bubbles: true })); });
    const json = [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "Report JSON")!;
    await act(async () => json.click());
    expect(JSON.parse(saveTextExport.mock.calls[0][0].content).report.id).toBe(latest.id);
    expect(JSON.stringify(retained)).toBe(frozen);
  });

  it("shows only public manifest fields from actual persisted versions without exposing saved extensions", async () => {
    const task = createFictionalDemoTask("en");
    const version = { ...task.reportVersions[0], run: { ...task.reportVersions[0].run!,
      privateExtension: { body: "OWNED-PRIVATE-MANIFEST-SENTINEL" },
      runtimeRunSettings: { temperature: "0.1250", privateExtension: "OWNED-PRIVATE-NESTED-SENTINEL" } } };
    localStorage.setItem("evidenceloom.analysisTasks.v1", JSON.stringify([{ ...task, reportVersions: [version, { ...version, id: "stored-second", runId: "run-second", versionNumber: 2 }] }]));
    const retained = loadTasks()[0];
    const frozen = JSON.stringify(retained);
    await act(async () => root.render(createElement(ReportVersionsPanel, { task: retained, language: "en" })));
    const disclosure = [...container.querySelectorAll<HTMLDetailsElement>("details")].find(d => d.querySelector(":scope > summary")?.textContent === "Compare saved report versions")!;
    await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
    expect(disclosure.textContent).toContain('"temperature": "0.1250"');
    expect(disclosure.textContent).not.toContain("OWNED-PRIVATE");
    expect(JSON.stringify(retained)).toBe(frozen);
  });

  it("binds the prominent frozen dates, report text and checks to the selected version rather than the live task", async () => {
    const original = createFictionalDemoTask("en");
    const first = { ...original.reportVersions[0], id: "guide-first", runId: "guide-run-first", versionNumber: 1,
      createdAt: "2024-01-02T10:00:00.000Z", task: { ...original.reportVersions[0].task, analysisDate: "2024-01-01" },
      reportSections: { market_report: "FIRST-SAVED-REPORT" },
      outputQuality: { portfolio_manager: { status: "unvalidated_text", schema: "PortfolioDecision", source: "raw_response", reason: "no_tool_call" } } as const };
    const second = { ...first, id: "guide-second", runId: "guide-run-second", versionNumber: 2,
      createdAt: "2025-02-04T11:00:00.000Z", task: { ...first.task, analysisDate: "2025-02-03" },
      reportSections: { market_report: "SECOND-SAVED-REPORT" },
      outputQuality: { portfolio_manager: { status: "validated_schema", schema: "PortfolioDecision", source: "structured" } } as const };
    const task = { ...original, analysisDate: "2026-10-07", reportSections: { market_report: "CURRENT-UNSAVED-REPORT" }, reportVersions: [first, second] };
    await act(async () => root.render(createElement(ReportVersionsPanel, { task, language: "en" })));
    const selected = container.querySelector<HTMLSelectElement>("#report-version-select")!;
    const context = () => container.querySelector('[aria-label="Selected saved report v' + (selected.value === first.id ? "1" : "2") + '"]')!;
    expect(context().querySelector('time[datetime="2025-02-04T11:00:00.000Z"]')).not.toBeNull();
    expect(context().querySelector('time[datetime="2025-02-03"]')).not.toBeNull();
    const checks = container.querySelector("#selected-report-evidence")!;
    expect(checks.textContent).toContain("Format validated");
    await act(async () => { selected.value = first.id; selected.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(context().querySelector('time[datetime="2024-01-02T10:00:00.000Z"]')).not.toBeNull();
    expect(context().querySelector('time[datetime="2024-01-01"]')).not.toBeNull();
    expect(context().textContent).not.toContain("2026-10-07");
    expect(container.querySelector("#selected-report-body")?.textContent).toContain("FIRST-SAVED-REPORT");
    expect(container.querySelector("#selected-report-body")?.textContent).not.toContain("SECOND-SAVED-REPORT");
    expect(checks.textContent).toContain("Text fallback · format unvalidated");
    await act(async () => root.render(createElement(ReportVersionsPanel, { task: { ...task, reportSections: { market_report: "ARRIVING-UNSAVED-REPORT" } }, language: "en" })));
    expect(selected.value).toBe(first.id);
    expect(container.textContent).not.toContain("CURRENT-UNSAVED-REPORT");
    expect(container.textContent).not.toContain("ARRIVING-UNSAVED-REPORT");
  });

  it("opens the actual collapsed selected report and moves focus when its bilingual navigation is activated", async () => {
    const task = createFictionalDemoTask("en");
    for (const language of ["en", "zh"] as const) {
      await act(async () => root.render(createElement(ReportVersionsPanel, { task, language })));
      const preview = container.querySelector<HTMLDetailsElement>("#selected-report-body")!;
      preview.open = false;
      const navigation = container.querySelector(language === "zh" ? '[aria-label="所选报告导览"]' : '[aria-label="Selected report navigation"]')!;
      const textLink = navigation.querySelector<HTMLAnchorElement>('a[href="#selected-report-body"]')!;
      textLink.focus();
      expect(document.activeElement).toBe(textLink);
      await act(async () => textLink.click());
      expect(preview.open).toBe(true);
      expect(document.activeElement).toBe(preview);
      expect(preview.querySelector('[aria-label]')?.getAttribute("aria-label")).toBe(language === "zh" ? "报告版本 v1 预览" : "Report version v1 preview");
      for (const href of ["#selected-report-evidence", "#selected-report-review"]) {
        expect(navigation.querySelector(`a[href="${href}"]`)).not.toBeNull();
        expect(container.querySelector(href)?.getAttribute("tabindex")).toBe("-1");
      }
    }
  });

  it("does not synthesize saved versions from completed prose and keeps persisted legacy and fictional boundaries explicit", async () => {
    const original = createFictionalDemoTask("en");
    const unsaved = { ...original, origin: "analysis" as const, status: "completed" as const,
      reportVersions: [], reportSections: { market_report: "COMPLETED-BUT-NOT-A-SAVED-VERSION" } };
    for (const language of ["en", "zh"] as const) {
      await act(async () => root.render(createElement(ReportVersionsPanel, { task: unsaved, language })));
      expect(container.querySelector("#report-version-select")).toBeNull();
      expect(container.querySelector("#selected-report-body")).toBeNull();
      expect(container.textContent).not.toContain("COMPLETED-BUT-NOT-A-SAVED-VERSION");
      expect(container.textContent).toContain(language === "zh" ? "任务成功完成后即可导出只读报告。" : "A read-only report becomes available after a successful run.");
      const legacy = { ...original.reportVersions[0], legacy: true, run: null, id: "persisted-legacy-guide", runId: "persisted-legacy-run" };
      const saved = { ...unsaved, reportVersions: [legacy] };
      await act(async () => root.render(createElement(ReportVersionsPanel, { task: saved, language })));
      expect(container.querySelector<HTMLSelectElement>("#report-version-select")?.value).toBe(legacy.id);
      expect(container.textContent).toContain(language === "zh" ? "历史版本未记录" : "Not recorded for this historical version");
      const preview = container.querySelector("#selected-report-body")!;
      expect(preview.textContent).toContain(language === "zh" ? "仅供研究参考，不构成金融、投资、法律或交易建议" : "for research only. It is not financial, investment, legal, or trading advice");
      expect(preview.textContent).not.toContain(language === "zh" ? "完全虚构的演示报告：" : "Entirely fictional demo report:");
      await act(async () => root.render(createElement(ReportVersionsPanel, { task: original, language })));
      expect(container.querySelector("#selected-report-body")?.textContent).toContain(language === "zh" ? "完全虚构的演示报告：" : "Entirely fictional demo report:");
    }
    expect(unsaved.reportVersions).toEqual([]);
    expect(saveTextExport).not.toHaveBeenCalled();
  });
});
