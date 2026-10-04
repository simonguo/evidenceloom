import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256 } from "@/features/evidence/lib/validation";
import { numericFixture, numericSharedFixture as fixture } from "../fixtures/fictional-numeric";
import type { NumericReview } from "../types";
import { createNumericReview, verifyNumericReview } from "./validation";
import { bindReportSnapshot, verifyReportTextSnapshot, reportSnapshotFromEvent } from "./snapshot";
import { requestFromReview } from "./derive";
import { verifyNumericHistory } from "./history";
import { selectionSpan } from "./spans";
import { memoryTask, component } from "@/features/memory/fixtures/test-data";
import { sectionKeys } from "./policy";
beforeAll(() => Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }));
describe("saved numeric receipt verification", () => {
    it("requires original report capture at or after frozen Memory completion when present", async () => {
        const version = memoryTask().reportVersions[0], evidence = version.evidenceBundle!;
        const snapshot = await component({ schema_version: 1 as const, run_id: evidence.run_id, instrument: evidence.instrument, analysis_date: evidence.analysis_date, captured_at: evidence.created_at.replace(/Z$/, ".000000Z"), evidence_bundle_sha256: evidence.bundle_sha256, report_sections: Object.fromEntries(sectionKeys.map((key) => [key, version.reportSections[key] ?? null])) }, "snapshot_sha256");
        snapshot.captured_at = version.memoryBundle!.decision_snapshot.decision.research_started_at;
        expect(() => bindReportSnapshot(version, snapshot)).toThrow("reference_mismatch");
        snapshot.captured_at = version.memoryBundle!.decision_snapshot.decision.recorded_at;
        expect(() => bindReportSnapshot(version, snapshot)).not.toThrow();
    });
    it.each(fixture.cases)("rederives the full independent $name receipt", async (testCase) => {
        expect(await verifyNumericReview(testCase.review, testCase.snapshot, testCase.evidence)).toEqual(testCase.review);
    });
    it("validates the full shared evidence/snapshot/chained receipts without changing raw payloads", async () => {
        const task = numericFixture(), version = task.reportVersions[0], original = JSON.stringify(task);
        await verifyReportTextSnapshot(task.reportTextSnapshot, task.evidenceBundle);
        expect(await verifyNumericHistory(version.numericReviews, task.reportTextSnapshot!, task.evidenceBundle!, { taskId: task.id, versionId: version.id })).toEqual(version.numericReviews);
        expect(JSON.stringify(task)).toBe(original);
    });
    it("rejects a coherently rehashed false match", async () => {
        const task = numericFixture(), review = structuredClone(fixture.reviews[1]) as NumericReview;
        expect(review.result.status).toBe("mismatch");
        review.result.status = "match";
        review.result.reason = "value_match";
        const { review_sha256: _hash, ...body } = review;
        void _hash;
        review.review_sha256 = await sha256(body);
        await expect(verifyNumericReview(review, task.reportTextSnapshot, task.evidenceBundle)).rejects.toThrow("reference_mismatch");
    });
    it("compares only explicitly bound context and preserves unknown units", async () => {
        const task = numericFixture(false), base = structuredClone(fixture.reviews[0]) as NumericReview, request = requestFromReview(base), section = task.reportTextSnapshot!.report_sections.market_report!;
        request.context_bindings.instrument = selectionSpan(section, section.indexOf("OTHER"), section.indexOf("OTHER") + 5);
        expect((await createNumericReview(task.reportTextSnapshot!, task.evidenceBundle!, request)).result.reason).toBe("context_mismatch");
        request.context_bindings.instrument = null;
        request.context_bindings.units = selectionSpan(section, section.indexOf("USD"), section.indexOf("USD") + 3);
        const missing = await createNumericReview(task.reportTextSnapshot!, task.evidenceBundle!, request);
        expect(missing.result.reason).toBe("context_missing");
        expect(missing.result.unreviewed_dimensions).toContain("units");
    });
    it("rejects byte edits, owner rebinding, missing artifact references and stale hashes", async () => {
        const task = numericFixture(), review = task.reportVersions[0].numericReviews![0];
        await expect(verifyNumericReview(review, task.reportTextSnapshot, task.evidenceBundle, { taskId: "other", versionId: "version-fictional" })).rejects.toThrow("reference_mismatch");
        const changed = structuredClone(task.reportTextSnapshot!);
        changed.report_sections.market_report += " ";
        await expect(verifyReportTextSnapshot(changed, task.evidenceBundle)).rejects.toThrow("hash_mismatch");
        const bad = structuredClone(review);
        bad.numeric_span.start_byte++;
        await expect(verifyNumericReview(bad, task.reportTextSnapshot, task.evidenceBundle)).rejects.toThrow();
        const evidence = structuredClone(task.evidenceBundle!);
        evidence.records[0].sources[0].data_sha256 = "f".repeat(64);
        await expect(verifyNumericReview(review, task.reportTextSnapshot, evidence)).rejects.toThrow();
    });
    it("accepts exact top/nested completion snapshots, preserves empty/null and rejects disagreement", async () => {
        const task = numericFixture();
        expect(await reportSnapshotFromEvent({ type: "completed", reportTextSnapshot: task.reportTextSnapshot, finalState: { report_text_snapshot: task.reportTextSnapshot } }, task.evidenceBundle)).toMatchObject({ reportTextSnapshot: task.reportTextSnapshot });
        const other = structuredClone(task.reportTextSnapshot!);
        other.snapshot_sha256 = "a".repeat(64);
        expect((await reportSnapshotFromEvent({ type: "completed", reportTextSnapshot: task.reportTextSnapshot, finalState: { report_text_snapshot: other } }, task.evidenceBundle))?.numericValidation).toBeDefined();
        expect((await reportSnapshotFromEvent({ type: "completed", reportTextSnapshot: null as never, finalState: { report_text_snapshot: task.reportTextSnapshot } }, task.evidenceBundle))?.numericValidation?.reason).toBe("malformed");
        expect((await reportSnapshotFromEvent({ type: "completed", reportTextSnapshot: task.reportTextSnapshot, finalState: { report_text_snapshot: null } }, task.evidenceBundle))?.numericValidation?.reason).toBe("malformed");
        expect(await reportSnapshotFromEvent({ type: "completed" }, undefined)).toBeUndefined();
    });
});
