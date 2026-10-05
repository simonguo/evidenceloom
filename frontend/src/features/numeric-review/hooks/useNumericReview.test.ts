import { webcrypto } from "node:crypto";
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportVersion } from "@/lib/types";
import { numericFixture } from "../fixtures/fictional-numeric";
import { useNumericReview } from "./useNumericReview";
import * as guards from "../lib/guards";
import * as numericExport from "../lib/export";
import { selectionSpan } from "../lib/spans";
describe("selected-version numeric request generation", () => {
    let container: HTMLDivElement, root: Root, session: ReturnType<typeof useNumericReview>;
    const save = vi.fn();
    const verifications: Promise<ReportVersion>[] = [];
    let begin: (() => unknown) | undefined;
    const frames: { taskId: string; text: string; verified: boolean; pending: boolean; preview: boolean }[] = [];
    function Session({ version, taskId = "task-fictional" }: {
        version: ReportVersion;
        taskId?: string;
    }) {
        session = useNumericReview(taskId, version, "en", save, begin);
        useLayoutEffect(() => { frames.push({ taskId, text: container.textContent ?? "", verified: Boolean(session.verified), pending: session.pending, preview: Boolean(session.preview) }); });
        return createElement("div", null,
            createElement("p", { "data-pending": session.pending }, session.message),
            session.verified && createElement("span", null, session.verified.id),
            session.preview && createElement("span", null, session.preview.numeric_span.text));
    }
    async function ready(version: ReportVersion) {
        await act(async () => root.render(createElement(Session, { version })));
        await act(async () => { await Promise.allSettled(verifications); });
        await vi.waitFor(async () => { await act(async () => { }); expect(session.verified).toBeDefined(); });
    }
    function draft(version: ReportVersion) {
        const section = version.reportSections.market_report!, start = section.indexOf("125.02");
        return { sectionKey: "market_report", numericSpan: selectionSpan(section, start, start + 6), operand: { evidenceId: version.evidenceBundle!.records[0].id, sourceIndex: 0, selector: { kind: "table_cell" as const, table_path: [], row_date: "2026-01-08", field: "Close" } }, contexts: { instrument: null, row_date: null, units: null }, places: 2 };
    }
    beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); save.mockReset().mockResolvedValue(undefined); begin = undefined; frames.length = 0; verifications.length = 0;
        const verify = numericExport.verifiedNumericExport;
        vi.spyOn(numericExport, "verifiedNumericExport").mockImplementation((...args) => { const promise = verify(...args); verifications.push(promise); return promise; });
        container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
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
    it("hides the previous task verification and preview in the first committed DOM frame with the same version reference", async () => {
        const version = numericFixture(false).reportVersions[0];
        await ready(version);
        await act(async () => session.compare(draft(version)));
        expect(container.textContent).toContain("125.02");
        const cut = frames.length;
        await act(async () => root.render(createElement(Session, { version, taskId: "task-other" })));
        await act(async () => { await Promise.allSettled(verifications); });
        const first = frames.slice(cut).find((frame) => frame.taskId === "task-other")!;
        expect(first).toBeDefined();
        expect(first.verified).toBe(false);
        expect(first.preview).toBe(false);
        expect(first.pending).toBe(false);
        expect(first.text).not.toContain("125.02");
        expect(first.text).not.toContain(version.id);
        expect(save).not.toHaveBeenCalled();
    });
    it("withholds a late old-task comparison and save message after switching owner with the same version reference", async () => {
        const version = numericFixture(false).reportVersions[0];
        await ready(version);
        const realHash = guards.utf8Sha; let release!: () => void, entered!: () => void;
        const reached = new Promise<void>((done) => { entered = done; });
        vi.spyOn(guards, "utf8Sha").mockImplementationOnce(async (text) => { entered(); await new Promise<void>((done) => { release = done; }); return realHash(text); });
        let work!: Promise<void>;
        await act(async () => { work = session.compare(draft(version)); await reached; });
        const cut = frames.length;
        await act(async () => root.render(createElement(Session, { version, taskId: "task-other" })));
        await act(async () => { await Promise.allSettled(verifications); });
        expect(frames[cut].pending).toBe(false);
        await act(async () => { release(); await work; await session.save(); });
        expect(session.preview).toBeNull();
        expect(session.message).toBe("");
        expect(save).not.toHaveBeenCalled();
    });
    it("keeps a delayed save bound to its original task and capture while withholding its late failure message", async () => {
        const version = numericFixture(false).reportVersions[0], action = Object.freeze({ originalBinding: "task-fictional" });
        begin = vi.fn(() => action);
        await ready(version);
        await act(async () => session.compare(draft(version)));
        let reject!: (error: Error) => void, work!: Promise<void>;
        save.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
        await act(async () => { work = session.save(); });
        const cut = frames.length;
        await act(async () => root.render(createElement(Session, { version, taskId: "task-other" })));
        await act(async () => { await Promise.allSettled(verifications); });
        expect(frames[cut]).toMatchObject({ verified: false, preview: false, pending: false });
        await act(async () => { reject(new Error("fictional failed acknowledgement")); await work; });
        expect(save).toHaveBeenCalledOnce();
        expect(save.mock.calls[0].slice(0, 2)).toEqual(["task-fictional", version.id]);
        expect(save.mock.calls[0][3]).toBe(action);
        expect(session.message).toBe("");
        expect(container.textContent).not.toContain("could not be saved");
    });
});
