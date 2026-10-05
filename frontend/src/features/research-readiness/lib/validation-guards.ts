import { MemoryError } from "@/features/memory/lib/guards";
import { EvidenceError } from "@/features/evidence/lib/validation";
import type { ReadinessInvalidReason, ReadinessValidation } from "../types";

export class ReadinessError extends Error {
  constructor(public readonly reason: ReadinessInvalidReason = "malformed") { super(`Research input checks could not be verified: ${reason}`); }
}
export function assert(value: unknown, reason: ReadinessInvalidReason = "malformed"): asserts value {
  if (!value) throw new ReadinessError(reason);
}
export function invalidReadiness(error: unknown): ReadinessValidation {
  if (error instanceof EvidenceError) return { status: "invalid", reason: error.reason === "citation_mismatch" ? "reference_mismatch" : error.reason };
  return { status: "invalid", reason: error instanceof ReadinessError || error instanceof MemoryError ? error.reason : "malformed" };
}
export function fixedError(error: unknown): never { throw new ReadinessError(invalidReadiness(error).reason); }
