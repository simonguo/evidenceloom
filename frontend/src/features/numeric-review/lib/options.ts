import type { EvidenceBundle } from "@/features/evidence/types";
import type { TableSelector } from "../types";
import { NumberLexeme, parseRawJson, rawObject } from "./raw-json";
export function sourceChoices(evidence: EvidenceBundle) {
    return evidence.records.flatMap((record) => record.sources.map((source, index) => ({ key: `${record.id}:${index}`, recordId: record.id, index, label: `${record.id} · ${record.tool} · ${source.provider} · ${record.status}` })));
}
export function tableChoices(evidence: EvidenceBundle, recordId: string, index: number, path: string[]) {
    try {
        const source = evidence.records.find((record) => record.id === recordId)?.sources[index];
        const artifact = source?.data_sha256 ? evidence.artifacts[source.data_sha256] : undefined;
        if (artifact?.kind !== "normalized_data")
            return { dates: [], fields: [] };
        let table = parseRawJson(artifact.payload);
        for (const key of path) {
            if (!rawObject(table))
                return { dates: [], fields: [] };
            table = table[key];
        }
        if (!rawObject(table) || !Array.isArray(table.columns) || !Array.isArray(table.rows))
            return { dates: [], fields: [] };
        const columns = table.columns, dateIndex = columns.indexOf("Date");
        return { dates: [...new Set(table.rows.flatMap((row) => Array.isArray(row) && typeof row[dateIndex] === "string" ? [row[dateIndex] as string] : []))].slice(0, 100), fields: columns.filter((column): column is string => typeof column === "string" && column !== "Date").slice(0, 256) };
    }
    catch {
        return { dates: [], fields: [] };
    }
}
export function selectedFieldLexeme(evidence: EvidenceBundle, recordId: string, index: number, selector: TableSelector) {
    try {
        const source = evidence.records.find((record) => record.id === recordId)?.sources[index];
        if (!source?.data_sha256)
            return null;
        let table = parseRawJson(evidence.artifacts[source.data_sha256].payload);
        for (const key of selector.table_path) {
            if (!rawObject(table))
                return null;
            table = table[key];
        }
        if (!rawObject(table) || !Array.isArray(table.columns) || !Array.isArray(table.rows))
            return null;
        const dates = table.columns.indexOf("Date"), field = table.columns.indexOf(selector.field);
        const matches = table.rows.filter((row) => Array.isArray(row) && row[dates] === selector.row_date);
        if (matches.length !== 1 || !Array.isArray(matches[0]))
            return null;
        const cell = matches[0][field];
        return cell instanceof NumberLexeme ? cell.raw : null;
    }
    catch {
        return null;
    }
}
