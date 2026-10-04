import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportVersion } from "@/lib/types";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { ReportVersionComparison } from "./ReportVersionComparison";

const template = createFictionalDemoTask("en").reportVersions[0];
function saved(number: number, changes: Partial<ReportVersion> = {}): ReportVersion {
  return { ...template, id: `saved-${number}`, runId: `run-${number}`, versionNumber: number,
    task: { ...template.task, ticker: `FICTIONAL-${number}`, analysisDate: `2025-02-${10 + number}` },
    reportSections: { market_report: `original-${number}` }, ...changes };
}

describe("saved report comparison interaction", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetch.mockReset().mockRejectedValue(new Error("comparison must not fetch")));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove(); vi.unstubAllGlobals();
  });
  async function render(versions: ReportVersion[], taskId = "task", language: "en" | "zh" = "en") {
    await act(async () => root.render(createElement(ReportVersionComparison, { taskId, reportVersions: versions, language })));
  }
  async function toggle(details: HTMLDetailsElement, open: boolean) {
    await act(async () => { details.open = open; details.dispatchEvent(new Event("toggle")); });
  }
  function selector(label: string) {
    const element = [...container.querySelectorAll("label")].find((entry) => entry.textContent === label)!;
    return document.getElementById(element.htmlFor) as HTMLSelectElement;
  }
  async function select(label: string, value: string) {
    const element = selector(label);
    await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
  }

  it("starts closed and shows each saved side's identity, format quality, legacy, and recorded validation state", async () => {
    const older = saved(1, { legacy: true, run: null, evidenceBundle: undefined, memoryBundle: undefined, decision: "Buy",
      outputQuality: { portfolio_manager: { status: "unvalidated_text", schema: "PortfolioDecision", source: "raw_response", reason: "no_tool_call" } } });
    const newer = saved(2, { decision: "Sell", evidenceValidation: { status: "invalid", reason: "hash_mismatch" },
      memoryBundle: createFictionalDemoTask("en", true).reportVersions[0].memoryBundle,
      outputQuality: { portfolio_manager: { status: "validated_schema", schema: "PortfolioDecision", source: "structured" } } });
    await render([newer, older]);
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).not.toContain("original-1");
    await toggle(container.querySelector("details")!, true);
    expect(selector("Baseline").value).toBe(older.id);
    expect(selector("Target").value).toBe(newer.id);
    const baseline = container.querySelector('[aria-label="Baseline v1"]')!;
    const target = container.querySelector('[aria-label="Target v2"]')!;
    expect(baseline.textContent).toContain("saved-1"); expect(baseline.textContent).toContain("run-1");
    expect(baseline.textContent).toContain("FICTIONAL-1"); expect(baseline.textContent).toContain("2025-02-11");
    expect(baseline.textContent).toContain("Buy"); expect(baseline.textContent).toContain("Text fallback · format unvalidated");
    expect(baseline.textContent).toContain("Not recorded · unknown");
    expect(target.textContent).toContain("Sell"); expect(target.textContent).toContain("Format validated");
    expect(target.textContent).toContain("Recorded validation error: hash_mismatch");
    expect(target.textContent).toContain("Saved · not revalidated here");
    expect(baseline.querySelector('section[aria-label="Output format quality"] > h5')?.textContent).toBe("Output format quality");
    expect(container.textContent).toContain("do not establish better research");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows exact saved CRLF and whitespace without interpreting untrusted markup or rounding decimals", async () => {
    const raw = "  001.2300\r\n<img src=x onerror=alert(1)>\t ";
    await render([saved(1, { reportSections: { market_report: raw, sentiment_report: null, news_report: "", fundamentals_report: " \t\r\n" } }),
      saved(2, { reportSections: { market_report: raw.replace(/\r\n/g, "\n"), news_report: null } })]);
    await toggle(container.querySelector("details")!, true);
    const baseline = container.querySelector('[aria-label="Baseline v1 · Market Analysis"]')!;
    expect(baseline.querySelector("pre")?.textContent).toBe(raw);
    expect(baseline.querySelectorAll("pre")[1].textContent).toBe(JSON.stringify(raw));
    expect(container.querySelector("img")).toBeNull(); expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("Recorded null"); expect(container.textContent).toContain("Section not recorded");
    expect(container.textContent).toContain("Recorded empty string"); expect(container.textContent).toContain("Whitespace-only string");
    expect(container.querySelectorAll("nav a")).toHaveLength(7);
    expect(container.querySelectorAll("nav a")[0].textContent).toContain("Changed");
    const sides = container.querySelector('summary[id$="market_report"]')!.parentElement!.querySelectorAll("section");
    expect(sides[0].getAttribute("aria-label")).toBe("Baseline v1 · Market Analysis");
    expect(sides[1].getAttribute("aria-label")).toBe("Target v2 · Market Analysis");
  });

  it("retains selectors, focus, and section disclosure state through selection and arriving versions", async () => {
    const versions = [saved(1), saved(2), saved(3)];
    await render(versions); await toggle(container.querySelector("details")!, true);
    const baselineSelector = selector("Baseline"); baselineSelector.focus();
    const newsSummary = container.querySelector<HTMLElement>('summary[id$="news_report"]')!;
    const newsDetails = newsSummary.parentElement as HTMLDetailsElement;
    await toggle(newsDetails, true);
    await select("Baseline", "saved-1");
    expect(selector("Baseline")).toBe(baselineSelector);
    expect(document.activeElement).toBe(baselineSelector);
    expect(newsDetails.open).toBe(true);
    await render([...versions, saved(4)]);
    expect(selector("Baseline").value).toBe("saved-1"); expect(selector("Target").value).toBe("saved-3");
    expect(document.activeElement).toBe(baselineSelector); expect(newsDetails.open).toBe(true);
    await toggle(container.querySelector("details")!, false);
    expect(container.querySelector("select")).toBeNull();
    await toggle(container.querySelector("details")!, true);
    expect(selector("Baseline").value).toBe("saved-1");
    expect((container.querySelector('summary[id$="news_report"]')!.parentElement as HTMLDetailsElement).open).toBe(true);
  });

  it("supports same-version comparison explicitly and resets another task despite colliding IDs", async () => {
    const versions = [saved(1), saved(2)];
    await render(versions); await toggle(container.querySelector("details")!, true);
    await select("Target", "saved-1");
    expect(container.textContent).toContain("Both sides select the same saved version.");
    expect(container.textContent).toContain("0 of 7 original sections changed.");
    await render([saved(1, { reportSections: { market_report: "another task older" } }), saved(2, { reportSections: { market_report: "another task newer" } })], "another-task");
    expect(selector("Baseline").value).toBe("saved-1"); expect(selector("Target").value).toBe("saved-2");
    expect(container.textContent).not.toContain("original-1");
    expect(container.textContent).toContain("another task older"); expect(container.textContent).toContain("another task newer");
  });

  it("restores whitespace and manifest disclosure choices after an intermediate version lacks those records", async () => {
    const versions = [saved(1), saved(2, { run: null, reportSections: {} }), saved(3)];
    await render(versions); await toggle(container.querySelector("details")!, true);
    await select("Baseline", "saved-1");
    await toggle(container.querySelector('[aria-label="Baseline v1 · Market Analysis"] details')!, true);
    await toggle(container.querySelector('[aria-label="Target v3"] > details')!, true);
    await select("Baseline", "saved-2"); await select("Target", "saved-2");
    expect(container.querySelector('[aria-label="Baseline v2 · Market Analysis"] details')).toBeNull();
    expect(container.querySelector('[aria-label="Target v2"] > details')).toBeNull();
    await select("Baseline", "saved-1"); await select("Target", "saved-3");
    expect((container.querySelector('[aria-label="Baseline v1 · Market Analysis"] details') as HTMLDetailsElement).open).toBe(true);
    expect((container.querySelector('[aria-label="Target v3"] > details') as HTMLDetailsElement).open).toBe(true);
  });

  it("uses unique label and navigation IDs across panels, opens linked sections, and changes locale without resetting selection", async () => {
    const versions = [saved(1), saved(2), saved(3)];
    await act(async () => root.render(createElement("div", {},
      createElement(ReportVersionComparison, { taskId: "task", reportVersions: versions, language: "en" }),
      createElement(ReportVersionComparison, { taskId: "task", reportVersions: versions, language: "en" }))));
    for (const details of [...container.querySelectorAll<HTMLDetailsElement>("div > details")]) await toggle(details, true);
    const ids = [...container.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const label of container.querySelectorAll("label")) expect(document.getElementById(label.htmlFor)?.tagName).toBe("SELECT");
    const link = [...container.querySelectorAll<HTMLAnchorElement>("nav a")].find((anchor) => anchor.textContent?.startsWith("News Analysis"))!;
    await act(async () => link.click());
    expect((document.getElementById(link.hash.slice(1))!.parentElement as HTMLDetailsElement).open).toBe(true);
    await render(versions);
    await toggle(container.querySelector("details")!, true); await select("Baseline", "saved-1");
    await render(versions, "task", "zh");
    expect(selector("基线版本").value).toBe("saved-1"); expect(selector("目标版本").value).toBe("saved-3");
    expect(container.querySelector('nav[aria-label="报告章节比较"]')).not.toBeNull();
    expect(container.textContent).toContain("内容变化不证明研究更好");
  });

  it("does not substitute live content when saved history is absent or has only one version", async () => {
    await render([]); await toggle(container.querySelector("details")!, true);
    expect(container.textContent).toContain("Two saved report versions are needed"); expect(container.querySelector("select")).toBeNull();
    await render([saved(1)]);
    expect(container.textContent).toContain("Two saved report versions are needed"); expect(container.textContent).not.toContain("original-1");
  });

  it("shows unavailable sections without coercing or exposing malformed saved content", async () => {
    const malformed = saved(1, { reportSections: { market_report: { privateSentinel: "UNTRUSTED-OBJECT-BODY" }, news_report: undefined } as unknown as ReportVersion["reportSections"] });
    await render([malformed, saved(2)]); await toggle(container.querySelector("details")!, true);
    expect(container.textContent).toContain("2 sections could not be compared.");
    expect(container.textContent).toContain("Unsupported saved section value · unavailable");
    expect(container.textContent).not.toContain("UNTRUSTED-OBJECT-BODY");
    expect(container.querySelector('[aria-label="Baseline v1 · Market Analysis"] pre')).toBeNull();
    expect(container.querySelectorAll("nav a")[0].textContent).toContain("Cannot compare");
    await render([{ ...malformed, reportSections: null } as unknown as ReportVersion, saved(2)]);
    expect(container.textContent).toContain("7 sections could not be compared.");
    expect(container.querySelectorAll("nav a")[0].textContent).not.toContain("Same");
  });

  it("blocks ambiguous version IDs instead of presenting either duplicate as the selected owner", async () => {
    await render([saved(1), saved(2, { id: "saved-1", reportSections: { market_report: "ambiguous-second" } })]);
    await toggle(container.querySelector("details")!, true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("version ownership is ambiguous");
    expect(container.querySelector("select")).toBeNull(); expect(container.querySelector("nav")).toBeNull();
    expect(container.textContent).not.toContain("original-1"); expect(container.textContent).not.toContain("ambiguous-second");
    await render([saved(1), saved(2)], "task", "zh");
    expect(selector("基线版本").value).toBe("saved-1"); expect(selector("目标版本").value).toBe("saved-2");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps valid owners selectable while unsupported IDs and metadata remain explicit and unavailable", async () => {
    const unsupported = { toString: false, valueOf: false, privateSentinel: "UNSUPPORTED-METADATA-BODY" };
    const malformed = saved(1, { task: null, versionNumber: unsupported, createdAt: unsupported,
      runId: unsupported, decision: unsupported, legacy: unsupported } as unknown as Partial<ReportVersion>);
    await render([malformed, saved(2), saved(3, { id: unsupported } as unknown as Partial<ReportVersion>)]);
    await toggle(container.querySelector("details")!, true);
    expect(container.textContent).toContain("unsupported or missing IDs");
    expect(selector("Baseline").options).toHaveLength(2);
    expect(selector("Target").options).toHaveLength(2);
    expect(container.textContent).toContain("Some saved version metadata is unavailable");
    expect(container.textContent).not.toContain("UNSUPPORTED-METADATA-BODY");
    await select("Baseline", "saved-2");
    expect(container.textContent).toContain("Both sides select the same saved version.");
    expect(container.textContent).not.toContain("Some saved version metadata is unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
