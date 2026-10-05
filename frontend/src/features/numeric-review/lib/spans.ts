import type { TextSpan } from "../types";
import { rawBytes, requireNumeric } from "./guards";
export function spanText(section: string, span: TextSpan) {
    const bytes = rawBytes(section);
    requireNumeric(Number.isSafeInteger(span.start_byte) && Number.isSafeInteger(span.end_byte) && span.start_byte >= 0 && span.start_byte < span.end_byte && span.end_byte <= bytes.length);
    let selected: string;
    try {
        selected = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(span.start_byte, span.end_byte));
    }
    catch {
        throw new Error();
    }
    requireNumeric(selected === span.text, "reference_mismatch");
    return selected;
}
export function selectionSpan(section: string, start: number, end: number): TextSpan {
    requireNumeric(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= section.length);
    const before = section.slice(0, start), selected = section.slice(start, end);
    return { start_byte: rawBytes(before).length, end_byte: rawBytes(before).length + rawBytes(selected).length, text: selected };
}
/** Textareas expose LF-normalized indices; bind them to untouched original bytes. */
export function textareaSelectionSpan(section: string, start: number, end: number): TextSpan {
    requireNumeric(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start);
    let display = 0, raw = 0, rawStart: number | undefined, rawEnd: number | undefined;
    while (raw <= section.length) {
        if (display === start)
            rawStart = raw;
        if (display === end) {
            rawEnd = raw;
            break;
        }
        if (raw === section.length)
            break;
        raw += section[raw] === "\r" && section[raw + 1] === "\n" ? 2 : 1;
        display++;
    }
    requireNumeric(rawStart !== undefined && rawEnd !== undefined);
    return selectionSpan(section, rawStart, rawEnd);
}
/** Captured section bytes and token boundaries are reused only within one operation. */
export function prepareSectionSpans(section: string) {
    const bytes = rawBytes(section), parts = new Map<string, {
        selected: string;
        start: number;
        end: number;
    }>();
    let tokens: Set<string> | undefined;
    let boundaries: Int32Array | undefined;
    function utf16Boundaries() {
        if (!boundaries) {
            boundaries = new Int32Array(bytes.length + 1).fill(-1);
            let byte = 0;
            for (let index = 0; index < section.length;) {
                boundaries[byte] = index;
                const point = section.codePointAt(index)!;
                byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
                index += point < 0x10000 ? 1 : 2;
            }
            boundaries[bytes.length] = section.length;
        }
        return boundaries;
    }
    function read(span: TextSpan) {
        requireNumeric(Number.isSafeInteger(span.start_byte) && Number.isSafeInteger(span.end_byte) && span.start_byte >= 0 && span.start_byte < span.end_byte && span.end_byte <= bytes.length);
        const key = `${span.start_byte}:${span.end_byte}`;
        let value = parts.get(key);
        if (!value) {
            const offsets = utf16Boundaries(), start = offsets[span.start_byte], end = offsets[span.end_byte];
            requireNumeric(start >= 0 && end >= 0);
            value = { selected: section.slice(start, end), start, end };
            parts.set(key, value);
        }
        requireNumeric(value.selected === span.text, "reference_mismatch");
        return value;
    }
    return {
        text: (span: TextSpan) => read(span).selected,
        number: (span: TextSpan) => {
            const { start, end } = read(span);
            if (!tokens) {
                tokens = new Set([...section.matchAll(/[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g)].map((match) => `${match.index}:${match.index + match[0].length}`));
            }
            if (!tokens.has(`${start}:${end}`))
                return false;
            const left = [...section.slice(Math.max(0, start - 4), start)], right = [...section.slice(end, end + 4)], before = left.at(-1) ?? "", after = right[0] ?? "", number = /\p{N}/u;
            if (before && ("-+−﹣－＋﹢±_".includes(before) || number.test(before)))
                return false;
            if ([".", "٫", "．"].includes(before))
                return false;
            if (after && ("_eE".includes(after) || number.test(after)))
                return false;
            const separators = [".", ",", "٫", "٬", "．", "，", "\u00a0", "\u202f", "\u2009"];
            if ((separators.includes(before) && number.test(left.at(-2) ?? "")) || (separators.includes(after) && number.test(right[1] ?? "")))
                return false;
            let suffix = end;
            while (section[suffix] === " " || section[suffix] === "\t")
                suffix++;
            return !/^(?:[%‰‱％٪千万亿萬億兆]|(?:[kmbt]|bps?|million|billion|trillion)(?![A-Za-z0-9_]))/i.test(section.slice(suffix, suffix + 10));
        },
        literal: (span: TextSpan) => {
            const { start, end } = read(span), word = /[A-Za-z0-9_]/;
            return !word.test(section[start - 1] ?? "") && !word.test(section[end] ?? "");
        },
    };
}
export type SectionSpans = ReturnType<typeof prepareSectionSpans>;
export function fullNumber(section: string, span: TextSpan) {
    return prepareSectionSpans(section).number(span);
}
export function fullLiteral(section: string, span: TextSpan) {
    return prepareSectionSpans(section).literal(span);
}
