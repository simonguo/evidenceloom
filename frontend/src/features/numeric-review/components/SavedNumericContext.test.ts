import { webcrypto } from "node:crypto";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { numericFixture, numericSharedFixture } from "../fixtures/fictional-numeric";
import { verifiedNumericExport, copyNumericExport } from "../lib/export";
import { createNumericReview } from "../lib/validation";
import { requestFromReview } from "../lib/derive";
import { copyEvidenceBundle, sha256 } from "@/features/evidence/lib/validation";
import { copyReportTextSnapshot } from "../lib/snapshot";
import type { NumericDisplayOwner, VerifiedNumericParent } from "../lib/inspection";
import type { NumericReview } from "../types";
import { SavedNumericContext } from "./SavedNumericContext";

describe("read-only saved numeric context in the actual DOM", () => {
    let root: Root, container: HTMLDivElement;
    const frames: string[] = [];
    beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); frames.length = 0; container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
    afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
    async function verified(raw = numericFixture().reportVersions[0]) {
        const current = { taskId: "task-fictional", versionOwner: raw }, parent = { owner: current, version: await verifiedNumericExport(current.taskId, raw) };
        return { current, parent, reviewId: parent.version.numericReviews![0].review_id };
    }
    function View(props: { current: NumericDisplayOwner; parent: VerifiedNumericParent; reviewId: string; zh: boolean }) {
        useLayoutEffect(() => { frames.push(container.textContent ?? ""); });
        return createElement(SavedNumericContext, props);
    }
    async function open() { const details = container.querySelector("details")!; await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); }); }
    it.each([false, true])("shows the exact selected occurrence and saved typed row in language zh=%s without changing export bytes", async (zh) => {
        const props = await verified(), before = JSON.stringify(props.current.versionOwner), exported = JSON.stringify(copyNumericExport(props.current.taskId, props.current.versionOwner));
        await act(async () => root.render(createElement(View, { ...props, zh })));
        expect(container.querySelector("pre")).toBeNull();
        expect(container.querySelector("summary")?.textContent).toBe(zh ? "定位保存原文与数据行" : "Locate saved original text and data row");
        await open();
        const original = props.parent.version.reportTextSnapshot!.report_sections.market_report!;
        expect(container.querySelector("pre")!.textContent).toBe(original);
        expect(container.querySelector("pre")!.textContent).toContain("\r\n");
        expect([...container.querySelectorAll("mark[data-numeric]")].map((mark) => mark.textContent).join("")).toBe("125.02");
        expect(container.querySelector("pre")!.firstChild?.textContent?.startsWith("研究📈\r\nFICT")).toBe(true);
        const row = container.querySelector("table")!;
        expect(row.getAttribute("aria-label")).toBe(zh ? "保存数据行与原始单元格类型" : "Saved data row and original cell types");
        expect(row.querySelector("td[data-selected-cell] code")!.textContent).toBe("125.02345678901236");
        expect(row.textContent).toContain("1e127");
        expect(row.textContent).toContain('"1.005"');
        expect(row.textContent).toContain("false");
        expect(container.textContent).toContain(zh ? "未绑定，仍未审阅" : "Not bound; remains unreviewed");
        expect(container.querySelectorAll("button, input, textarea")).toHaveLength(0);
        const details = container.querySelector("details")!;
        await act(async () => { details.open = false; details.dispatchEvent(new Event("toggle")); });
        await open();
        expect(JSON.stringify(props.current.versionOwner)).toBe(before);
        expect(JSON.stringify(copyNumericExport(props.current.taskId, props.current.versionOwner))).toBe(exported);
    });
    it.each(["withheld", "duplicate_rows", "duplicate_columns"])("preserves saved %s reasons and displays no guessed row", async (name) => {
        const fixture = numericSharedFixture.cases.find((item) => item.name === name)!, raw = numericFixture().reportVersions[0];
        raw.evidenceBundle = copyEvidenceBundle(fixture.evidence);
        raw.reportTextSnapshot = copyReportTextSnapshot(fixture.snapshot, raw.evidenceBundle);
        raw.reportSections = structuredClone(fixture.snapshot.report_sections);
        raw.numericReviews = [structuredClone(fixture.review) as NumericReview];
        const props = await verified(raw);
        await act(async () => root.render(createElement(View, { ...props, zh: false })));
        await open();
        expect(container.textContent).toContain(fixture.review.result.reason);
        expect(container.querySelector("table")).toBeNull();
        expect(container.textContent).toContain("No unambiguously validated saved row");
        expect(container.querySelector("pre")).not.toBeNull();
    });
    it("labels an unsupported scientific token without upgrading its recorded unknown comparison", async () => {
        const raw = numericFixture().reportVersions[0], request = requestFromReview(raw.numericReviews![0]);
        const evidence = raw.evidenceBundle!, oldHash = evidence.records[0].sources[0].data_sha256!;
        const artifact = { ...evidence.artifacts[oldHash], payload: evidence.artifacts[oldHash].payload.replace("1e127", "1e-1025") };
        const newHash = await sha256(artifact);
        delete evidence.artifacts[oldHash]; evidence.artifacts[newHash] = artifact; evidence.records[0].sources[0].data_sha256 = newHash;
        const { bundle_sha256: _bundleHash, ...evidenceBody } = evidence;
        void _bundleHash;
        evidence.bundle_sha256 = await sha256(evidenceBody);
        const snapshot = raw.reportTextSnapshot!;
        snapshot.evidence_bundle_sha256 = evidence.bundle_sha256;
        const { snapshot_sha256: _snapshotHash, ...snapshotBody } = snapshot;
        void _snapshotHash;
        snapshot.snapshot_sha256 = await sha256(snapshotBody);
        request.target.report_snapshot_sha256 = snapshot.snapshot_sha256;
        request.operand.selector.field = "Large";
        raw.numericReviews = [await createNumericReview(raw.reportTextSnapshot!, raw.evidenceBundle!, request)];
        expect(raw.numericReviews[0].operand.raw_number_lexeme).toBeNull();
        const props = await verified(raw);
        await act(async () => root.render(createElement(View, { ...props, zh: false })));
        await open();
        expect(container.querySelector("td[data-selected-cell] code")!.textContent).toBe("1e-1025");
        expect(container.textContent).toContain("no numeric match is inferred");
        expect(raw.numericReviews[0].result.reason).toBe("number_unsupported");
    });
    it("removes old original text and row in the first committed frame on task/reference changes", async () => {
        const props = await verified();
        await act(async () => root.render(createElement(View, { ...props, zh: false })));
        await open();
        const cut = frames.length;
        await act(async () => root.render(createElement(View, { ...props, current: { ...props.current, taskId: "other-task" }, zh: false })));
        expect(frames[cut]).toBe("");
        expect(container.querySelector("pre, table, details")).toBeNull();
        await act(async () => root.render(createElement(View, { ...props, current: { ...props.current, versionOwner: structuredClone(props.current.versionOwner) }, zh: false })));
        expect(container.querySelector("details")).toBeNull();
    });
    it("hides all derived content after in-place core or history changes, including a local disclosure toggle", async () => {
        const props = await verified(), raw = props.current.versionOwner;
        await act(async () => root.render(createElement(View, { ...props, zh: false })));
        await open();
        const original = raw.reportTextSnapshot!.report_sections.market_report;
        raw.reportTextSnapshot!.report_sections.market_report += "unverified replacement";
        await act(async () => root.render(createElement(View, { ...props, zh: false })));
        expect(container.querySelector("pre, table")).toBeNull();
        expect(container.textContent).toContain("is not confirmed");
        raw.reportTextSnapshot!.report_sections.market_report = original;
        await act(async () => root.render(createElement(View, { ...props, zh: false })));
        expect(container.querySelector("table")).not.toBeNull();
        const details = container.querySelector("details")!;
        await act(async () => { details.open = false; details.dispatchEvent(new Event("toggle")); });
        raw.numericReviews![0].target.task_id = "different-owner";
        await open();
        expect(container.querySelector("pre, table")).toBeNull();
        expect(container.textContent).not.toContain("125.02345678901236");
    });
    it("renders one thousand legal closed saved receipts without exposing original text or rows", async () => {
        const raw = numericFixture(false).reportVersions[0], base = numericFixture().reportVersions[0].numericReviews![0];
        raw.numericReviews = [];
        let previous: string | null = null;
        for (let index = 0; index < 1000; index++) {
            const { review_sha256: _hash, ...body } = structuredClone(base);
            void _hash;
            body.review_id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
            body.previous_review_sha256 = previous;
            const review = { ...body, review_sha256: await sha256(body) };
            raw.numericReviews.push(review); previous = review.review_sha256;
        }
        const props = await verified(raw), before = JSON.stringify(raw);
        await act(async () => root.render(createElement("div", null, raw.numericReviews!.map((review) => createElement(SavedNumericContext, { key: review.review_id, ...props, reviewId: review.review_id, zh: false })))));
        expect(container.querySelectorAll("details")).toHaveLength(1000);
        expect(container.querySelectorAll("summary")).toHaveLength(1000);
        expect(container.querySelector("pre, table")).toBeNull();
        expect(container.textContent).not.toContain("125.02");
        expect(JSON.stringify(raw)).toBe(before);
    });
});
