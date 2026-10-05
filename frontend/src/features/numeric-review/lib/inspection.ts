import type { ReportVersion } from "@/lib/types";
import type { ContextBindings, ContextKey, NumericReview, TextSpan } from "../types";
import { requireNumeric, same } from "./guards";
import { immutableVersionCore } from "./history";
import { NumberLexeme, type RawJson } from "./raw-json";
import { prepareSourceInspection, type SourceInspection } from "./source";

/** The selected object identity is part of the display owner, not just its ID. */
export type NumericDisplayOwner = Readonly<{ taskId: string; versionOwner: ReportVersion }>;
export type VerifiedNumericParent = Readonly<{ owner: NumericDisplayOwner; version: ReportVersion }>;
export type OriginalSegment = { text: string; startByte: number; endByte: number; numeric: boolean; contexts: ContextKey[] };
export type SavedNumericInspection = { parent: VerifiedNumericParent; review: NumericReview; section: string; segments: OriginalSegment[]; source: SourceInspection };

/** Closed disclosures show only a generic label, never attachment-derived data. */
export function hasNumericDisplayOwner(current: NumericDisplayOwner, parent: VerifiedNumericParent | undefined): parent is VerifiedNumericParent {
    return Boolean(parent && current.taskId === parent.owner.taskId && current.versionOwner === parent.owner.versionOwner);
}
export function matchesNumericParent(current: NumericDisplayOwner, parent: VerifiedNumericParent | undefined): parent is VerifiedNumericParent {
    if (!hasNumericDisplayOwner(current, parent)) return false;
    try {
        return same(immutableVersionCore(current.versionOwner), immutableVersionCore(parent.version))
            && same(current.versionOwner.numericReviews ?? [], parent.version.numericReviews ?? []);
    } catch { return false; }
}

/** Decode each byte partition without consuming a BOM or normalizing line endings. */
export function partitionOriginal(section: string, numeric: TextSpan, bindings: ContextBindings): OriginalSegment[] {
    const bytes = new TextEncoder().encode(section), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const spans: { span: TextSpan; context?: ContextKey }[] = [{ span: numeric }, ...Object.entries(bindings).flatMap(([context, span]) => span ? [{ span, context: context as ContextKey }] : [])];
    const boundaries = new Set([0, bytes.length]);
    for (const { span } of spans) {
        requireNumeric(Number.isSafeInteger(span.start_byte) && Number.isSafeInteger(span.end_byte) && span.start_byte >= 0 && span.end_byte > span.start_byte && span.end_byte <= bytes.length);
        requireNumeric(decoder.decode(bytes.slice(span.start_byte, span.end_byte)) === span.text, "reference_mismatch");
        boundaries.add(span.start_byte); boundaries.add(span.end_byte);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    const segments = sorted.slice(0, -1).map((startByte, index) => {
        const endByte = sorted[index + 1];
        return { text: decoder.decode(bytes.slice(startByte, endByte)), startByte, endByte,
            numeric: numeric.start_byte <= startByte && numeric.end_byte >= endByte,
            contexts: spans.flatMap(({ span, context }) => context && span.start_byte <= startByte && span.end_byte >= endByte ? [context] : []) };
    });
    requireNumeric(segments.map((segment) => segment.text).join("") === section, "reference_mismatch");
    return segments;
}

export function inspectSavedNumeric(current: NumericDisplayOwner, parent: VerifiedNumericParent | undefined, reviewId: string): SavedNumericInspection | null {
    if (!matchesNumericParent(current, parent)) return null;
    const version = parent.version, review = version.numericReviews?.find((item) => item.review_id === reviewId);
    const snapshot = version.reportTextSnapshot, evidence = version.evidenceBundle;
    if (!review || !snapshot || !evidence) return null;
    const target = review.target;
    if (target.task_id !== current.taskId || target.version_id !== version.id || target.run_id !== version.runId || target.run_id !== snapshot.run_id
        || target.report_snapshot_sha256 !== snapshot.snapshot_sha256 || snapshot.evidence_bundle_sha256 !== evidence.bundle_sha256
        || snapshot.run_id !== evidence.run_id || !Object.hasOwn(snapshot.report_sections, target.section_key)) return null;
    const section = snapshot.report_sections[target.section_key];
    if (typeof section !== "string") return null;
    try {
        const source = prepareSourceInspection(evidence)(review);
        if (source.dataHash !== review.operand.data_sha256 || source.context.provider !== review.operand.provider) return null;
        return { parent, review, section, source, segments: partitionOriginal(section, review.numeric_span, review.context_bindings) };
    } catch { return null; }
}

export function rawCellPresentation(value: RawJson): { type: "number" | "string" | "null" | "boolean" | "array" | "object"; literal: string } {
    if (value instanceof NumberLexeme) return { type: "number", literal: value.raw };
    if (value === null) return { type: "null", literal: "null" };
    if (typeof value === "string") return { type: "string", literal: JSON.stringify(value) };
    if (typeof value === "boolean") return { type: "boolean", literal: value ? "true" : "false" };
    return { type: Array.isArray(value) ? "array" : "object", literal: Array.isArray(value) ? "[…]" : "{…}" };
}
