import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeQuality, readinessFixture } from "../fixtures/test-data";
import { ReadinessInspector } from "./ReadinessInspector";

describe("saved research input inspection", () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function waitFor(text: string) {
    for (let attempt=0;attempt<80 && !container.textContent?.includes(text);attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(container.textContent).toContain(text);
  }
  it("shows input conditions separately from factual support and lazily opens the exact contract", async () => {
    const task = await readinessFixture(); const version = task.reportVersions[0];
    await act(async () => root.render(createElement(ReadinessInspector, { snapshot: version, language: "en" })));
    await waitFor("Recorded required input conditions passed");
    expect(container.textContent).toContain("They do not prove factual claims");
    expect(container.textContent).toContain("Unknown source dates and price vintage");
    expect(container.textContent).toContain("Frozen tool-round limit");
    expect(container.textContent).not.toContain('"assessment_sha256"');
    const details = [...container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === "Complete frozen input-check contract")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(container.textContent).toContain('"assessment_sha256"');
    const later = await changeQuality(task, (quality) => { quality.price_basis = { status: "unknown", value: null }; });
    await act(async () => root.render(createElement(ReadinessInspector, { snapshot: later.reportVersions[0], language: "en" })));
    await waitFor("Input conditions require review");
    expect(container.textContent).toContain("unknown_price_basis");
    expect(container.textContent).not.toContain('"assessment_sha256"');
  });
  it("shows an invalid attachment explicitly and keeps missing legacy state unknown", async () => {
    const task = await readinessFixture(); const version = task.reportVersions[0]; version.researchReadiness!.assessment_sha256 = "a".repeat(64);
    await act(async () => root.render(createElement(ReadinessInspector, { snapshot: version, language: "en" })));
    await waitFor("Invalid input contract; export blocked"); expect(container.querySelector('[role="alert"]')?.textContent).toBe("hash_mismatch");
    const legacy = { ...version, researchReadiness: undefined };
    await act(async () => root.render(createElement(ReadinessInspector, { snapshot: legacy, language: "en" })));
    await waitFor("readiness is unknown"); expect(container.textContent).not.toContain("conditions passed");
  });
});
