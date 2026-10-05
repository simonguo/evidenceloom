import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../../../tests/fixtures/evidence_bundle_v1.json";
import { copyEvidenceBundle, sha256 } from "../lib/validation";
import { EvidenceInspector } from "./EvidenceInspector";

describe("research evidence inspector", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("crypto", webcrypto);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it("shows exact observed payloads and missing citation IDs, while corruption stays explicit", async () => {
    const bundle = copyEvidenceBundle(fixture);
    const id = bundle.records[0].id;
    bundle.citation_audit.market_report = { referenced_ids: [id, "missing-id"], unresolved_ids: ["missing-id"], status: "unresolved" };
    const { bundle_sha256: _, ...body } = bundle;
    bundle.bundle_sha256 = await sha256(body);
    const reports = { market_report: `Source [E:${id}] and [E:missing-id].` };
    await act(async () => { root.render(createElement(EvidenceInspector, { bundle, reports, language: "en" })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.textContent).toContain("Content hashes verified");
    expect(container.textContent).toContain("Observed source: tencent");
    expect(container.textContent).toContain("Unknown / not observed");
    expect(container.textContent).toContain("missing: missing-id");
    expect(container.textContent).toContain('{"close":123.45678901234567,"integral":1.0,"tiny":1e-07}');
    expect(container.textContent).toContain("It does not prove factual support");
    expect(container.textContent).toContain(bundle.artifacts[bundle.records[0].output_sha256].payload);
    const corrupted = structuredClone(bundle);
    corrupted.artifacts[corrupted.records[0].output_sha256].payload += " tampered";
    await act(async () => { root.render(createElement(EvidenceInspector, { bundle: corrupted, reports, language: "en" })); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.textContent).toContain("Invalid evidence bundle; verification failed");
    expect(container.textContent).toContain("hash_mismatch");
    expect(container.textContent).not.toContain("tampered");
    await act(async () => { root.render(createElement(EvidenceInspector, { reports: {}, language: "en" })); });
    expect(container.textContent).toContain("provenance unknown");
    expect(container.textContent).not.toContain("Content hashes verified");
  });
});
