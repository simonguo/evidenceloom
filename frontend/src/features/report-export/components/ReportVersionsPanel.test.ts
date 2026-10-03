import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { ReportVersionsPanel } from "./ReportVersionsPanel";

const { saveTextExport } = vi.hoisted(() => ({ saveTextExport: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ getRuntimeAdapter: () => ({ saveTextExport }) }));

describe("selected immutable report review", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    saveTextExport.mockReset().mockResolvedValue({ status: "saved" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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
});
