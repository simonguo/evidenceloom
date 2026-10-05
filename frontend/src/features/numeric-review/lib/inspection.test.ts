import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { numericFixture } from "../fixtures/fictional-numeric";
import { verifiedNumericExport } from "./export";
import { inspectSavedNumeric, matchesNumericParent, partitionOriginal, rawCellPresentation } from "./inspection";
import { NumberLexeme } from "./raw-json";
import type { ContextBindings } from "../types";
const unbound: ContextBindings = { instrument: null, row_date: null, units: null };
function span(text: string, start: number, end: number) { return { start_byte: new TextEncoder().encode(text.slice(0, start)).length, end_byte: new TextEncoder().encode(text.slice(0, end)).length, text: text.slice(start, end) }; }
describe("exact saved original and owner-bound inspection", () => {
    beforeEach(() => vi.stubGlobal("crypto", webcrypto));
    afterEach(() => vi.unstubAllGlobals());
    it("partitions repeated CJK/emoji/combining/CRLF text, including BOM at every partition start, without normalization", () => {
        const text = "\uFEFF中🙂e\u0301\r\n125.02\r125.02\n\uFEFF125.02\uFEFF尾";
        const start = text.lastIndexOf("125.02"), numeric = span(text, start, start + 6);
        const segments = partitionOriginal(text, numeric, { ...unbound, units: span(text, start - 1, start + 7), instrument: span(text, 0, text.length) });
        expect(segments.map((part) => part.text).join("")).toBe(text);
        expect(segments.filter((part) => part.numeric).map((part) => part.text).join("")).toBe("125.02");
        expect(segments.find((part) => part.startByte === numeric.end_byte)?.text).toBe("\uFEFF");
        expect(segments.filter((part) => part.numeric).every((part) => part.contexts.includes("units"))).toBe(true);
    });
    it("rejects mid-codepoint boundaries, false literals and invalid ranges rather than searching a repeated literal", () => {
        expect(() => partitionOriginal("中125.02", { start_byte: 1, end_byte: 3, text: "中" }, unbound)).toThrow();
        expect(() => partitionOriginal("125.02 125.02", { start_byte: 0, end_byte: 6, text: "999.99" }, unbound)).toThrow();
        expect(() => partitionOriginal("125.02", { start_byte: 0, end_byte: 7, text: "125.02" }, unbound)).toThrow();
    });
    it("uses the verified parent and exact selected reference; copied IDs or target/envelope mutations do not authorize display", async () => {
        const raw = numericFixture().reportVersions[0], current = { taskId: "task-fictional", versionOwner: raw };
        const parent = { owner: current, version: await verifiedNumericExport(current.taskId, raw) }, reviewId = raw.numericReviews![0].review_id;
        const actual = inspectSavedNumeric(current, parent, reviewId)!;
        expect(actual.segments.map((part) => part.text).join("")).toBe(raw.reportTextSnapshot!.report_sections.market_report);
        expect(actual.source.lexeme).toBe(raw.numericReviews![0].operand.raw_number_lexeme);
        expect(inspectSavedNumeric({ ...current, taskId: "task-other" }, parent, reviewId)).toBeNull();
        expect(inspectSavedNumeric({ ...current, versionOwner: structuredClone(raw) }, parent, reviewId)).toBeNull();
        expect(inspectSavedNumeric(current, parent, "missing-review")).toBeNull();
        raw.numericReviews![0].target.section_key = "news_report";
        expect(matchesNumericParent(current, parent)).toBe(false);
        expect(inspectSavedNumeric(current, parent, reviewId)).toBeNull();
    });
    it("does not relabel string, boolean, null, negative zero or scientific tokens as a decimal result", () => {
        expect([new NumberLexeme("-0"), new NumberLexeme("1e127"), "1e2", false, null, [], {}].map(rawCellPresentation)).toEqual([
            { type: "number", literal: "-0" }, { type: "number", literal: "1e127" }, { type: "string", literal: '"1e2"' }, { type: "boolean", literal: "false" }, { type: "null", literal: "null" }, { type: "array", literal: "[…]" }, { type: "object", literal: "{…}" },
        ]);
    });
});
