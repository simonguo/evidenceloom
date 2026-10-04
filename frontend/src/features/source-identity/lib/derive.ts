import type { EvidenceBundle } from "@/features/evidence/types";
import { object } from "@/features/memory/lib/guards";
import type {
  ContentScope,
  EffectiveRequestIdentity,
  IdentityAlignment,
  IdentityReason,
  IdentityRecordAssessment,
  SelectorAssessment,
} from "../types";
import { requireIdentity } from "./guards";
import { identityPolicy } from "./policy";
type Relation = [IdentityAlignment, IdentityReason, string, SelectorAssessment["venue"]];
function normalized(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > identityPolicy.limits.max_identifier_bytes
  )
    return null;
  return (
    value
      .replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "")
      .replace(/[a-z]/g, (letter) => letter.toUpperCase()) || null
  );
}
function mainland(value: string): ["SH" | "SZ", string] | null {
  const match = /^(?:(SH|SZ)([0-9]{6})|([0-9]{6})\.(SH|SS|SZ))$/.exec(value);
  return match
    ? [["SH", "SS"].includes(match[1] ?? match[4]) ? "SH" : "SZ", match[2] ?? match[3]]
    : null;
}
function qualified(value: string): ["SH" | "SZ" | "HK", string] | null {
  const m = mainland(value);
  if (m) return m;
  const hk = /^([0-9]{1,4})\.HK$/.exec(value);
  return hk ? ["HK", hk[1].padStart(4, "0")] : null;
}
function pair(value: string): [string, string] | null {
  value = value.endsWith("=X") ? value.slice(0, -2) : value;
  for (const quote of identityPolicy.currency_codes)
    for (const base of [...identityPolicy.currency_codes, ...identityPolicy.crypto_bases])
      if ([base + quote, base + "-" + quote].includes(value)) return [base, quote];
  return null;
}
const equalPair = (a: [string, string] | null, b: [string, string] | null) =>
  a !== null && b !== null && a[0] === b[0] && a[1] === b[1];
