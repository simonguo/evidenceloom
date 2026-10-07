import { describe, expect, it, vi } from "vitest";
import { envelope, header, task } from "../test-support/fixtures";
import { reduceJournalPage } from "./reducer";
import { recoveryMessages } from "./protocol";
import { ensureLegacyReportVersion } from "@/features/report-export/lib/versioning";

describe("committed desktop journal reduction", () => {
  it.each(["expired", "completed"])("preserves stored legacy history with omitted review fields when a run is %s", async (outcome) => {
    const h = header(), prior = ensureLegacyReportVersion({ ...task(), status: "completed", reportSections: { market_report: "Original historical report" } });
    Reflect.deleteProperty(prior.reportVersions[0], "evaluationReviews");
    Reflect.deleteProperty(prior.reportVersions[0], "numericReviews");
    const retained = JSON.parse(JSON.stringify(prior.reportVersions));
    const terminal = outcome === "expired"
      ? envelope(h, 2, "worker_outcome", { outcome: "not_started", code: "analysis_reservation_expired" })
      : envelope(h, 2, "analysis", { event: { type: "completed", reportSections: { market_report: "New report" } } });
    const result = await reduceJournalPage(prior, h, [envelope(h, 1, "accepted", { resetVersion: 1 }), terminal]);
    expect(result.task.reportVersions.slice(0, retained.length)).toEqual(retained);
    expect(result.task.status).toBe(outcome === "expired" ? "error" : "completed");
    expect(result.task.reportVersions).toHaveLength(outcome === "expired" ? 1 : 2);
    if (outcome === "completed") expect(result.task.reportVersions[1].versionNumber).toBe(2);
  });
  it("uses committed IDs and literal time without replay-time Date/UUID", async () => {
    const h = header(), t = task(), rows = [envelope(h, 1, "accepted", { resetVersion: 1 }), envelope(h, 2, "analysis", { event: { type: "completed", timestamp: "", message: "done", reportSections: { market_report: "  Fictional\r\n报告  " } } })];
    const first = await reduceJournalPage(t, h, rows);
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("No replay identity creation"); });
    const second = await reduceJournalPage(t, h, rows); uuid.mockRestore();
    expect(second).toEqual(first); expect(first.task.logs[0].timestamp).toBe(""); expect(first.task.reportVersions[0].id).toBe(rows[1].seed.completionVersionId); expect(first.task.reportVersions[0].reportSections.market_report).toBe("  Fictional\r\n报告  ");
  });
  it.each<Record<string, string | null>>([{}, { market_report: null }, { market_report: "" }, { market_report: " \t\n\ufeff " }])("safe empty full snapshot becomes error and remains terminal: %j", async (sections) => {
    const h = header(), t = { ...task(), reportSections: { market_report: "prior partial" } };
    const row = envelope(h, 2, "analysis", { event: { type: "completed", reportSections: sections, message: "done" } });
    const result = await reduceJournalPage(t, h, [row, envelope(h, 3, "worker_outcome", { outcome: "succeeded", code: null })]);
    expect(result.task.status).toBe("error"); expect(result.task.error).toBe(recoveryMessages.analysis_empty_result); expect(result.task.reportVersions).toHaveLength(0); expect(result.progress.terminalObserved).toBe(true); expect(result.task.logs.filter((l) => l.id === row.seed.logId)).toHaveLength(1);
  });
  it.each(["\u0085", "\u180e"])("preserves content outside ECMAScript trim: %j", async (content) => {
    const h = header(); const result = await reduceJournalPage(task(), h, [envelope(h, 2, "analysis", { event: { type: "completed", reportSections: { market_report: content } } })]); expect(result.task.status).toBe("completed"); expect(result.task.reportVersions[0].reportSections.market_report).toBe(content);
  });
  it("missing sections may qualify prior safe partial while header input is separate", async () => {
    const h = header(), t = { ...task(), ticker: "OTHER", reportSections: { market_report: "prior partial" } };
    const result = await reduceJournalPage(t, h, [envelope(h, 2, "analysis", { event: { type: "completed" } })]);
    expect(result.task.reportVersions[0].task.ticker).toBe("OTHER"); expect(h.context.originalTaskSnapshot.ticker).toBe("FICT"); expect(result.task.reportVersions[0].runId).toBe(h.context.originalRunContext.runId);
  });
  it("retains earlier legal version and sticky critical truth across pages", async () => {
    const h = header(); const first = await reduceJournalPage(task(), h, [envelope(h, 2, "analysis", { event: { type: "completed", reportSections: { market_report: "legal before failure" } } })]);
    const core = structuredClone(first.task.reportVersions);
    const failed = await reduceJournalPage(first.task, h, [envelope(h, 3, "publication_unavailable", { sourceType: "completed", channels: [{ channel: "reportSections", reason: "unsafe_content" }], outcome: "analysis_failed", code: "analysis_publication_unavailable", safeAnalysis: { type: "completed" } })], first.progress);
    const later = await reduceJournalPage(failed.task, h, [envelope(h, 4, "analysis", { event: { type: "completed", reportSections: { market_report: "later safe data" } } })], failed.progress);
    expect(later.task.reportVersions).toEqual(core); expect(later.task.status).toBe("error"); expect(later.task.error).toBe(recoveryMessages.analysis_publication_unavailable); expect(later.task.reportSections.market_report).toBe("later safe data");
  });
  it("critical safe completed siblings do not establish a safe terminal", async () => {
    const h = header(); const result = await reduceJournalPage(task(), h, [envelope(h, 2, "publication_unavailable", { sourceType: "completed", channels: [{ channel: "decision", reason: "unsafe_content" }], outcome: "analysis_failed", code: "analysis_publication_unavailable", safeAnalysis: { type: "completed", reportSections: { market_report: "safe sibling" } } })]);
    expect(result.progress.terminalObserved).toBe(false); expect(result.task.reportSections.market_report).toBe("safe sibling"); expect(result.task.reportVersions).toHaveLength(0);
  });
  it("optional domain marker preserves report and prevents apparently verified fallback", async () => {
    const h = header(); const result = await reduceJournalPage(task(), h, [envelope(h, 2, "publication_unavailable", { sourceType: "completed", channels: [{ channel: "evidenceBundle", reason: "unsafe_content" }], outcome: "optional_unavailable", code: "analysis_publication_unavailable", safeAnalysis: { type: "completed", reportSections: { market_report: "safe report" } } })]);
    expect(result.task.reportVersions).toHaveLength(1); expect(result.task.reportVersions[0].evidenceValidation).toEqual({ status: "invalid", reason: "unsafe_content" }); expect(result.task.evidenceBundle).toBeUndefined();
  });
  it("error without original error text and worker without terminal have fixed truth", async () => {
    const h = header(); const error = await reduceJournalPage(task(), h, [envelope(h, 2, "analysis", { event: { type: "error" } })]); expect(error.task.error).toBe(recoveryMessages.analysis_worker_failed); expect(error.progress.terminalObserved).toBe(true);
    const missing = await reduceJournalPage(task(), h, [envelope(h, 2, "worker_outcome", { outcome: "succeeded", code: "analysis_missing_terminal" })]); expect(missing.task.error).toBe(recoveryMessages.analysis_missing_terminal); expect(missing.task.reportVersions).toHaveLength(0);
  });
  it("reader failure after legal completion preserves version", async () => {
    const h = header(); const completed = await reduceJournalPage(task(), h, [envelope(h, 2, "analysis", { event: { type: "completed", reportSections: { market_report: "safe original" } } })]); const failed = await reduceJournalPage(completed.task, h, [envelope(h, 3, "reader_outcome", { stream: "stdout", outcome: "read_failed", code: "analysis_reader_failed" })], completed.progress); expect(failed.task.reportVersions).toEqual(completed.task.reportVersions); expect(failed.task.error).toBe(recoveryMessages.analysis_reader_failed);
  });
  it.each(["empty", "reader", "error"])("a later safe nonempty completion clears an ordinary %s failure", async (failure) => {
    const h = header(), row = failure === "reader" ? envelope(h, 2, "reader_outcome", { stream: "stdout", outcome: "read_failed", code: "analysis_reader_failed" }) : envelope(h, 2, "analysis", { event: { type: failure === "empty" ? "completed" : "error", reportSections: {} } });
    const first = await reduceJournalPage(task(), h, [row]);
    const next = await reduceJournalPage(first.task, h, [envelope(h, 3, "analysis", { event: { type: "completed", reportSections: { market_report: "later safe report" } } })], first.progress);
    expect(next.task.status).toBe("completed"); expect(next.task.error).toBe(""); expect(next.task.reportVersions).toHaveLength(1);
  });
});
