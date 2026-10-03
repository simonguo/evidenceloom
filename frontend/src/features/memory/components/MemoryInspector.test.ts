import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryTask } from "../fixtures/test-data";
import { MemoryInspector } from "./MemoryInspector";
describe("immutable memory inspection", () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function waitForText(text: string) {
    for (let attempt = 0; attempt < 80 && !container.textContent?.includes(text); attempt++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(container.textContent).toContain(text);
  }
  it("shows verified frozen contract, completion/availability times and pending uncertainty without eager full JSON", async () => {
    const version = memoryTask().reportVersions[0];
    await act(async () => { root.render(createElement(MemoryInspector, { snapshot: version, language: "en" })); });
    await waitForText("Content hashes verified");
    expect(container.textContent).toContain("Content hashes verified");
    expect(container.textContent).toContain("2 common complete provider daily rows");
    expect(container.textContent).toContain("FICTIONAL.TEST");
    expect(container.textContent).toContain("No complete evaluation facts saved; cause unknown");
    expect(container.textContent).toContain("Price vintage");
    expect(container.textContent).toContain(version.memoryBundle!.decision_snapshot.decision.recorded_at);
    expect(container.textContent).not.toContain('"snapshot_sha256"');
    const details = [...container.querySelectorAll("details")].find((item) => item.querySelector("summary")?.textContent === "Complete memory bundle and later attachments")!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(container.textContent).toContain('"snapshot_sha256"');
    expect(container.textContent).toContain("123.45678901234567");
  });
  it("reports invalid memory explicitly rather than showing missing legacy state", async () => {
    const version = memoryTask().reportVersions[0]; version.memoryBundle!.bundle_sha256 = "a".repeat(64);
    await act(async () => root.render(createElement(MemoryInspector, { snapshot: version, language: "en" })));
    await waitForText("hash_mismatch");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("hash_mismatch");
    expect(container.textContent).not.toContain("No immutable memory attachment");
  });
});
