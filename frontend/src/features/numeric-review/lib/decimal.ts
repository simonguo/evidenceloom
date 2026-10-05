import { numericPolicy } from "./policy";
type Decimal = {
    negative: boolean;
    coefficient: bigint;
    scale: number;
};
export function parseDecimal(literal: string): Decimal | null {
    if (new TextEncoder().encode(literal).length > numericPolicy.max_number_bytes)
        return null;
    const match = /^([+-]?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(literal);
    if (!match)
        return null;
    const digits = match[2] + (match[3] ?? "");
    if (digits.length > numericPolicy.max_coefficient_digits || (match[4]?.replace(/^[+-]?0*/, "").length ?? 0) > 4)
        return null;
    const exponent = Number(match[4] ?? "0");
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > numericPolicy.max_abs_exponent)
        return null;
    return { negative: match[1] === "-", coefficient: BigInt(digits), scale: (match[3]?.length ?? 0) - exponent };
}
export function roundedDecimal(literal: string, places: number): string | null {
    const value = parseDecimal(literal);
    if (!value || !Number.isInteger(places) || places < 0 || places > numericPolicy.max_decimal_places)
        return null;
    const shift = value.scale - places;
    let result = value.coefficient;
    if (shift > 0) {
        const divisor = BigInt(10) ** BigInt(shift);
        result = result / divisor + (result % divisor * BigInt(2) >= divisor ? BigInt(1) : BigInt(0));
    }
    else
        result *= BigInt(10) ** BigInt(-shift);
    const digits = result.toString().padStart(places + 1, "0");
    return `${value.negative && result !== BigInt(0) ? "-" : ""}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
}
export function decimalEqual(left: string, right: string) {
    const a = parseDecimal(left);
    const match = right.length <= 1200 ? /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(right) : null;
    const b = match ? { negative: match[1] === "-", coefficient: BigInt(match[2] + (match[3] ?? "")), scale: match[3]?.length ?? 0 } : null;
    if (!a || !b)
        return false;
    if (!a.coefficient && !b.coefficient)
        return true;
    if (a.negative !== b.negative)
        return false;
    const scale = Math.max(a.scale, b.scale);
    return a.coefficient * BigInt(10) ** BigInt(scale - a.scale) === b.coefficient * BigInt(10) ** BigInt(scale - b.scale);
}
