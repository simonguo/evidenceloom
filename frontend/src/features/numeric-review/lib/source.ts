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
type SavedTable = {
    reason: NumericReason;
} | {
    columns: string[];
    rows: Map<string, RawJson[]>;
};
export type SourceResolver = (review: Pick<ReviewRequest, "operand">) => SelectedSource;
/** A cache belongs to one captured envelope, never to a hash across operations. */
export function prepareSourceResolver(evidence: EvidenceBundle): SourceResolver {
    const artifacts = new Map<string, RawJson>(), tables = new Map<string, SavedTable>(), selections = new Map<string, SelectedSource>();
    function table(dataHash: string, path: string[]): SavedTable {
        const key = JSON.stringify([dataHash, path]);
        const cached = tables.get(key);
        if (cached)
            return cached;
        const save = (value: SavedTable) => { tables.set(key, value); return value; };
        let data = artifacts.get(dataHash);
        if (data === undefined) {
            data = parseRawJson(evidence.artifacts[dataHash].payload);
            artifacts.set(dataHash, data);
        }
        for (const key of path) {
            if (!rawObject(data) || !Object.hasOwn(data, key))
                return save({ reason: "table_missing" });
            data = data[key];
        }
        if (!rawObject(data) || !Array.isArray(data.columns) || !Array.isArray(data.rows) || !data.columns.length || data.columns.length > numericPolicy.max_table_columns || data.rows.length > numericPolicy.max_table_rows || !data.columns.every((name) => typeof name === "string" && name) || !data.rows.every((row) => Array.isArray(row) && row.length === (data as {
            columns: RawJson[];
        }).columns.length))
            return save({ reason: "table_missing" });
        const columns = data.columns as string[], rows = data.rows as RawJson[][];
        if (new Set(columns).size !== columns.length)
            return save({ reason: "table_ambiguous" });
        if (!columns.includes("Date"))
            return save({ reason: "table_missing" });
        const index = columns.indexOf("Date"), labels = rows.map((row) => row[index]);
        if (!labels.every((label) => typeof label === "string"))
            return save({ reason: "table_missing" });
        if (new Set(labels).size !== labels.length)
            return save({ reason: "row_ambiguous" });
        return save({ columns, rows: new Map(rows.map((row) => [row[index] as string, row])) });
    }
    function resolve(review: Pick<ReviewRequest, "operand">): SelectedSource {
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
        const selector = operand.selector;
        requireNumeric(numericPolicy.table_paths.some((path) => same(path, selector.table_path)));
        const saved = table(source.data_sha256, selector.table_path);
        if ("reason" in saved)
            return missing(saved.reason);
        const row = saved.rows.get(selector.row_date);
        if (!row || dateComponent(selector.row_date) === null)
            return missing("row_missing");
        context.row_date = selector.row_date;
        const field = saved.columns.indexOf(selector.field);
        if (field === -1)
            return missing("field_missing");
        return row[field] instanceof NumberLexeme ? { lexeme: row[field].raw, context, dataHash: source.data_sha256 } : missing("field_not_numeric");
    }
    return (review) => {
        const operand = review.operand, key = JSON.stringify([operand.evidence_id, operand.source_index, operand.selector]);
        let selected = selections.get(key);
        if (!selected) {
            selected = resolve(review);
            selections.set(key, selected);
        }
        return { ...selected, context: { ...selected.context, transformations: [...selected.context.transformations] } };
    };
}
export function selectedSource(review: Pick<ReviewRequest, "operand">, evidence: EvidenceBundle): SelectedSource {
    return prepareSourceResolver(evidence)(review);
}
