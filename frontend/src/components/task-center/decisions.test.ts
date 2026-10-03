import { describe, expect, it } from "vitest";
import { extractDecisionFromReport, resolveTaskDecision } from "./decisions";

describe("authoritative portfolio rating", () => {
  it.each([
    ["**Rating**: Underweight\nThe buy thesis was not convincing.", "underweight"],
    ["## 最终评级：减持/低配\n未来或转为Hold。", "underweight"],
    ["1. Rating: Sell", "sell"],
    ["Rating: Hold\nConsensus rating: Buy", "hold"],
    ["**Rating**: REVIEW", "review"],
    ["The Sell thesis is unsupported; do not Buy yet.", ""],
    ["> Rating: Buy\nThis quoted researcher is too optimistic.", ""],
    ["Rating Scale: Buy / Overweight / Hold / Underweight / Sell", ""],
    ["A researcher wrote Rating: Buy.", ""],
    ["Rating: Buy or Sell", ""],
    ["Rating: Buy/Hold/Sell\nFinal Rating: Hold", ""],
    ["评级：买入或卖出", ""],
    ["评级：增持/买入", ""],
    ["Rating: Buy (买入)", "buy"],
    ["Rating: Buy — rationale mentioning Sell", "buy"],
    ["Rating: Buy; Sell evidence is weak", "buy"],
    ["Rating: Buy: Sell evidence is weak", "buy"],
    ["Rating: Buy. Sell evidence is weak", "buy"],
  ])("reads only a decision's explicit label", (report, expected) => {
    expect(extractDecisionFromReport(report)).toBe(expected);
  });

  it("keeps the backend's rating even when the prose disagrees", () => {
    expect(resolveTaskDecision("", "Rating: Buy", { type: "completed", decision: "Underweight" })).toBe("Underweight");
    expect(resolveTaskDecision("", "Rating: Buy", { type: "completed", decision: "REVIEW" })).toBe("REVIEW");
    expect(resolveTaskDecision("", "Rating: Buy", { type: "completed", finalState: { final_rating: "Sell" } })).toBe("Sell");
  });

  it("keeps a persisted rating on hydration and uses labelled legacy fallback only when absent", () => {
    expect(resolveTaskDecision("Sell", "Rating: Buy")).toBe("Sell");
    expect(resolveTaskDecision("", "评级：增持")).toBe("Overweight");
    expect(resolveTaskDecision("", "The Buy thesis is unsupported.", { type: "completed" })).toBe("REVIEW");
    expect(resolveTaskDecision("", "Draft without a call", { type: "progress" })).toBe("");
  });
});
