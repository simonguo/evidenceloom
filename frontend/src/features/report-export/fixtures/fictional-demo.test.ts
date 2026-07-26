import { describe, expect, it, vi } from "vitest";
import {
  createFictionalDemoTask,
  FICTIONAL_DEMO_TASK_ID,
  getOrCreateFictionalDemoTask,
} from "./fictional-demo";

describe("fictional demo task", () => {
  it("is deterministic, complete, and never invokes the network", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const first = getOrCreateFictionalDemoTask([], "zh");
    const repeated = getOrCreateFictionalDemoTask([first], "zh");
    const independentlyCreated = createFictionalDemoTask("zh");

    expect(first.id).toBe(FICTIONAL_DEMO_TASK_ID);
    expect(repeated).toBe(first);
    expect(independentlyCreated).toEqual(first);
    expect(first).toMatchObject({
      origin: "demo",
      ticker: "EVDM.TEST",
      status: "completed",
    });
    expect(first.reportVersions).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("ships matching Chinese and English fictional disclosures", () => {
    const zh = createFictionalDemoTask("zh");
    const en = createFictionalDemoTask("en");

    expect(zh.instrumentName).toContain("完全虚构");
    expect(en.instrumentName).toContain("Entirely Fictional");
    expect(zh.reportSections.market_report).toContain("虚构");
    expect(en.reportSections.market_report).toContain("fictional");
  });
});
