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
export function fullNumber(section: string, span: TextSpan) {
    spanText(section, span);
    const bytes = rawBytes(section), prefix = new TextDecoder().decode(bytes.slice(0, span.start_byte)), suffix = new TextDecoder().decode(bytes.slice(span.end_byte));
    let found = false;
    for (const match of section.matchAll(/[+-]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g)) {
        if (match.index === prefix.length && match[0].length === span.text.length) {
            found = true;
            break;
        }
    }
    if (!found)
        return false;
    const before = [...prefix].at(-1) ?? "", after = [...suffix][0] ?? "", number = /\p{N}/u;
    if (before && ("-+−﹣－＋﹢±_".includes(before) || number.test(before)))
        return false;
    if ([".", "٫", "．"].includes(before))
        return false;
    if (after && ("_eE".includes(after) || /\p{N}/u.test(after)))
        return false;
    if (([".", ",", "٫", "٬", "．", "，", "\u00a0", "\u202f", "\u2009"].includes(before) && number.test([...prefix].at(-2) ?? "")) || ([".", ",", "٫", "٬", "．", "，", "\u00a0", "\u202f", "\u2009"].includes(after) && number.test([...suffix][1] ?? "")))
        return false;
    return !/^(?:[%‰‱％٪千万亿萬億兆]|(?:[kmbt]|bps?|million|billion|trillion)(?![A-Za-z0-9_]))/i.test(suffix.replace(/^[ \t]+/, ""));
}
export function fullLiteral(section: string, span: TextSpan) {
    spanText(section, span);
    const bytes = rawBytes(section), prefix = new TextDecoder().decode(bytes.slice(0, span.start_byte)), suffix = new TextDecoder().decode(bytes.slice(span.end_byte));
    const word = /[A-Za-z0-9_]/;
    return !word.test([...prefix].at(-1) ?? "") && !word.test([...suffix][0] ?? "");
}
