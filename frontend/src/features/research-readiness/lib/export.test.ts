import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisTask } from "@/lib/types";
import { sha256 } from "@/features/evidence/lib/validation";
import { useReportExport } from "@/features/report-export/hooks/useReportExport";
import type { ExportFormat } from "@/features/report-export/types";
import { component, readinessFixture, reassessTask } from "../fixtures/test-data";
import { verifyResearchReadiness } from "./validation";

const { saveTextExport } = vi.hoisted(() => ({ saveTextExport: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ getRuntimeAdapter: () => ({ saveTextExport }) }));
describe("complete verified input-contract exports", () => {
  let root: Root; let container: HTMLDivElement; let exportSelected: (format: ExportFormat) => Promise<void>;
  function Session({ task }: { task: AnalysisTask }) {
    const session = useReportExport(task, "en"); exportSelected = session.exportVersion;
    return createElement("p", { role: "status" }, session.message);
  }
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); saveTextExport.mockReset().mockResolvedValue({ status: "saved" }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  it.each(["html", "md", "json"] as const)("blocks a corrupt assessment before saving %s", async (format) => {
    const task = await readinessFixture(); task.reportVersions[0].researchReadiness!.assessment_sha256 = "a".repeat(64);
    await act(async () => root.render(createElement(Session, { task }))); await act(async () => exportSelected(format));
    expect(saveTextExport).not.toHaveBeenCalled(); expect(container.textContent).toContain("hash_mismatch");
  });
  it.each(["html", "md", "json"] as const)("blocks coherently rehashed incorrect input references before saving %s", async (format) => {
    const task = await readinessFixture(); const version = task.reportVersions[0]; version.researchReadiness!.evidence_inputs[0].output_sha256 = "a".repeat(64);
    version.researchReadiness = await component(version.researchReadiness!, "assessment_sha256");
    await act(async () => root.render(createElement(Session, { task }))); await act(async () => exportSelected(format));
    expect(saveTextExport).not.toHaveBeenCalled(); expect(container.textContent).toContain("reference_mismatch");
  });
  it.each(["html", "md", "json"] as const)("preserves complete contract and source payloads through %s with untrusted prose", async (format) => {
    let task = await readinessFixture(); const evidence = task.evidenceBundle!; const record = evidence.records[0]; const previous = record.output_sha256;
    const artifact = { ...evidence.artifacts[previous], payload: evidence.artifacts[previous].payload + '\nENTRY_END\nREFLECTION\n<script>window.syntheticAttack=true</script>\n``````' };
    record.output_sha256 = await sha256(artifact); evidence.artifacts[record.output_sha256] = artifact; delete evidence.artifacts[previous]; task = await reassessTask(task);
    const frozen = JSON.stringify(task.reportVersions[0].researchReadiness); const payloads = Object.values(task.evidenceBundle!.artifacts).map((item) => item.payload);
    await act(async () => root.render(createElement(Session, { task }))); await act(async () => exportSelected(format));
    expect(saveTextExport).toHaveBeenCalledOnce(); const content = saveTextExport.mock.calls[0][0].content as string;
    if (format === "json") {
      const report = JSON.parse(content); expect(JSON.stringify(report.research_readiness)).toBe(frozen);
      expect(Object.values(report.evidence_bundle.artifacts).map((item) => (item as {payload:string}).payload)).toEqual(payloads);
      await expect(verifyResearchReadiness(report.research_readiness, report.evidence_bundle)).resolves.toBeDefined();
    } else if (format === "html") {
      const document = new DOMParser().parseFromString(content, "text/html");
      expect(document.querySelector("script")).toBeNull(); expect(content).toContain("&lt;script&gt;");
      const readiness = JSON.parse(document.querySelector("#research-readiness-json")!.textContent!);
      const savedEvidence = JSON.parse(document.querySelector("#evidence-bundle-json")!.textContent!);
      expect(JSON.stringify(readiness)).toBe(frozen); await expect(verifyResearchReadiness(readiness, savedEvidence)).resolves.toBeDefined();
    } else {
      expect(content).toContain("Research input-check appendix"); expect(content).toContain("They do not prove factual claims");
      const readinessSection = content.split("## Research input-check appendix")[1]; const payload = readinessSection.slice(readinessSection.indexOf("```json\n") + 8).split("\n```")[0];
      expect(JSON.stringify(JSON.parse(payload))).toBe(frozen); expect(content).toContain("```````json"); expect(content).toContain("ENTRY_END");
    }
  });
  it("freezes selected input checks before asynchronous verification", async () => {
    const task = await readinessFixture(); const expected = task.reportVersions[0].researchReadiness!.assessment_sha256;
    await act(async () => root.render(createElement(Session, { task })));
    let pending!: Promise<void>; await act(async () => { pending = exportSelected("json"); task.reportVersions[0].researchReadiness!.assessment_sha256 = "a".repeat(64); await pending; });
    expect(JSON.parse(saveTextExport.mock.calls[0][0].content).research_readiness.assessment_sha256).toBe(expected);
  });
});
