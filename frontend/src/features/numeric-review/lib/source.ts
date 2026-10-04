import type { EvidenceBundle } from "@/features/evidence/types";
import { day } from "@/features/memory/lib/guards";
import type { NumericReason, NumericResult, ReviewRequest } from "../types";
import { requireNumeric, same } from "./guards";
import { numericPolicy } from "./policy";
import { NumberLexeme, parseRawJson, rawObject, type RawJson } from "./raw-json";
export type SelectedSource = {
    reason?: NumericReason;
    lexeme: string | null;
    context: NumericResult["source_context"];
    dataHash: string | null;
};
export function dateComponent(label: string | null) {
    if (!label || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?$/.test(label) || !day(label.slice(0, 10)))
        return null;
    if (label.length > 10) {
        const [hour, minute, second] = label.slice(11, 19).split(":").map(Number);
        if (hour > 23 || minute > 59 || second > 59 || label.endsWith("-00:00"))
            return null;
        const offset = /([+-])([0-9]{2}):([0-9]{2})$/.exec(label);
        if (offset && (Number(offset[2]) > 14 || Number(offset[3]) > 59 || (Number(offset[2]) === 14 && Number(offset[3]) !== 0)))
            return null;
    }
    return label.slice(0, 10);
}
export function selectedSource(review: Pick<ReviewRequest, "operand">, evidence: EvidenceBundle): SelectedSource {
    const operand = review.operand, record = evidence.records.find((item) => item.id === operand.evidence_id);
    requireNumeric(record && Number.isSafeInteger(operand.source_index) && operand.source_index >= 0 && operand.source_index < record.sources.length, "reference_mismatch");
    const source = record.sources[operand.source_index];
    const context: SelectedSource["context"] = { instrument: evidence.instrument, row_date: null, units: source.units, provider: source.provider, historical_availability: source.historical_availability, adjustments: source.adjustments, transformations: [...source.transformations] };
    const missing = (reason: NumericReason): SelectedSource => ({ reason, lexeme: null, context, dataHash: source.data_sha256 });
    if (record.status === "withheld" || source.historical_availability === "withheld")
        return missing("source_withheld");
    if (!["available", "partial"].includes(record.status))
        return missing("source_unavailable");
    if (!source.data_sha256)
        return missing("table_missing");
    const artifact = evidence.artifacts[source.data_sha256];
    requireNumeric(artifact?.kind === "normalized_data", "reference_mismatch");
    let data: RawJson = parseRawJson(artifact.payload);
    const selector = operand.selector;
    requireNumeric(numericPolicy.table_paths.some((path) => same(path, selector.table_path)));
    for (const key of selector.table_path) {
        if (!rawObject(data) || !Object.hasOwn(data, key))
            return missing("table_missing");
        data = data[key];
    }
    if (!rawObject(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows) || !data.columns.length || data.columns.length > numericPolicy.max_table_columns || data.rows.length > numericPolicy.max_table_rows || !data.columns.every((name) => typeof name === "string" && name) || !data.rows.every((row) => Array.isArray(row) && row.length === (data as {
        columns: RawJson[];
    }).columns.length))
        return missing("table_missing");
    const columns = data.columns as string[], rows = data.rows as RawJson[][];
    if (new Set(columns).size !== columns.length)
        return missing("table_ambiguous");
    if (!columns.includes("Date"))
        return missing("table_missing");
    const index = columns.indexOf("Date"), labels = rows.map((row) => row[index]);
    if (!labels.every((label) => typeof label === "string"))
        return missing("table_missing");
    if (new Set(labels).size !== labels.length)
        return missing("row_ambiguous");
    const row = rows.find((row) => row[index] === selector.row_date);
    if (!row || dateComponent(selector.row_date) === null)
        return missing("row_missing");
    context.row_date = selector.row_date;
    const field = columns.indexOf(selector.field);
    if (field === -1)
        return missing("field_missing");
    return row[field] instanceof NumberLexeme ? { lexeme: row[field].raw, context, dataHash: source.data_sha256 } : missing("field_not_numeric");
}
