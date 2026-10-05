import { webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCenterProvider, useTaskCenter } from "@/components/task-center/context";
import { saveVerifiedTasks, loadTasks } from "@/features/persistence/local-storage";
import { numericFixture } from "../fixtures/fictional-numeric";
import { NumericReviewPanel } from "./NumericReviewPanel";
import { verifyNumericTasks } from "../lib/tasks";
import { NumericResultView } from "./NumericResultView";
vi.mock("@/lib/runtime", () => ({
    isTauriRuntime: () => false, defaultRuntimeInfo: () => ({}), getRuntimeAdapter: () => ({ getRuntimeInfo: async () => ({}), resolveInstrument: () => { throw new Error("No source calls allowed"); } }),
}));
describe("actual raw selection to retained task save and reload", () => {
    let container: HTMLDivElement, root: Root;
    let center: ReturnType<typeof useTaskCenter>;
    function Consumer() {
        const context = useTaskCenter(), task = context.tasks.find((item) => item.id === "task-fictional");
        center = context;
        return context.hydrated && task ? createElement(NumericReviewPanel, { taskId: task.id, version: task.reportVersions[0], language: "zh", onSave: context.saveNumericReviews }) : createElement("p", null, "hydrating");
    }
    async function mount() { await act(async () => root.render(createElement(TaskCenterProvider, null, createElement(Consumer)))); }
    const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
    beforeEach(() => { vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); window.localStorage.clear(); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
    afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    it("labels requested identifier literals precisely and retains saved field traceability in both languages", () => {
        const review = numericFixture().reportVersions[0].numericReviews![0];
        for (const zh of [true, false]) {
            const markup = renderToStaticMarkup(createElement(NumericResultView, { review, zh }));
            const view = document.createElement("div"); view.innerHTML = markup;
            expect(view.textContent).toContain(zh ? "本次请求代码字面量: 未审阅" : "Requested run identifier literal: unreviewed");
            expect(view.textContent).toContain(zh ? "不验证工具参数或数据提供方解析的实体" : "do not verify tool parameters or the provider-resolved entity");
            expect(view.textContent).toContain(review.operand.evidence_id);
            expect(view.textContent).toContain(zh ? "保存表位置: root" : "Saved table path: root");
            expect(view.textContent).toContain(zh ? "所选保存日期标记: 2026-01-08" : "Selected saved date label: 2026-01-08");
            expect(view.textContent).toContain(zh ? "保存字段: Close" : "Saved field: Close");
            expect(view.querySelector("details")?.textContent).toContain(review.operand.data_sha256);
            expect(view.textContent).not.toContain("证券相符");
        }
    });
    it("does not publish or export an appended receipt after actual localStorage persistence failure", async () => {
        const task = numericFixture(false); await saveVerifiedTasks([task]); const before = window.localStorage.getItem("evidenceloom.analysisTasks.v1");
        await mount(); await vi.waitFor(async () => { await act(async () => {}); expect(center.hydrated).toBe(true); });
        const review = structuredClone(numericFixture().reportVersions[0].numericReviews![0]);
        const originalWrite = Storage.prototype.setItem;
        vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key, value) {
            if (key === "evidenceloom.analysisTasks.v1" && JSON.parse(value)[0]?.reportVersions[0]?.numericReviews?.length) throw new DOMException("quota", "QuotaExceededError");
            return originalWrite.call(this, key, value);
        });
        await act(async () => { await expect(center.saveNumericReviews(task.id, task.reportVersions[0].id, [review])).rejects.toThrow(); });
        expect(center.tasks[0].reportVersions[0].numericReviews).toEqual([]);
        expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).toBe(before);
        expect(container.textContent).not.toContain(review.review_id);
    });
    it("binds displayed CRLF-normalized selection to exact original UTF8 bytes, appends through the provider and survives reload", async () => {
        const task = numericFixture(false), original = structuredClone(task.reportTextSnapshot), artifacts = structuredClone(task.evidenceBundle!.artifacts);
        await saveVerifiedTasks([task]);
        await mount();
        await vi.waitFor(async () => { await act(async () => { }); expect(container.textContent).toContain("原文捕获时间"); });
        const details = container.querySelector("details")!;
        await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
        const area = container.querySelector("textarea")!;
        expect(area.readOnly).toBe(true);
        expect(area.value).not.toContain("\r");
        const start = area.value.indexOf("125.02");
        await act(async () => { area.focus(); area.setSelectionRange(start, start + 6); document.dispatchEvent(new Event("selectionchange")); area.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); });
        await vi.waitFor(() => expect(button("设为所选数值").disabled).toBe(false));
        await act(async () => button("设为所选数值").click());
        await act(async () => button("对照所选字段").click());
        await vi.waitFor(async () => { await act(async () => { }); expect(container.textContent).toContain("所选数值相符"); });
        expect(container.textContent).toContain("本次请求代码字面量: 未审阅");
        expect(container.textContent).toContain("日期字面量: 未审阅");
        expect(container.textContent).toContain("单位字面量: 未审阅");
        await act(async () => button("追加并保存审阅").click());
        await vi.waitFor(async () => { await act(async () => { }); expect(loadTasks()[0].reportVersions[0].numericReviews).toHaveLength(1); });
        const saved = (await verifyNumericTasks(loadTasks()))[0], receipt = saved.reportVersions[0].numericReviews![0];
        expect(receipt.numeric_span).toEqual({ start_byte: 34, end_byte: 40, text: "125.02" });
        expect(receipt.result.status).toBe("match");
        expect(saved.reportTextSnapshot).toEqual(original);
        expect(saved.evidenceBundle!.artifacts).toEqual(artifacts);
        expect(saved.reportVersions[1].numericReviews).toEqual([]);
        await act(async () => root.unmount());
        root = createRoot(container);
        await mount();
        await vi.waitFor(async () => { await act(async () => { }); expect(container.textContent).toContain(receipt.review_id); });
        expect(container.querySelector("textarea")).toBeNull();
        const storedBeforeDisclosure = window.localStorage.getItem("evidenceloom.analysisTasks.v1");
        const disclosure = [...container.querySelectorAll("details")].find((element) => element.querySelector("summary")?.textContent === "定位保存原文与数据行")!;
        await act(async () => { disclosure.open = true; disclosure.dispatchEvent(new Event("toggle")); });
        expect(disclosure.querySelector("pre")?.textContent).toBe(original!.report_sections.market_report);
        expect(disclosure.querySelector("td[data-selected-cell] code")?.textContent).toBe(receipt.operand.raw_number_lexeme);
        expect(window.localStorage.getItem("evidenceloom.analysisTasks.v1")).toBe(storedBeforeDisclosure);
        expect(center.tasks[0].reportTextSnapshot).toEqual(original);
        expect(center.tasks[0].evidenceBundle!.artifacts).toEqual(artifacts);
    });
});
