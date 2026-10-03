import type { AnalysisEvent, AnalysisTask, ReportVersion } from "@/lib/types";
import type { EvidenceBundle, EvidenceInvalidReason, EvidenceValidation, JsonValue } from "../types";

const hashPattern = /^[a-f0-9]{64}$/;
const idPattern = /^ev-[a-f0-9]{32}$/;
const providers = ["yfinance", "eastmoney", "tencent", "alpha_vantage", "akshare", "stocktwits", "reddit", "local_calculation", "unknown"];
const statuses = ["available", "partial", "empty", "unavailable", "withheld"];
const tools = ["get_stock_data", "get_indicators", "get_fundamentals", "get_balance_sheet", "get_cashflow", "get_income_statement", "get_news", "get_global_news", "get_insider_transactions", "get_market_data_snapshot", "get_verified_market_snapshot", "fetch_stocktwits_messages", "fetch_reddit_posts", "fetch_china_sentiment_sources", "resolve_instrument_context"];
const parameters = ["ticker", "symbol", "instrument", "trade_date", "curr_date", "start_date", "end_date", "indicator", "look_back_days", "lookback_days", "limit", "limit_per_sub", "subreddits", "queries", "freq", "interval", "time_period", "series_type"];
const manifestKeys = ["core_version", "upstream_revision", "app_version", "llm_provider", "quick_think_llm", "deep_think_llm", "analysts", "max_debate_rounds", "max_risk_discuss_rounds", "max_tool_rounds", "analyst_concurrency_limit", "output_language", "temperature", "max_tokens", "data_vendors", "tool_vendors", "trade_date", "asset_type", "holding_period_days", "benchmark_ticker", "code_revision", "code_dirty", "code_sha256", "prompt_templates_sha256", "memory_input_sha256", "instrument_identity_context_sha256", "model_context_sha256"];
const reportKeys = ["market_report", "sentiment_report", "news_report", "fundamentals_report", "investment_plan", "trader_investment_plan", "final_trade_decision", "investment_debate_state.bull_history", "investment_debate_state.bear_history", "investment_debate_state.judge_decision", "risk_debate_state.aggressive_history", "risk_debate_state.conservative_history", "risk_debate_state.neutral_history", "risk_debate_state.judge_decision"];
const citationPattern = /^[A-Za-z0-9_-]{1,100}$/;
const bundleKeys = ["schema_version", "run_id", "instrument", "analysis_date", "research_as_of", "as_of_policy", "market_timezone", "created_at", "manifest", "manifest_sha256", "records", "artifacts", "citation_audit", "bundle_sha256"];
const recordKeys = ["id", "analyst", "tool", "instrument", "parameters", "status", "fetched_at", "output_sha256", "sources", "attempts"];
const sourceKeys = ["provider", "url", "observed_window", "publication_dates", "historical_availability", "units", "adjustments", "transformations", "data_sha256"];
const forbiddenKeys = /^(?:api.?key|authorization|cookies?|headers?|credentials?|secrets?|password|access.?token|refresh.?token|raw|raw_response|exception|error|traceback|endpoint|base.?url|backend.?url|project.?root|storage.?dir|python.?path)$/i;
const unsafeText = /(?:Bearer\s+[\w.-]+|(?:sk|hy|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}|\/(?:Users|home|tmp|private|var\/folders)\/|[A-Za-z]:\\|(?:api[_ -]?key|access[_ -]?token|authorization|password|secret)\s*[:=]\s*[^\s["{}]+)/i;

export class EvidenceError extends Error {
  constructor(public readonly reason: EvidenceInvalidReason) { super(`Evidence validation failed: ${reason}`); }
}
function assert(condition: unknown, reason: EvidenceInvalidReason = "malformed"): asserts condition {
  if (!condition) throw new EvidenceError(reason);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  assert(object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
function text(value: unknown): value is string { return typeof value === "string" && value.length <= 8_000_000; }
function hash(value: unknown): value is string { return typeof value === "string" && hashPattern.test(value); }
function date(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith("0000") && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
export function isPublicSourceUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && !url.port
      && url.hostname.includes(".") && !/(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(url.hostname)
      && !/^(?:\d+[.]|\[|127[.]|0[.])/.test(url.hostname);
  } catch { return false; }
}
function safeJson(value: unknown, depth = 0, integerOnly = true): asserts value is JsonValue {
  assert(depth <= 32);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { assert(integerOnly ? Number.isSafeInteger(value) : Number.isFinite(value)); return; }
  if (typeof value === "string") { assert(text(value)); assert(!unsafeText.test(value), "unsafe_content"); for (const url of value.match(/https?:\/\/[^\s<>")\]}]+/gi) ?? []) assert(isPublicSourceUrl(url), "unsafe_content"); return; }
  if (Array.isArray(value)) { assert(value.length <= 100_000); value.forEach((item) => safeJson(item, depth + 1, integerOnly)); return; }
  assert(object(value));
  for (const [key, item] of Object.entries(value)) {
    assert(!forbiddenKeys.test(key) && !["__proto__", "constructor", "prototype"].includes(key), "unsafe_content");
    safeJson(key, depth + 1, integerOnly);
    safeJson(item, depth + 1, integerOnly);
  }
}

export function copyEvidenceBundle(value: unknown): EvidenceBundle {
  exact(value, bundleKeys);
  assert(value.schema_version === 1 && typeof value.run_id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.run_id));
  assert(text(value.instrument) && Boolean(value.instrument) && value.instrument.length <= 128 && date(value.analysis_date));
  assert(timestamp(value.research_as_of) && timestamp(value.created_at) && value.as_of_policy === "analysis_date_end_utc");
  assert(value.research_as_of === `${value.analysis_date}T23:59:59.999999Z`);
  assert(value.market_timezone === null || text(value.market_timezone));
  assert(hash(value.manifest_sha256) && hash(value.bundle_sha256) && object(value.manifest));
  assert(Object.keys(value.manifest).every((key) => manifestKeys.includes(key)));
  assert(Object.entries(value.manifest).every(([key, val]) => !key.endsWith("_sha256") || hash(val)));
  for (const [key, allowed] of [["data_vendors", ["core_stock_apis", "technical_indicators", "fundamental_data", "news_data"]], ["tool_vendors", tools]] as const) {
    if (value.manifest[key] !== undefined) {
      const vendors = value.manifest[key];
      assert(object(vendors) && Object.entries(vendors).every(([name, val]) => (allowed as readonly string[]).includes(name) && typeof val === "string"));
    }
  }
  safeJson(value.manifest);
  assert(Array.isArray(value.records) && value.records.length <= 4096 && object(value.artifacts) && Object.keys(value.artifacts).length <= 16384 && object(value.citation_audit));
  const ids = new Set<string>();
  const artifactsUsed = new Set<string>();
  for (const record of value.records) {
    exact(record, recordKeys);
    assert(typeof record.id === "string" && idPattern.test(record.id) && !ids.has(record.id)); ids.add(record.id);
    assert(["market", "social", "news", "fundamentals", "identity"].includes(String(record.analyst)) && statuses.includes(String(record.status)));
    assert(text(record.tool) && tools.includes(record.tool) && record.instrument === value.instrument && timestamp(record.fetched_at));
    assert(object(record.parameters) && Object.keys(record.parameters).every((key) => parameters.includes(key))); safeJson(record.parameters);
    assert(hash(record.output_sha256) && value.artifacts[record.output_sha256] !== undefined);
    artifactsUsed.add(record.output_sha256);
    const output = value.artifacts[record.output_sha256];
    exact(output, ["kind", "payload"]);
    assert(output.kind === "tool_text" && typeof output.payload === "string" && output.payload.startsWith(`[E:${record.id}]\n`));
    assert(Array.isArray(record.sources) && record.sources.length <= 1024 && Array.isArray(record.attempts) && record.attempts.length <= 1024);
    for (const source of record.sources) {
      exact(source, sourceKeys);
      assert(providers.includes(String(source.provider)) && ["unknown", "within_as_of", "withheld"].includes(String(source.historical_availability)));
      assert(source.url === null || isPublicSourceUrl(source.url), "unsafe_content");
      if (source.observed_window !== null) {
        exact(source.observed_window, ["start", "end"]);
        assert(date(source.observed_window.start) && date(source.observed_window.end) && source.observed_window.start <= source.observed_window.end);
        assert(source.observed_window.end <= value.analysis_date || (source.historical_availability === "withheld" && record.status === "withheld"));
      }
      assert(source.publication_dates === null || (Array.isArray(source.publication_dates) && source.publication_dates.length <= 10000 && source.publication_dates.every(timestamp)));
      if (Array.isArray(source.publication_dates)) assert(source.publication_dates.every((d) => Date.parse(d) <= Date.parse(value.research_as_of as string)) || (source.historical_availability === "withheld" && record.status === "withheld"));
      assert((source.units === null || text(source.units)) && (source.adjustments === null || text(source.adjustments)) && Array.isArray(source.transformations) && source.transformations.every(text));
      if (source.data_sha256 !== null) {
        assert(hash(source.data_sha256));
        const normalized = value.artifacts[source.data_sha256];
        assert(object(normalized) && normalized.kind === "normalized_data");
        artifactsUsed.add(source.data_sha256);
      }
      safeJson(source);
    }
    for (const attempt of record.attempts) {
      exact(attempt, ["provider", "status", "elapsed_ms"]);
      assert(providers.includes(String(attempt.provider)) && ["available", "empty", "unavailable", "withheld", "not_configured"].includes(String(attempt.status)) && typeof attempt.elapsed_ms === "number" && Number.isSafeInteger(attempt.elapsed_ms) && attempt.elapsed_ms >= 0);
    }
  }
  for (const [key, artifact] of Object.entries(value.artifacts)) {
    assert(hash(key)); exact(artifact, ["kind", "payload"]);
    assert(["tool_text", "normalized_data"].includes(String(artifact.kind)) && text(artifact.payload));
    safeJson(artifact.payload);
    if (artifact.kind === "normalized_data") safeJson(JSON.parse(artifact.payload as string), 0, false);
  }
  for (const [key, audit] of Object.entries(value.citation_audit)) {
    assert(reportKeys.includes(key)); exact(audit, ["referenced_ids", "unresolved_ids", "status"]);
    assert(Array.isArray(audit.referenced_ids) && audit.referenced_ids.every((id) => typeof id === "string" && citationPattern.test(id)) && Array.isArray(audit.unresolved_ids) && audit.unresolved_ids.every((id) => typeof id === "string" && citationPattern.test(id)));
    assert(new Set(audit.referenced_ids).size === audit.referenced_ids.length);
    const missing = audit.referenced_ids.filter((id) => !ids.has(id));
    assert(JSON.stringify(audit.unresolved_ids) === JSON.stringify(missing), "citation_mismatch");
    assert(audit.status === (missing.length ? "unresolved" : audit.referenced_ids.length ? "resolved" : "none"), "citation_mismatch");
  }
  safeJson(value.instrument); safeJson(value.market_timezone);
  assert(artifactsUsed.size === Object.keys(value.artifacts).length);
  assert(new TextEncoder().encode(canonicalJson(value)).length <= 64 * 1024 * 1024);
  return JSON.parse(JSON.stringify(value)) as EvidenceBundle;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
export async function sha256(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new EvidenceError("verification_unavailable");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function verifyEvidenceBundle(value: unknown, reports?: Record<string, string | null>): Promise<EvidenceBundle> {
  const bundle = copyEvidenceBundle(value);
  const { bundle_sha256: bundleHash, ...body } = bundle;
  const checks = await Promise.all([sha256(body), sha256(bundle.manifest), ...Object.values(bundle.artifacts).map(sha256)]);
  assert(checks[0] === bundleHash && checks[1] === bundle.manifest_sha256 && Object.keys(bundle.artifacts).every((key, i) => key === checks[i + 2]), "hash_mismatch");
  if (reports) for (const [key, report] of Object.entries(reports)) {
    const ids = citationReferences(report ?? "").sort();
    const recorded = bundle.citation_audit[key]?.referenced_ids ?? [];
    assert(JSON.stringify(ids) === JSON.stringify([...recorded].sort()), "citation_mismatch");
  }
  return bundle;
}
export function citationReferences(report: string): string[] {
  return [...new Set(report.split("[E:").slice(1).map((tail) => {
    const closing = tail.indexOf("]");
    const token = closing === -1 ? "" : tail.slice(0, closing);
    return citationPattern.test(token) ? token : "invalid-citation";
  }))];
}
export function invalidEvidence(error: unknown): EvidenceValidation {
  return { status: "invalid", reason: error instanceof EvidenceError ? error.reason : "malformed" };
}
function safeSnapshot<T extends { evidenceBundle?: EvidenceBundle; evidenceValidation?: EvidenceValidation }>(snapshot: T): T {
  if (snapshot.evidenceBundle !== undefined && snapshot.evidenceValidation !== undefined) return { ...snapshot, evidenceBundle: undefined, evidenceValidation: { status: "invalid", reason: "malformed" } };
  if (snapshot.evidenceBundle === undefined) {
    if (snapshot.evidenceValidation === undefined) return { ...snapshot, evidenceValidation: undefined };
    const marker = snapshot.evidenceValidation;
    const valid = object(marker) && Object.keys(marker).length === 2 && marker.status === "invalid" && ["malformed", "hash_mismatch", "citation_mismatch", "unsafe_content", "verification_unavailable"].includes(marker.reason);
    return { ...snapshot, evidenceValidation: invalidEvidence(new EvidenceError(valid ? marker.reason : "malformed")) };
  }
  try { return { ...snapshot, evidenceBundle: copyEvidenceBundle(snapshot.evidenceBundle), evidenceValidation: undefined }; }
  catch (error) { return { ...snapshot, evidenceBundle: undefined, evidenceValidation: invalidEvidence(error) }; }
}
export function normalizeTaskEvidence(task: AnalysisTask): AnalysisTask {
  const normalized = evidenceMatchesSnapshot(safeSnapshot(task));
  return { ...normalized, ...(Array.isArray(task.reportVersions) ? { reportVersions: task.reportVersions.map((version) => evidenceMatchesSnapshot(safeSnapshot(version))) } : {}) };
}
export function evidenceMatchesSnapshot<T extends AnalysisTask | ReportVersion>(snapshot: T): T {
  if (!snapshot.evidenceBundle) return snapshot;
  const identity = "task" in snapshot ? (snapshot as ReportVersion).task : snapshot as AnalysisTask;
  const bundle = snapshot.evidenceBundle;
  if (bundle.instrument !== identity?.ticker || bundle.analysis_date !== identity?.analysisDate || ("task" in snapshot && bundle.run_id !== (snapshot as ReportVersion).runId)) {
    return { ...snapshot, evidenceBundle: undefined, evidenceValidation: { status: "invalid", reason: "malformed" } };
  }
  return snapshot;
}
export async function verifyTaskEvidence(task: AnalysisTask): Promise<AnalysisTask> {
  async function verify<T extends AnalysisTask | ReportVersion>(snapshot: T): Promise<T> {
    if (snapshot.evidenceBundle !== undefined && snapshot.evidenceValidation !== undefined) return safeSnapshot(snapshot);
    if (snapshot.evidenceBundle === undefined) return safeSnapshot(snapshot);
    try {
      const reports = !("task" in snapshot) && (snapshot as AnalysisTask).status !== "completed" ? undefined : snapshot.reportSections;
      const bundle = await verifyEvidenceBundle(snapshot.evidenceBundle, reports);
      const identity = "task" in snapshot ? (snapshot as ReportVersion).task : snapshot as AnalysisTask;
      assert(bundle.instrument === identity.ticker && bundle.analysis_date === identity.analysisDate);
      if ("task" in snapshot) assert(bundle.run_id === (snapshot as ReportVersion).runId);
      return { ...snapshot, evidenceBundle: bundle, evidenceValidation: undefined };
    }
    catch (error) { return { ...snapshot, evidenceBundle: undefined, evidenceValidation: invalidEvidence(error) }; }
  }
  return { ...await verify(task), reportVersions: await Promise.all((task.reportVersions ?? []).map(verify)) };
}
export async function evidenceFromEvent(previous: AnalysisTask, event: AnalysisEvent) {
  const candidate = event.evidenceBundle ?? event.finalState?.evidence_bundle;
  if (candidate === undefined) return { evidenceBundle: previous.evidenceBundle, evidenceValidation: previous.evidenceValidation };
  try { return { evidenceBundle: await verifyEvidenceBundle(candidate, event.type === "completed" ? event.reportSections ?? previous.reportSections : undefined), evidenceValidation: undefined }; }
  catch (error) { return { evidenceBundle: undefined, evidenceValidation: invalidEvidence(error) }; }
}
