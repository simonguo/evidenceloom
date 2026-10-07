import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportVersion } from "@/lib/types";
import type { EvidenceBundle } from "@/features/evidence/types";
import { citationReferences, sha256 } from "@/features/evidence/lib/validation";
import { EvidenceInspector } from "@/features/evidence/components/EvidenceInspector";
import { createFictionalDemoTask } from "../fixtures/fictional-demo";
import { savedEvidenceScope } from "../lib/saved-report-citations";
import { ReportVersionPreview } from "./ReportVersionPreview";

const recordId = `ev-${"a".repeat(32)}`;
const missingId = `ev-${"b".repeat(32)}`;
const taskId = "saved-task:one/owned";

async function savedVersion(id: string, text: string, number = 1): Promise<ReportVersion> {
  const original = createFictionalDemoTask("en").reportVersions[0];
  const runId = number === 1 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
  const artifact = { kind: "tool_text" as const, payload: `[E:${recordId}]\nFictional saved input for ${id}.` };
  const artifactHash = await sha256(artifact);
  const references = citationReferences(text);
  const unresolved = references.filter((reference) => reference !== recordId);
  const body: Omit<EvidenceBundle, "bundle_sha256"> = {
    schema_version: 1, run_id: runId, instrument: original.task.ticker,
    analysis_date: original.task.analysisDate, research_as_of: `${original.task.analysisDate}T23:59:59.999999Z`,
    as_of_policy: "analysis_date_end_utc", market_timezone: null, created_at: original.createdAt,
    manifest: {}, manifest_sha256: await sha256({}),
    records: [{ id: recordId, analyst: "market", tool: "get_stock_data", instrument: original.task.ticker,
      parameters: { ticker: original.task.ticker }, status: "available", fetched_at: original.createdAt,
      output_sha256: artifactHash, sources: [], attempts: [] }],
    artifacts: { [artifactHash]: artifact },
    citation_audit: { market_report: { referenced_ids: references, unresolved_ids: unresolved,
      status: unresolved.length ? "unresolved" : references.length ? "resolved" : "none" } },
  };
  return { ...original, id, runId, versionNumber: number, reportSections: { market_report: text },
    evidenceBundle: { ...body, bundle_sha256: await sha256(body) } };
}

