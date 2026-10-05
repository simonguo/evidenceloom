import { describe, expect, it } from "vitest";
import { defaultAnalysisForm } from "@/lib/analysis";
import type { AnalysisEvent } from "@/lib/types";
import {
  appendCompletedReportVersion,
  createRunContext,
} from "@/features/report-export/lib/versioning";
import { saveVerifiedTasks, loadTasks } from "@/features/persistence/local-storage";
import { changeFixture } from "../fixtures/modified-identity";
import { verifyIdentityTasks } from "./tasks";

describe("completed request assessment version boundary", () => {
  it("freezes both event representations in the new version and preserves them through ordinary reload", async () => {
    window.localStorage.clear();
    const frozen = await changeFixture((task) => {
      task.reportSections.final_trade_decision = "Rating: REVIEW";
    }, true);
    const task = {
      ...frozen,
      origin: "analysis" as const,
      status: "completed" as const,
      reportVersions: [],
      evidenceBundle: undefined,
      reportTextSnapshot: undefined,
      effectiveRequestIdentity: undefined,
    };
    const event: AnalysisEvent = {
      type: "completed",
      decision: "REVIEW",
      reportSections: structuredClone(frozen.reportSections),
      evidenceBundle: structuredClone(frozen.evidenceBundle),
      reportTextSnapshot: structuredClone(frozen.reportTextSnapshot),
      effectiveRequestIdentity: structuredClone(frozen.effectiveRequestIdentity),
      finalState: {
        report_text_snapshot: structuredClone(frozen.reportTextSnapshot),
        effective_request_identity: structuredClone(frozen.effectiveRequestIdentity),
      },
    };
    const versioned = appendCompletedReportVersion(
      task,
      event,
      createRunContext(defaultAnalysisForm(), frozen.evidenceBundle!.run_id),
      frozen.reportTextSnapshot!.captured_at,
    );
    expect(versioned.reportVersions[0].effectiveRequestIdentity).toEqual(
      frozen.effectiveRequestIdentity,
    );
    event.effectiveRequestIdentity!.records.pop();
    expect(versioned.reportVersions[0].effectiveRequestIdentity).toEqual(
      frozen.effectiveRequestIdentity,
    );
    await saveVerifiedTasks([versioned]);
    expect(
      (await verifyIdentityTasks(loadTasks()))[0].reportVersions[0].effectiveRequestIdentity,
    ).toEqual(frozen.effectiveRequestIdentity);
  });
  it("a marked completed event cannot omit the required attachment", async () => {
    const frozen = await changeFixture(() => {}, true);
    const task = {
      ...frozen,
      origin: "analysis" as const,
      reportVersions: [],
      effectiveRequestIdentity: undefined,
    };
    const event: AnalysisEvent = {
      type: "completed",
      decision: "REVIEW",
      reportSections: frozen.reportSections,
      evidenceBundle: frozen.evidenceBundle,
      reportTextSnapshot: frozen.reportTextSnapshot,
    };
    const versioned = appendCompletedReportVersion(
      task,
      event,
      createRunContext(defaultAnalysisForm(), frozen.evidenceBundle!.run_id),
    );
    expect(versioned.reportVersions[0].identityValidation?.reason).toBe("reference_mismatch");
  });
  it("completion retries never add an attachment to an already frozen legacy version", async () => {
    const frozen = await changeFixture(() => {});
    const task = {
      ...frozen,
      origin: "analysis" as const,
      effectiveRequestIdentity: undefined,
      reportVersions: [{ ...frozen.reportVersions[0], effectiveRequestIdentity: undefined }],
    };
    const event: AnalysisEvent = {
      type: "completed",
      effectiveRequestIdentity: frozen.effectiveRequestIdentity,
      reportTextSnapshot: frozen.reportTextSnapshot,
      reportSections: frozen.reportSections,
      evidenceBundle: frozen.evidenceBundle,
    };
    expect(
      appendCompletedReportVersion(
        task,
        event,
        createRunContext(defaultAnalysisForm(), frozen.evidenceBundle!.run_id),
      ),
    ).toBe(task);
    expect(task.reportVersions[0].effectiveRequestIdentity).toBeUndefined();
  });
});
