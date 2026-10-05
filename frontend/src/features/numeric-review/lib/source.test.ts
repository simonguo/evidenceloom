import { describe, expect, it } from "vitest";
import { numericFixture } from "../fixtures/fictional-numeric";
import { NumberLexeme } from "./raw-json";
import { prepareSourceInspection, selectedSource } from "./source";

function input(payload?: string) {
    const version = numericFixture().reportVersions[0], evidence = version.evidenceBundle!, review = version.numericReviews![0];
    if (payload) evidence.artifacts[review.operand.data_sha256!].payload = payload;
    return { evidence, review };
}
describe("saved row inspection uses comparison's whole-table authority", () => {
    it("preserves raw numeric tokens and cell types without coercion, and detaches returned cache cells", () => {
        const { evidence, review } = input('{"columns":["Date","Close","Zero","Scientific","Null","Boolean","String","Array","Object"],"rows":[["2026-01-08",125.02345678901236,-0,1e127,null,false,"125.02",[1],{"x":2}]]}');
        const read = prepareSourceInspection(evidence), inspected = read(review);
        expect(inspected.columns).toEqual(["Date", "Close", "Zero", "Scientific", "Null", "Boolean", "String", "Array", "Object"]);
        expect(inspected.fieldIndex).toBe(1);
        expect(inspected.row?.slice(0, 7)).toEqual(["2026-01-08", new NumberLexeme("125.02345678901236"), new NumberLexeme("-0"), new NumberLexeme("1e127"), null, false, "125.02"]);
        const { columns: _columns, row: _row, fieldIndex: _field, ...selection } = inspected;
        expect(selection).toEqual(selectedSource(review, evidence));
        inspected.columns![0] = "changed";
        (inspected.row![7] as unknown[]).push("changed");
        inspected.context.transformations.push("changed");
        expect(read(review).columns![0]).toBe("Date");
        expect(read(review).row![7]).toEqual([new NumberLexeme("1")]);
        expect(read(review).context.transformations).not.toContain("changed");
        expect(evidence.artifacts[review.operand.data_sha256!].payload).not.toContain("changed");
    });
    it.each([
        ['{"columns":["Date","Close","Close"],"rows":[["2026-01-08",1,2]]}', "table_ambiguous"],
        ['{"columns":["Date","Close"],"rows":[["2026-01-08",1],["2026-01-07",2],["2026-01-07",3]]}', "row_ambiguous"],
        ['{"columns":["Date","Close"],"rows":[["2026-01-08",1],[null,2]]}', "table_missing"],
        ['{"columns":["Date","Close"],"rows":[["2026-01-08",1],["2026-01-07"]]}', "table_missing"],
        ['{"columns":["Close"],"rows":[[1]]}', "table_missing"],
    ])("rejects defects outside the selected cell: %s", (payload, reason) => {
        const { evidence, review } = input(payload), actual = prepareSourceInspection(evidence)(review);
        expect(actual.reason).toBe(reason);
        expect(actual.row).toBeNull();
        expect(actual.columns).toBeNull();
        expect(selectedSource(review, evidence).reason).toBe(reason);
    });
    it("retains an exact valid row for missing/non-numeric fields without choosing a replacement field", () => {
        const { evidence, review } = input();
        review.operand.selector.field = "String";
        const nonNumeric = prepareSourceInspection(evidence)(review);
        expect(nonNumeric.reason).toBe("field_not_numeric");
        expect(nonNumeric.lexeme).toBeNull();
        expect(nonNumeric.row![nonNumeric.fieldIndex!]).toBe("1.005");
        review.operand.selector.field = "absent";
        const absent = prepareSourceInspection(evidence)(review);
        expect(absent.reason).toBe("field_missing");
        expect(absent.row).not.toBeNull();
        expect(absent.fieldIndex).toBeNull();
    });
    it("does not expose a withheld row and keeps reference/path rejection semantics", () => {
        const { evidence, review } = input();
        evidence.records[0].status = "withheld";
        expect(prepareSourceInspection(evidence)(review)).toMatchObject({ reason: "source_withheld", row: null });
        evidence.records[0].status = "available";
        review.operand.source_index = 9;
        expect(() => prepareSourceInspection(evidence)(review)).toThrow();
        review.operand.source_index = 0; review.operand.selector.table_path = ["unsupported"];
        expect(() => prepareSourceInspection(evidence)(review)).toThrow();
    });
});