describe("saved report citation navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("crypto", webcrypto);
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  });

  function renderSaved(version: ReportVersion, owner = taskId) {
    return createElement("div", null,
      createElement(ReportVersionPreview, { version, taskId: owner, origin: "analysis", language: "en" }),
      createElement("details", { "data-test-evidence-container": "saved" },
        createElement("summary", null, "Saved evidence details"),
        createElement(EvidenceInspector, { bundle: version.evidenceBundle, invalid: version.evidenceValidation,
          reports: version.reportSections, language: "en", recordScope: savedEvidenceScope(owner, version.id) })),
      createElement(EvidenceInspector, { bundle: version.evidenceBundle, reports: version.reportSections, language: "en" }));
  }
  const citationLinks = () => [...container.querySelectorAll<HTMLAnchorElement>('a[aria-label^="View evidence in this saved version:"]')];
  async function waitForCitation() {
    await vi.waitFor(async () => { await act(async () => {}); expect(citationLinks()).toHaveLength(1); });
  }
  const savedRecord = (version: ReportVersion, owner = taskId) => document.getElementById(`${savedEvidenceScope(owner, version.id)}:${recordId}`) as HTMLDetailsElement;

  it("opens and focuses the actual saved record on click or Enter without opening its live counterpart", async () => {
    const version = await savedVersion("version:one/owned", `Saved statement [E:${recordId}].`);
    const original = JSON.stringify(version);
    await act(async () => root.render(renderSaved(version)));
    await waitForCitation();
    await vi.waitFor(async () => { await act(async () => {}); expect(savedRecord(version)).not.toBeNull(); expect(document.getElementById(recordId)).not.toBeNull(); });
    const target = savedRecord(version);
    const enclosing = target.closest<HTMLDetailsElement>('details[data-test-evidence-container="saved"]')!;
    const live = document.getElementById(recordId) as HTMLDetailsElement;
    expect(decodeURIComponent(citationLinks()[0].getAttribute("href")!.slice(1))).toBe(target.id);
    for (const activate of ["click", "Enter"] as const) {
      target.open = false; enclosing.open = false; live.open = false;
      const link = citationLinks()[0]; link.focus();
      await act(async () => {
        if (activate === "click") link.click();
        else link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });
      expect(target.open).toBe(true); expect(enclosing.open).toBe(true);
      expect(document.activeElement).toBe(target); expect(live.open).toBe(false);
    }
    expect(JSON.stringify(version)).toBe(original);
  });

  it("drops the old selection's links immediately and binds only the new task and version after verification", async () => {
    const first = await savedVersion("saved-v1", `First [E:${recordId}].`);
    const second = await savedVersion("saved-v2", `Second [E:${recordId}].`, 2);
    await act(async () => root.render(renderSaved(first))); await waitForCitation();
    await vi.waitFor(async () => { await act(async () => {}); expect(savedRecord(first)).not.toBeNull(); });
    const oldLink = citationLinks()[0], oldTarget = savedRecord(first), oldTargetId = oldTarget.id;
    oldTarget.open = false;
    // The same component must not retain a verified old-bundle receipt while the
    // next bundle is checking. A checking frame is observed with WebCrypto held.
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    let resume!: () => void;
    const blocked = new Promise<void>((resolve) => { resume = resolve; });
    vi.stubGlobal("crypto", { subtle: { digest: async (...args: Parameters<typeof digest>) => { await blocked; return digest(...args); } } });
    await act(async () => { root.render(renderSaved(second)); });
    expect(citationLinks()).toHaveLength(0);
    await act(async () => oldLink.click()); expect(oldTarget.open).toBe(false);
    await act(async () => { resume(); }); await waitForCitation();
    await vi.waitFor(async () => { await act(async () => {}); expect(savedRecord(second)).not.toBeNull(); });
    const current = savedRecord(second);
    expect(decodeURIComponent(citationLinks()[0].getAttribute("href")!.slice(1))).toBe(current.id);
    expect(current.id).not.toBe(oldTargetId);
    expect(document.getElementById(oldTargetId)).toBeNull();
    await act(async () => citationLinks()[0].click());
    expect(current.open).toBe(true); expect(document.activeElement).toBe(current);
    expect(container.querySelector('[aria-label="Report version v2 preview"]')?.textContent).toContain("Second [E:");
    const otherTask = "saved-task:two/owned";
    await act(async () => root.render(renderSaved(second, otherTask)));
    await vi.waitFor(async () => {
      await act(async () => {});
      const href = citationLinks()[0]?.getAttribute("href");
      expect(href && decodeURIComponent(href.slice(1))).toBe(`${savedEvidenceScope(otherTask, second.id)}:${recordId}`);
    });
    expect(document.getElementById(`${savedEvidenceScope(taskId, second.id)}:${recordId}`)).toBeNull();
  });

  it("leaves unresolved or malformed tokens, code and existing Markdown links unchanged while retaining external-link defaults", async () => {
    const text = `Prose [E:${recordId}]. Missing [E:${missingId}]. Invalid [E:bad-id].\n\nInline \`[E:${recordId}]\`.\n\n\`\`\`text\n[E:${recordId}]\n\`\`\`\n\n[[E:${recordId}]](https://example.com/existing) and [External](https://example.com/research).`;
    const version = await savedVersion("mixed-prose", text);
    await act(async () => root.render(renderSaved(version))); await waitForCitation();
    const preview = container.querySelector('[aria-label="Report version v1 preview"]')!;
    expect([...preview.querySelectorAll("code")].map((code) => code.textContent?.trim())).toEqual([`[E:${recordId}]`, `[E:${recordId}]`]);
    expect(preview.textContent).toContain(`[E:${missingId}]`); expect(preview.textContent).toContain("[E:bad-id]");
    const existing = preview.querySelector<HTMLAnchorElement>('a[href="https://example.com/existing"]')!;
    expect(existing.textContent).toBe(`[E:${recordId}]`); expect(existing.hasAttribute("aria-label")).toBe(false);
    const external = preview.querySelector<HTMLAnchorElement>('a[href="https://example.com/research"]')!;
    expect(external.textContent).toBe("External"); expect(external.hasAttribute("target")).toBe(false);
    expect(external.hasAttribute("rel")).toBe(false);
    expect(preview.querySelectorAll("a")).toHaveLength(3);
  });

  it("creates no citation links for missing, explicitly invalid, mismatched or content-invalid saved evidence", async () => {
    const valid = await savedVersion("invalid-source", `[E:${recordId}]`);
    await act(async () => root.render(renderSaved(valid))); await waitForCitation();
    const cases: { version: ReportVersion; observed: string }[] = [
      { version: { ...valid, evidenceBundle: undefined }, observed: "No evidence saved for this version" },
      { version: { ...valid, evidenceValidation: { status: "invalid", reason: "malformed" } }, observed: "Invalid evidence bundle; verification failed" },
      { version: { ...valid, runId: "33333333-3333-4333-8333-333333333333" }, observed: "Content hashes verified" },
      { version: { ...valid, reportSections: { market_report: `[E:${recordId}] and [E:${missingId}]` } }, observed: "citation_mismatch" },
      { version: { ...valid, evidenceBundle: { ...valid.evidenceBundle!, bundle_sha256: "0".repeat(64) } }, observed: "hash_mismatch" },
    ];
    for (const { version, observed } of cases) {
      await act(async () => root.render(renderSaved(version)));
      expect(citationLinks()).toHaveLength(0);
      await vi.waitFor(async () => { await act(async () => {}); expect(container.textContent).toContain(observed); });
      expect(citationLinks()).toHaveLength(0);
      expect(container.querySelector('[aria-label="Report version v1 preview"]')?.textContent).toContain(`[E:${recordId}]`);
    }
  });
});
