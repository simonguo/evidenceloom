import { canonicalJson, isPublicSourceUrl, sha256 } from "@/features/evidence/lib/validation";
import type { MemoryInvalidReason } from "../types";

export class MemoryError extends Error {
  constructor(public readonly reason: MemoryInvalidReason = "malformed") { super(`Research memory validation failed: ${reason}`); }
}
export function assert(value: unknown, reason: MemoryInvalidReason = "malformed"): asserts value {
  if (!value) throw new MemoryError(reason);
}
export function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  assert(object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
export const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const foldInstrument = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
export function day(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) || !day(value.slice(0, 10))) return false;
  const [hours, minutes, seconds] = value.slice(11, 19).split(":").map(Number);
  return hours < 24 && minutes < 60 && seconds < 60;
}
export function stamp(value: string) { assert(timestamp(value)); const [whole, fraction = ""] = value.slice(0, -1).split("."); return `${whole}.${fraction.padEnd(6, "0")}Z`; }
export function offset(value: unknown): value is string { return typeof value === "string" && /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
export function text(value: unknown): value is string { return typeof value === "string" && new TextEncoder().encode(value).length <= 8 * 1024 * 1024 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
const forbidden = new Set(["api_key", "apikey", "access_token", "authorization", "password", "secret", "headers", "cookies", "raw_response", "backend_url", "__proto__", "constructor", "prototype"]);
const unsafe = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]+|\b(?:sk|hy|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}|\/(?:Users|home|tmp|private|var\/folders)\/|[A-Za-z]:\\)/i;
const labelledSecret = /\b(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\b["']?\s*[=:]\s*["']?([^\s,;"'}]+)/gi;
export function safe(value: unknown, depth = 0, numericalFacts = false): void {
  assert(depth <= 64);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { assert(numericalFacts ? Number.isFinite(value) : Number.isSafeInteger(value)); return; }
  if (typeof value === "string") {
    assert(text(value)); assert(!unsafe.test(value), "unsafe_content");
    for (const match of value.matchAll(labelledSecret)) assert(match[1] === "[redacted]", "unsafe_content");
    for (const url of value.match(/https?:\/\/[^\s<>")\]}]+/gi) ?? []) assert(isPublicSourceUrl(url), "unsafe_content");
    return;
  }
  if (Array.isArray(value)) { value.forEach((item) => safe(item, depth + 1, numericalFacts)); return; }
  assert(object(value));
  for (const [key, item] of Object.entries(value)) {
    assert(!forbidden.has(key.toLowerCase()), "unsafe_content"); safe(key, depth + 1, numericalFacts);
    if (!numericalFacts && key === "payload" && value.kind === "canonical_json" && Object.keys(value).length === 3 && Object.hasOwn(value, "sha256")) {
      assert(text(item)); parsePayload(item);
    } else safe(item, depth + 1, numericalFacts);
  }
}
export function bounded(value: unknown) { safe(value); assert(new TextEncoder().encode(canonicalJson(value)).length <= 64 * 1024 * 1024); }
export function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export async function verifyHash(value: Record<string, unknown>, ownKey: string) {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== ownKey));
  try { assert(await sha256(body) === value[ownKey], "hash_mismatch"); }
  catch (error) { if (error instanceof MemoryError) throw error; throw new MemoryError("verification_unavailable"); }
}

// JSON.parse alone accepts duplicate keys. Scan grammar while retaining the
// original opaque string; numeric values are never serialized for a hash.
export function parsePayload(payload: string): unknown {
  let index = 0;
  const whitespace = () => { while (/\s/.test(payload[index] ?? "") && index < payload.length) index++; };
  const string = () => { const start = index++; while (index < payload.length) { const character = payload[index++]; if (character === "\\") index++; else if (character === '"') return JSON.parse(payload.slice(start, index)) as string; } throw new MemoryError(); };
  function value(depth: number): void {
    assert(depth <= 64); whitespace(); const character = payload[index];
    if (character === '"') { string(); return; }
    if (character === "{" || character === "[") {
      const isObject = character === "{"; const end = isObject ? "}" : "]"; const keys = new Set(); index++; whitespace();
      if (payload[index] === end) { index++; return; }
      while (index < payload.length) {
        if (isObject) { assert(payload[index] === '"'); const key = string(); assert(!keys.has(key)); keys.add(key); whitespace(); assert(payload[index++] === ":"); }
        value(depth + 1); whitespace(); if (payload[index] === end) { index++; return; } assert(payload[index++] === ","); whitespace();
      }
      throw new MemoryError();
    }
    const match = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(payload.slice(index)); assert(match); index += match[0].length;
  }
  try { value(0); whitespace(); assert(index === payload.length); const parsed: unknown = JSON.parse(payload); safe(parsed, 0, true); return parsed; }
  catch (error) { if (error instanceof MemoryError) throw error; throw new MemoryError(); }
}
