import { canonicalJson } from "@/features/evidence/lib/validation";
import type { IdentityInvalidReason, IdentityValidation } from "../types";
export const identityInvalidReasons: IdentityInvalidReason[] = [
  "malformed",
  "hash_mismatch",
  "reference_mismatch",
  "unsafe_content",
  "verification_unavailable",
];
export class IdentityError extends Error {
  constructor(public readonly reason: IdentityInvalidReason = "malformed") {
    super(`Effective request identity validation failed: ${reason}`);
  }
}
export function requireIdentity(
  value: unknown,
  reason: IdentityInvalidReason = "malformed",
): asserts value {
  if (!value) throw new IdentityError(reason);
}
export function fixedIdentity(error: unknown): never {
  if (error instanceof IdentityError) throw error;
  const reason = (error as { reason?: IdentityInvalidReason })?.reason;
  throw new IdentityError(identityInvalidReasons.includes(reason!) ? reason : "malformed");
}
export function invalidIdentity(error: unknown): IdentityValidation {
  try {
    fixedIdentity(error);
  } catch (fixed) {
    return { status: "invalid", reason: (fixed as IdentityError).reason };
  }
}
export const sameIdentity = (left: unknown, right: unknown) =>
  canonicalJson(left) === canonicalJson(right);