const ascii = (value: string) => [...value].every((character) => character.charCodeAt(0) <= 127);
function relation(expected: string | null, selected: string | null): Relation {
  if (expected === null || selected === null)
    return ["unknown", "effective_request_unusable", "no_proved_effective_selector", null];
  if (expected === selected)
    return [
      "consistent",
      "effective_request_aligned",
      ascii(expected) ? "ascii_literal" : "exact_preserved_literal",
      null,
    ];
  const proxies = identityPolicy.proxy_pairs as Record<string, string>;
  if (proxies[expected] === selected || proxies[selected] === expected)
    return ["proxy", "declared_proxy_reference", "explicit_yahoo_reference_pair", null];
  const a = qualified(expected),
    b = qualified(selected);
  if (a && b) {
    if (a[0] === b[0] && a[1] === b[1])
      return [
        "consistent",
        "effective_request_aligned",
        a[0] === "HK" ? "hk_explicit_suffix_padding_v1" : "mainland_explicit_venue_v1",
        a[0],
      ];
    if (a[1] === b[1] && a[0] !== b[0])
      return ["conflict", "explicit_venue_conflict", "mainland_explicit_venue_v1", null];
  }
  for (const [bare, q] of [
    [expected, b],
    [selected, a],
  ] as const)
    if (q && /^[0-9]{1,6}$/.test(bare)) {
      const code = q[0] === "HK" && bare.length <= 4 ? bare.padStart(4, "0") : bare;
      if (code === q[1]) return ["unknown", "unqualified_venue", "no_bare_venue_inference", null];
    }
  if (!ascii(expected) || !ascii(selected))
    return ["unknown", "unreviewed_identifier_relation", "no_unicode_normalization", null];
  if (expected.includes("+") || selected.includes("+"))
    return ["unknown", "unreviewed_identifier_relation", "unsupported_broker_qualifier", null];
  if (
    [expected, selected].some((value) => value.endsWith(".HK") && !/^([0-9]{1,4})\.HK$/.test(value))
  )
    return ["unknown", "unreviewed_identifier_relation", "outside_reviewed_hk_rule", null];
  if ([expected, selected].some((value) => /\.(SH|SS|SZ)$/.test(value) && !mainland(value)))
    return ["unknown", "unreviewed_identifier_relation", "malformed_qualified_identifier", null];
  if (equalPair(pair(expected), pair(selected)))
    return ["unknown", "unreviewed_identifier_relation", "pair_namespace_not_captured", null];
  for (const [discussion, value] of [
    [expected, selected],
    [selected, expected],
  ]) {
    const p = pair(value);
    if (discussion.endsWith(".X") && p && discussion.slice(0, -2) === p[0])
      return [
        "unknown",
        "unreviewed_identifier_relation",
        "discussion_namespace_not_captured",
        null,
      ];
  }
  const plain = new RegExp(`^${identityPolicy.plain_identifier_grammar}$`);
  if (plain.test(expected) && plain.test(selected))
    return ["conflict", "effective_request_conflict", "different_saved_ascii_literal", null];
  return ["unknown", "unreviewed_identifier_relation", "unsupported_identifier_notation", null];
}
export function assessSelector(
  instrument: unknown,
  tool: string,
  parameters: unknown,
): SelectorAssessment & { tool: string } {
  requireIdentity(Object.hasOwn(identityPolicy.tool_scopes, tool) && object(parameters));
  const scope = identityPolicy.tool_scopes[tool as keyof typeof identityPolicy.tool_scopes];
  const selector = scope.selector as SelectorAssessment["canonical_selector_key"],
    contentScope = scope.content_scope as ContentScope;
  const extras =
    contentScope === "legacy_tool_scope_unknown"
      ? []
      : identityPolicy.selector_like_keys
          .filter((key) => key !== selector && Object.hasOwn(parameters, key))
          .sort();
  const [alignment, reason, rule, venue]: Relation =
    contentScope === "global_query"
      ? ["not_applicable", "global_query_not_instrument_scoped", "global_query", null]
      : selector === null
        ? ["unknown", "legacy_tool_scope_unknown", "legacy_unknown", null]
        : !Object.hasOwn(parameters, selector)
          ? ["unknown", "effective_request_missing", "no_proved_effective_selector", null]
          : relation(normalized(instrument), normalized(parameters[selector]));
  return {
    tool,
    content_scope: contentScope,
    canonical_selector_key: selector,
    canonical_alignment: alignment,
    canonical_reason: reason,
    canonical_rule: rule,
    record_alignment: extras.length && alignment !== "conflict" ? "unknown" : alignment,
    record_reason:
      extras.length && alignment !== "conflict" ? "unexpected_selector_metadata" : reason,
    venue,
    unexpected_selector_keys: extras,
  };
}
export function deriveIdentityRecords(evidence: EvidenceBundle): IdentityRecordAssessment[] {
  requireIdentity(evidence.records.length <= identityPolicy.limits.max_records);
  return [...evidence.records]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((record) => {
      requireIdentity(record.sources.length <= identityPolicy.limits.max_sources_per_record);
      return {
        ...assessSelector(evidence.instrument, record.tool, record.parameters),
        evidence_id: record.id,
        sources: record.sources.map((source, source_index) => ({
          source_index,
          provider: source.provider,
          data_sha256: source.data_sha256,
          provider_request: "unknown" as const,
          provider_entity: "unknown" as const,
        })),
      };
    });
}
export function identitySummary(
  records: IdentityRecordAssessment[],
): EffectiveRequestIdentity["summary"] {
  const count = (alignment: IdentityAlignment) =>
    records.filter((record) => record.record_alignment === alignment).length;
  return {
    record_count: records.length,
    source_count: records.reduce((sum, record) => sum + record.sources.length, 0),
    consistent_count: count("consistent"),
    conflict_count: count("conflict"),
    unknown_count: count("unknown"),
    proxy_count: count("proxy"),
    not_applicable_count: count("not_applicable"),
    unsafe_record_ids: records
      .filter(
        (record) =>
          record.content_scope !== "global_query" &&
          ["conflict", "unknown", "proxy"].includes(record.record_alignment),
      )
      .map((record) => record.evidence_id),
  };
}
