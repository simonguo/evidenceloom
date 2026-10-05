import { canonicalJson, sha256 } from "@/features/evidence/lib/validation";
import { bounded, text } from "@/features/memory/lib/guards";
import type { NumericInvalidReason } from "../types";
export class NumericError extends Error {
    constructor(public readonly reason: NumericInvalidReason = "malformed") { super(`Numeric review validation failed: ${reason}`); }
}
export function requireNumeric(value: unknown, reason: NumericInvalidReason = "malformed"): asserts value { if (!value)
    throw new NumericError(reason); }
export function fixed(error: unknown): never {
    if (error instanceof NumericError)
        throw error;
    const reason = (error as {
        reason?: string;
    })?.reason;
    throw new NumericError(["hash_mismatch", "unsafe_content", "verification_unavailable"].includes(reason ?? "") ? reason as NumericInvalidReason : "malformed");
}
export function safeBounded(value: unknown) { try {
    bounded(value);
}
catch (error) {
    fixed(error);
} }
export const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function rawBytes(value: string) { requireNumeric(text(value)); return new TextEncoder().encode(value); }
export async function utf8Sha(value: string) {
    const bytes = rawBytes(value);
    try {
        const result = await crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(result)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    catch {
        throw new NumericError("verification_unavailable");
    }
}
export async function checkHash(value: Record<string, unknown>, key: string) {
    try {
        requireNumeric(await sha256(Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))) === value[key], "hash_mismatch");
    }
    catch (error) {
        fixed(error);
    }
}
