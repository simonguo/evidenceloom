import type { EvidenceBundle, EvidenceRecord } from "@/features/evidence/types";
import { object, parsePayload } from "@/features/memory/lib/guards";

function observed(value: unknown): boolean {
  if (value === null || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (object(value)) {
    const collections = ["rows", "articles", "transactions", "posts", "messages", "values", "fields"].filter((key) => Object.hasOwn(value, key));
    return collections.length ? collections.some((key) => observed(value[key])) : Object.keys(value).length > 0;
  }
  return true;
}

/** Saved provider input, rather than a non-null hash or successful tool call. */
export function observedSources(record: EvidenceRecord, evidence: EvidenceBundle) {
  return record.sources.filter((source) => {
    if (["unknown", "local_calculation"].includes(source.provider) || source.historical_availability === "withheld" || !source.data_sha256) return false;
    try { return observed(parsePayload(evidence.artifacts[source.data_sha256].payload)); }
    catch { return false; }
  });
}
