import { canonicalJson } from "@/features/evidence/lib/validation";
import type { EvaluationTarget, EvaluationTargetBinding } from "../types";
import { assert, clone, exact, hash, text, timestamp } from "./guards";
import { targetPolicy, targetPolicyArtifact } from "./target-policy";

/** Request notation only; this does not resolve a listing or provider entity. */
export function deriveEvaluationTarget(role: EvaluationTarget["role"], requested: string): EvaluationTarget {
  assert((role === "instrument" || role === "benchmark") && text(requested));
  const target: EvaluationTarget = { role, requested_symbol: requested, request_symbol: null, relation: "unknown" };
  let symbol = requested.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
  if ([...symbol].some((character) => character.charCodeAt(0) > 127)) return target;
  symbol = symbol.toUpperCase();
  if (!/^[A-Z0-9._^=-]{1,64}$/.test(symbol) || /^[0-9]+$/.test(symbol)) return target;
  const admittedVenue = /^(?:[0-9]{6}\.(?:SH|SS|SZ)|[0-9]{1,4}\.HK)$/.test(symbol);
  if ((/^[0-9].*\./.test(symbol) && !admittedVenue)
    || ([".SH", ".SS", ".SZ", ".HK"].some((suffix) => symbol.endsWith(suffix)) && !admittedVenue)
    || (/^(?:SH|SZ)[0-9]/.test(symbol) && !/^(?:SH|SZ)[0-9]{6}$/.test(symbol))) return target;
  let relation: EvaluationTarget["relation"] = "exact";
  const proxies: Record<string, string> = targetPolicy.proxy_aliases;
  if (Object.hasOwn(proxies, symbol)) {
    symbol = proxies[symbol];
    relation = "proxy";
  } else if (/^[0-9]{6}\.SH$/.test(symbol)) {
    symbol = `${symbol.slice(0, -3)}.SS`;
    relation = "venue_notation";
  } else if (/^(?:SH|SZ)[0-9]{6}$/.test(symbol)) {
    symbol = `${symbol.slice(2)}${symbol.startsWith("SH") ? ".SS" : ".SZ"}`;
    relation = "venue_notation";
  } else if (/^[0-9]{1,4}\.HK$/.test(symbol)) {
    symbol = `${symbol.slice(0, -3).padStart(4, "0")}.HK`;
    relation = "venue_notation";
  } else if (symbol.endsWith("USD") && (targetPolicy.crypto_bases as readonly string[]).includes(symbol.slice(0, -3))) {
    symbol = `${symbol.slice(0, -3)}-USD`;
    relation = "pair_notation";
  } else if (symbol.length === 6 && (targetPolicy.forex_currencies as readonly string[]).includes(symbol.slice(0, 3)) && (targetPolicy.forex_currencies as readonly string[]).includes(symbol.slice(3))) {
    symbol += "=X";
    relation = "pair_notation";
  }
  return { ...target, request_symbol: symbol, relation };
}

export function copyTargetBinding(value: unknown): EvaluationTargetBinding {
  exact(value, ["schema_version", "research_started_at", "provider", "request_namespace", "adapter_id", "adapter_code_sha256", "resolver_code_sha256", "policy_version", "policy_artifact_sha256", "targets", "binding_sha256"]);
  assert(value.schema_version === 1 && timestamp(value.research_started_at));
  assert(value.provider === targetPolicy.provider && value.request_namespace === targetPolicy.request_namespace && value.adapter_id === "yfinance-ticker-history-direct-v1" && value.policy_version === targetPolicy.policy_version);
  assert(hash(value.adapter_code_sha256) && hash(value.resolver_code_sha256) && hash(value.binding_sha256));
  assert(value.policy_artifact_sha256 === targetPolicyArtifact.sha256, "reference_mismatch");
  assert(Array.isArray(value.targets) && value.targets.length === 2);
  for (const [index, role] of (["instrument", "benchmark"] as const).entries()) {
    const target = value.targets[index];
    exact(target, ["role", "requested_symbol", "request_symbol", "relation"]);
    assert(text(target.requested_symbol));
    assert(canonicalJson(target) === canonicalJson(deriveEvaluationTarget(role, target.requested_symbol)), "reference_mismatch");
  }
  return clone(value) as unknown as EvaluationTargetBinding;
}
