import frozenPolicy from "../../../../../docs/contracts/memory_target_policy_v1.json";
import { canonicalJson } from "@/features/evidence/lib/validation";

export const targetPolicy = frozenPolicy;

export const targetPolicyArtifact = {
  kind: "canonical_json" as const,
  payload: canonicalJson(targetPolicy),
  sha256: "b76b4c71e3dd367e356e9762cb656628f174241607e00d99c7dfa5f75cbebfc2",
};
