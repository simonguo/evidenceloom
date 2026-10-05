import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportVersionsPanel } from "@/features/report-export/components/ReportVersionsPanel";
import { identityFixture } from "../fixtures/fictional-identity";
import { IdentityInspector } from "./IdentityInspector";
const { saveTextExport } = vi.hoisted(() => ({ saveTextExport: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ getRuntimeAdapter: () => ({ saveTextExport }) }));
describe("scoped saved request review UI", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saveTextExport.mockReset().mockResolvedValue({ status: "saved" });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const settled = async () => {
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain("Provider request: unknown");
    });
  };
  it("shows every scoped stage without provider/entity certification and lazily renders the full receipt", async () => {
    const task = identityFixture();
    await act(async () =>
      root.render(
        createElement(IdentityInspector, { snapshot: task.reportVersions[0], language: "en" }),
      ),
    );
    await settled();
    expect(container.textContent).toContain("Saved request literal conflict");
    expect(container.textContent).toContain("Request relationship unknown");
    expect(container.textContent).toContain("Provider-resolved entity: unknown");
    expect(container.textContent).toContain("does not confirm venue");
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    for (const record of task.effectiveRequestIdentity!.records)
      expect(container.textContent).toContain(record.evidence_id);
    const details = [...container.querySelectorAll("details")].find((row) =>
      row.querySelector("summary")?.textContent?.startsWith("Complete frozen attachment"),
    )!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(JSON.parse(container.querySelector("pre")!.textContent!)).toEqual(
      task.effectiveRequestIdentity,
    );
  });
  it("combined report selection replaces one identity panel v2→legacy→v2 without old statuses", async () => {
    const task = identityFixture();
    await act(async () =>
      root.render(createElement(ReportVersionsPanel, { task, language: "en" })),
    );
    await settled();
    const panels = () =>
      container.querySelectorAll('[aria-label="Saved effective outer-request alignment"]');
    expect(panels()).toHaveLength(1);
    const select = container.querySelector<HTMLSelectElement>("#report-version-select")!;
    await act(async () => {
      select.value = task.reportVersions[1].id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain(
        "No request-alignment attachment was saved for this version",
      );
    });
    expect(panels()).toHaveLength(1);
    expect(container.textContent).not.toContain("Saved request literal conflict");
    await act(async () => {
      select.value = task.reportVersions[0].id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settled();
    expect(panels()).toHaveLength(1);
    expect(container.textContent).toContain("Saved request literal conflict");
  });
  it("blocks all actual export buttons for an invalid attachment", async () => {
    const task = identityFixture();
    task.reportVersions[0].effectiveRequestIdentity!.records.pop();
    await act(async () =>
      root.render(createElement(ReportVersionsPanel, { task, language: "en" })),
    );
    for (const label of ["Report JSON", "HTML", "Markdown"]) {
      const button = [...container.querySelectorAll("button")].find(
        (row) => row.textContent === label,
      )!;
      await act(async () => button.click());
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(container.textContent).toContain("Export failed:");
      });
    }
    expect(saveTextExport).not.toHaveBeenCalled();
  });
  it("actual selected-version JSON export freezes the attachment before awaiting hashes", async () => {
    const task = identityFixture(),
      original = structuredClone(task.reportVersions[0].effectiveRequestIdentity);
    await act(async () =>
      root.render(createElement(ReportVersionsPanel, { task, language: "en" })),
    );
    await settled();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      await gate;
      return originalDigest(...args);
    });
    const button = [...container.querySelectorAll("button")].find(
      (row) => row.textContent === "Report JSON",
    )!;
    await act(async () => button.click());
    task.reportVersions[0].effectiveRequestIdentity!.reviewed_at = "2026-02-01T12:00:00.000000Z";
    release();
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(saveTextExport).toHaveBeenCalledTimes(1);
    });
    expect(JSON.parse(saveTextExport.mock.calls[0][0].content).effective_request_identity).toEqual(
      original,
    );
  });
});
