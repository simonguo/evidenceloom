import embeddedPolicy from "../../../../../docs/contracts/effective_request_identity_policy_v1.json";
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** Bundled at build time; saved assessments cannot supply or replace this policy. */
export const identityPolicy = freeze(embeddedPolicy);
export const identityPolicySha256 =
  "933c826dc91d445488363e984acb5b66a5082fe548efbc4cfe930a7e71b5aa23";
