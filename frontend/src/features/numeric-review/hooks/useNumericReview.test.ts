import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportVersion } from "@/lib/types";
import { numericFixture } from "../fixtures/fictional-numeric";
import { useNumericReview } from "./useNumericReview";
import * as guards from "../lib/guards";
import { selectionSpan } from "../lib/spans";
describe("selected-version numeric request generation", () => {
    let container: HTMLDivElement, root: Root, session: ReturnType<typeof useNumericReview>;
    const save = vi.fn();
    let begin: (() => unknown) | undefined;
    function Session({ version }: {
        version: ReportVersion;
    }) { session = (useNumericReview as (...args: unknown[]) => ReturnType<typeof useNumericReview>)("task-fictional", version, "en", save, begin); return createElement("p", { "data-pending": session.pending }, session.message); }
    async function ready(version: ReportVersion) {
        await act(async () => root.render(createElement(Session, { version })));
        await vi.waitFor(async () => { await act(async () => { }); expect(session.verified).toBeDefined(); });
    }
    function draft(version: ReportVersion) {
        const section = version.reportSections.market_report!, start = section.indexOf("125.02");
        return { sectionKey: "market_report", numericSpan: selectionSpan(section, start, start + 6), operand: { evidenceId: version.evidenceBundle!.records[0].id, sourceIndex: 0, selector: { kind: "table_cell" as const, table_path: [], row_date: "2026-01-08", field: "Close" } }, contexts: { instrument: null, row_date: null, units: null }, places: 2 };
    }
    beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); save.mockReset().mockResolvedValue(undefined); begin = undefined; container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
    afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    it("ignores a delayed comparison after inputs invalidate its generation and permits a fresh request", async () => {
        const version = numericFixture(false).reportVersions[0];
        await ready(version);
        const realHash = guards.utf8Sha;
        let release!: () => void, started!: () => void;
        const startedPromise = new Promise<void>((resolve) => { started = resolve; });
        vi.spyOn(guards, "utf8Sha").mockImplementationOnce(async (text) => { started(); await new Promise<void>((resolve) => { release = resolve; }); return realHash(text); });
        let work!: Promise<void>;
        await act(async () => { work = session.compare(draft(version)); await startedPromise; });
        expect(session.pending).toBe(true);
        await act(async () => session.clearPreview());
        await act(async () => { release(); await work; });
        expect(session.preview).toBeNull();
        expect(session.pending).toBe(false);
        await act(async () => session.compare(draft(version)));
        expect(session.preview?.result.status).toBe("match");
    });
    it("resets pending after version selection and sends an in-flight save only to its original owner", async () => {
        const task = numericFixture(false), first = task.reportVersions[0], second = task.reportVersions[1];
        await ready(first);
        await act(async () => session.compare(draft(first)));
        expect(session.preview).toBeDefined();
        let release!: () => void;
        save.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
        let work!: Promise<void>;
        await act(async () => { work = session.save(); });
        await ready(second);
        expect(session.pending).toBe(false);
        expect(session.preview).toBeNull();
        await act(async () => { release(); await work; });
        expect(save).toHaveBeenCalledOnce();
        expect(save.mock.calls[0].slice(0, 2)).toEqual([task.id, first.id]);
        expect(container.textContent).not.toContain("Saved numeric");
        expect(session.pending).toBe(false);
    });
    it("captures before receipt construction and saves the same original binding after a later change", async () => {
        const version = numericFixture(false).reportVersions[0]; await ready(version);
        const binding = Object.freeze({ ownedCapture: "original-generation" as string, originalVersion: version.id });
        const capture = vi.fn(() => binding); begin = capture;
        await ready(version);
        const realHash = guards.utf8Sha; let release!: () => void, entered!: () => void;
        const reached = new Promise<void>((done) => { entered = done; });
        vi.spyOn(guards, "utf8Sha").mockImplementationOnce(async (text) => { entered(); await new Promise<void>((done) => { release = done; }); return realHash(text); });
        let work!: Promise<void>;
        await act(async () => { work = session.compare(draft(version)); await reached; });
        expect.soft(capture).toHaveBeenCalledTimes(1);
        capture.mockImplementation(() => Object.freeze({ ownedCapture: "new-generation", originalVersion: version.id }));
        await act(async () => { release(); await work; });
        await act(async () => session.save());
        expect(capture).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0]?.[3]).toBe(binding);
    });
});
