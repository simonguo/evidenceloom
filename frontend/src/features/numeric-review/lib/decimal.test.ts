import { describe, expect, it } from "vitest";
import { numericSharedFixture as fixture } from "../fixtures/fictional-numeric";
import { decimalEqual, parseDecimal, roundedDecimal } from "./decimal";
import { fullLiteral, fullNumber, selectionSpan, spanText, textareaSelectionSpan } from "./spans";
import { NumberLexeme, parseRawJson, rawObject } from "./raw-json";
describe("bounded exact saved decimal arithmetic", () => {
    it.each(fixture.decimal_vectors)("matches the independent Python vector $source", (vector) => {
        expect(roundedDecimal(vector.source, vector.places)).toBe(vector.expected);
    });
    it("handles expanded exponent output without reapplying external coefficient limits", () => {
        for (const [literal, places] of [["1e127", 18], ["1e128", 0], ["1e1024", 18]] as const) {
            const rounded = roundedDecimal(literal, places)!;
            expect(rounded.length).toBeGreaterThan(128);
            expect(decimalEqual(literal, rounded)).toBe(true);
            expect(decimalEqual("-" + literal, rounded)).toBe(false);
        }
        expect(roundedDecimal("-0.004", 2)).toBe("0.00");
        expect(parseDecimal("1e1025")).toBeNull();
        expect(parseDecimal("9".repeat(129))).toBeNull();
        expect(parseDecimal("01.2")).toBeNull();
        expect(parseDecimal("1,005")).toBeNull();
    });
    it("retains original source number tokens and rejects escaped duplicate keys", () => {
        const parsed = parseRawJson('{"v":125.02345678901236,"n":-0,"s":"1.005","b":true}');
        expect(rawObject(parsed) && parsed.v instanceof NumberLexeme && parsed.v.raw).toBe("125.02345678901236");
        expect(rawObject(parsed) && parsed.n instanceof NumberLexeme && parsed.n.raw).toBe("-0");
        expect(() => parseRawJson('{"Date":1,"\\u0044ate":2}')).toThrow();
        expect(() => parseRawJson('{"x":NaN}')).toThrow();
    });
});
describe("raw UTF-8 span boundaries", () => {
    it.each(fixture.span_vectors)("matches the shared span vector $text", (vector) => {
        expect(fullNumber(vector.section, vector.span)).toBe(vector.supported);
    });
    it("rejects a leading decimal fragment", () => { for (const section of [".5", "٫5", "．5"])
        expect(fullNumber(section, selectionSpan(section, section.length - 1, section.length))).toBe(false); });
    it("retains emoji, combining marks and CRLF and rejects split UTF-8 bytes", () => {
        const section = "研究📈\r\ne\u0301 close125.02元";
        const start = section.indexOf("125.02"), span = selectionSpan(section, start, start + 6);
        expect(spanText(section, span)).toBe("125.02");
        expect(fullNumber(section, span)).toBe(true);
        expect(() => spanText(section, { start_byte: 1, end_byte: 3, text: "研" })).toThrow();
        expect(fullLiteral("FICTOTHER", selectionSpan("FICTOTHER", 0, 4))).toBe(false);
        expect(fullLiteral("证券FICT日期", selectionSpan("证券FICT日期", 2, 6))).toBe(true);
    });
    it("maps actual textarea LF-normalized selection back to original CRLF/lone-CR bytes", () => {
        const section = "研究📈\r\nline\r收盘125.02元", area = document.createElement("textarea");
        area.value = section;
        expect(area.value).not.toContain("\r");
        const start = area.value.indexOf("125.02");
        area.setSelectionRange(start, start + 6);
        const span = textareaSelectionSpan(section, area.selectionStart, area.selectionEnd);
        expect(span.text).toBe("125.02");
        expect(spanText(section, span)).toBe("125.02");
        const newline = area.value.indexOf("\n");
        expect(textareaSelectionSpan(section, newline, newline + 1).text).toBe("\r\n");
    });
    it.each(["125.02%", "125.02‰", "125.02‱", "125.02％", "125.02٪", "125.02M", "125.02万", "125.02萬", "125.02億", "1,125.02", "1，125.02", "﹢125.02", "±125.02", "−125.02", "125.02e2", "1125.02"])("does not compare partial or scaled %s", (section) => {
        const start = section.indexOf("125.02");
        expect(fullNumber(section, selectionSpan(section, start, start + 6))).toBe(false);
    });
    it("keeps ordinary Chinese punctuation and unbound unit text numeric-only", () => {
        for (const section of ["收盘价，125.02元", "125.02USD"]) {
            const start = section.indexOf("125.02");
            expect(fullNumber(section, selectionSpan(section, start, start + 6))).toBe(true);
        }
    });
});
