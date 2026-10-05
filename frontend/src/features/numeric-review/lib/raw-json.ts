import { requireNumeric } from "./guards";
export class NumberLexeme {
    constructor(public readonly raw: string) { }
}
export type RawJson = null | boolean | string | NumberLexeme | RawJson[] | {
    [key: string]: RawJson;
};
/** Parse saved JSON without ever passing a number through IEEE-754. */
export function parseRawJson(payload: string): RawJson {
    let at = 0;
    const space = () => { while (/[ \t\r\n]/.test(payload[at] ?? "") && at < payload.length)
        at++; };
    function quoted() { const start = at++; while (at < payload.length) {
        const c = payload[at++];
        if (c === "\\")
            at++;
        else if (c === '"')
            return JSON.parse(payload.slice(start, at)) as string;
    } throw new Error(); }
    function value(depth: number): RawJson {
        requireNumeric(depth <= 64);
        space();
        const c = payload[at];
        if (c === '"')
            return quoted();
        if (c === "{" || c === "[") {
            const object = c === "{", end = object ? "}" : "]";
            at++;
            space();
            const result: RawJson[] | Record<string, RawJson> = object ? Object.create(null) as Record<string, RawJson> : [];
            if (payload[at] === end) {
                at++;
                return result;
            }
            while (at < payload.length) {
                if (object) {
                    requireNumeric(payload[at] === '"');
                    const key = quoted();
                    requireNumeric(!Object.hasOwn(result, key));
                    space();
                    requireNumeric(payload[at++] === ":");
                    (result as Record<string, RawJson>)[key] = value(depth + 1);
                }
                else
                    (result as RawJson[]).push(value(depth + 1));
                space();
                if (payload[at] === end) {
                    at++;
                    return result;
                }
                requireNumeric(payload[at++] === ",");
                space();
            }
            throw new Error();
        }
        const match = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(payload.slice(at));
        requireNumeric(match);
        at += match[0].length;
        return match[0] === "null" ? null : match[0] === "true" ? true : match[0] === "false" ? false : new NumberLexeme(match[0]);
    }
    const result = value(0);
    space();
    requireNumeric(at === payload.length);
    return result;
}
export function rawObject(value: RawJson): value is Record<string, RawJson> { return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof NumberLexeme); }
