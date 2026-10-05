import type { AppliedPrefixAnchor, AttachReply, AttachRequest, ControlReconciliation } from "../attachment-types";
import type { AnalysisTask, ReportTaskSnapshot, RunContext } from "@/lib/types";
import { detached, readSnapshotStorage, sameCollection, sameHead } from "@/features/desktop-task-store/lib/protocol";
import type { CollectionToken, StorageAuthority, TaskHead } from "@/features/desktop-task-store/types";
import { requestedSettingKeys } from "../types";
import type { AdmissionReply, AdmissionRequest, EventSeed, FrozenPacket, JournalEnvelope, JournalHeader, JournalSummary, MatchedReservation, NativeOwner, OutcomeReply, ProjectionRequest, PublishedAnalysisEvent, ReadReply, ReadRequest, Receipt, RecoveryCurrent, RecoveryError, RecoverySnapshot, RunBinding, RunIdentity, RuntimeObservation, SafeRunContext, Scope, StartRequest, StopRequest, UnavailablePayload, WakeNotice } from "../types";

const MAX = BigInt("9223372036854775807");
const UTF8 = new TextEncoder();
const MB = 1024 * 1024;
export const recoveryMessages: Record<string, string> = Object.fromEntries([
  "invalid_request", "identity_unavailable", "busy", "stale_origin", "conflict", "request_conflict", "admission_unknown", "start_unknown", "cleanup_incomplete", "projection_unknown", "storage_unavailable", "journal_gap", "journal_corrupt", "publication_unavailable", "limit_exceeded", "counter_exhausted", "interrupted", "partial_clear", "observation_changed", "reader_failed", "worker_failed", "start_failed", "reservation_expired", "missing_terminal",
].map((name) => [`analysis_${name}`, `Analysis ${name.replaceAll("_", " ")}.`]));
recoveryMessages.analysis_empty_result = "Analysis completed without report content.";
recoveryMessages.analysis_journal_body_unavailable = "Analysis journal body unavailable.";
const eventTypes = ["started", "progress", "message", "report", "stats", "completed", "error"];
const eventKeys = ["type", "timestamp", "message", "messageType", "agentStatuses", "reportSections", "stats", "decision", "finalState", "runSettings", "outputQuality", "evidenceBundle", "memoryBundle", "error", "researchReadiness", "reportTextSnapshot", "effectiveRequestIdentity", "agent"];
const finalKeys = ["final_rating", "output_quality", "evidence_bundle", "memory_bundle", "research_readiness", "report_text_snapshot", "effective_request_identity"];
const runtimeKeys = ["version", "core_version", "upstream_revision", "trade_date", "asset_type", "llm_provider", "quick_think_llm", "deep_think_llm", "analysts", "output_language", "holding_period_days", "benchmark_ticker", "max_debate_rounds", "max_risk_discuss_rounds", "max_tool_rounds", "research_readiness_policy_sha256", "analyst_concurrency_limit", "temperature", "max_tokens", "data_vendors", "tool_vendors"];
const channels = [...eventKeys.filter((key) => key !== "type" && key !== "finalState"), "event", ...finalKeys.map((key) => `finalState.${key}`)];
export class RecoveryProtocolError extends Error { constructor() { super("Analysis acknowledgement could not be verified."); this.name = "RecoveryProtocolError"; } }
export function requireWire(condition: unknown): asserts condition { if (!condition) throw new RecoveryProtocolError(); }
function object(value: unknown): Record<string, unknown> { requireWire(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]) { requireWire(Object.keys(value).sort().join("|") === [...keys].sort().join("|")); }
function optional(value: Record<string, unknown>, required: string[], allowed: readonly string[]) { requireWire(required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.includes(key))); }
function text(value: unknown, max = 4096, empty = false): string { requireWire(typeof value === "string" && (empty || value.length > 0) && UTF8.encode(value).length <= max); return value; }
function hash(value: unknown): string { const result = text(value, 64); requireWire(/^[a-f0-9]{64}$/.test(result)); return result; }
function enumValue(value: unknown, choices: readonly string[]): string { requireWire(typeof value === "string" && choices.includes(value)); return value; }
function version(value: Record<string, unknown>) { requireWire(value.recoveryProtocolVersion === 1); }
function utc(value: unknown): string { const result = text(value, 24); requireWire(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) && Number.isFinite(Date.parse(result)) && new Date(result).toISOString() === result); return result; }
function requestId(value: unknown): string { const result = text(value, 128); requireWire(/^[A-Za-z0-9:_-]+$/.test(result)); return result; }
function array(value: unknown): unknown[] { requireWire(Array.isArray(value)); return value; }
export function counter(value: unknown): string { const result = text(value, 19); requireWire(/^(0|[1-9][0-9]*)$/.test(result) && BigInt(result) <= MAX); return result; }
function positive(value: unknown) { const result = counter(value); requireWire(result !== "0"); return result; }
export function sameOrigin(a: RunIdentity, b: RunIdentity) { return a.runtimeEpoch === b.runtimeEpoch && a.taskId === b.taskId && a.runId === b.runId; }
export function sameBinding(a: RunBinding, b: RunBinding) { return sameCollection(a.collection, b.collection) && a.taskId === b.taskId && a.generation === b.generation; }
export function readOrigin(value: unknown): RunIdentity {
  const o = object(value); exact(o, ["runtimeEpoch", "taskId", "runId"]); hash(o.runtimeEpoch); text(o.taskId, 1024); const id = text(o.runId, 32);
  requireWire(/^analysis-(0|[1-9][0-9]*)$/.test(id) && BigInt(id.slice(9)) <= BigInt("18446744073709551615")); return detached(o) as RunIdentity;
}
export function readCollection(value: unknown): CollectionToken { const o = object(value); exact(o, ["collectionId", "epoch"]); hash(o.collectionId); counter(o.epoch); return detached(o) as CollectionToken; }
export function readHead(value: unknown, persisted = true): TaskHead {
  const o = object(value); exact(o, ["taskId", "generation", "revision", "state"]); text(o.taskId, 1024); counter(o.generation); counter(o.revision); enumValue(o.state, ["never_seen", "live", "tombstone"]);
  requireWire(o.state === "never_seen" ? !persisted && o.generation === "0" && o.revision === "0" : o.generation !== "0" && o.revision !== "0"); return detached(o) as TaskHead;
}
export function readBinding(value: unknown): RunBinding { const o = object(value); exact(o, ["collection", "taskId", "generation"]); readCollection(o.collection); text(o.taskId, 1024); positive(o.generation); return detached(o) as RunBinding; }
function identity(value: { origin: RunIdentity; binding: RunBinding }) { requireWire(value.origin.taskId === value.binding.taskId); }
function readAuthority(value: unknown): StorageAuthority {
  const o = object(value); exact(o, ["collection", "heads"]); readCollection(o.collection); const heads = array(o.heads).map((row) => readHead(row)); requireWire(new Set(heads.map((head) => head.taskId)).size === heads.length); return detached(o) as StorageAuthority;
}
function jsonTree(value: unknown, depth = 0) {
  requireWire(depth <= 64);
  if (typeof value === "number") requireWire(Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER);
  else if (Array.isArray(value)) value.forEach((entry) => jsonTree(entry, depth + 1));
  else if (value !== null && typeof value === "object") Object.entries(value).forEach(([key, entry]) => { text(key, 4096, true); jsonTree(entry, depth + 1); });
  else requireWire(value === null || typeof value === "string" || typeof value === "boolean");
}
function bounded(value: unknown, limit = 256 * MB) { jsonTree(value); requireWire(UTF8.encode(JSON.stringify(value)).length <= limit); }
function statuses(value: unknown) { Object.entries(object(value)).forEach(([key, status]) => { text(key); enumValue(status, ["pending", "in_progress", "completed", "error"]); }); }
function sections(value: unknown) { Object.entries(object(value)).forEach(([key, content]) => { text(key); if (content !== null) text(content, 8 * MB, true); }); }
function stats(value: unknown) { const o = object(value); exact(o, ["llmCalls", "toolCalls", "tokensIn", "tokensOut", "elapsedSeconds"]); Object.values(o).forEach((n) => requireWire(typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER)); }
function integer(value: unknown) { requireWire(Number.isSafeInteger(value) && Number(value) >= 0); }
function stringMap(value: unknown) { Object.entries(object(value)).forEach(([key, content]) => { text(key, 4096, true); text(content, 4096, true); }); }
function runtimeSettings(value: unknown) {
  const settings = object(value); optional(settings, [], runtimeKeys);
  for (const [key, entry] of Object.entries(settings)) {
    if (key === "data_vendors" || key === "tool_vendors") stringMap(entry);
    else if (key === "analysts") array(entry).forEach((analyst) => text(analyst, 4096, true));
    else if (["holding_period_days", "max_debate_rounds", "max_risk_discuss_rounds", "max_tool_rounds", "analyst_concurrency_limit", "max_tokens"].includes(key)) integer(entry);
    else if (key === "temperature") requireWire(entry === null || typeof entry === "string" || typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= Number.MAX_SAFE_INTEGER);
    else text(entry, 4096, true);
  }
}
function outputQuality(value: unknown) {
  const quality = object(value); optional(quality, [], ["research_manager", "trader", "portfolio_manager", "sentiment"]);
  Object.values(quality).forEach((entry) => { const status = object(entry); optional(status, ["schema", "status", "source"], ["schema", "status", "source", "reason"]); text(status.schema, 4096, true); if (status.status === "validated_schema") requireWire(status.source === "structured" && !Object.hasOwn(status, "reason")); else { requireWire(status.status === "unvalidated_text"); enumValue(status.source, ["raw_response", "plain_generation"]); enumValue(status.reason, ["structured_unavailable", "no_tool_call", "schema_validation_failed", "unsupported_format"]); } });
}
function taskSnapshot(value: unknown): ReportTaskSnapshot {
  const o = object(value); exact(o, ["ticker", "instrumentName", "analysisDate", "assetType", "researchDepth", "analysts", "outputLanguage"]); [o.ticker, o.instrumentName, o.analysisDate, o.outputLanguage].forEach((v) => text(v, 4096, true)); enumValue(o.assetType, ["stock", "crypto"]); requireWire(Number.isSafeInteger(o.researchDepth) && Number(o.researchDepth) > 0); const analysts = array(o.analysts); requireWire(analysts.length > 0 && analysts.length <= 4 && new Set(analysts).size === analysts.length); analysts.forEach((v) => enumValue(v, ["market", "social", "news", "fundamentals"])); return detached(o) as ReportTaskSnapshot;
}
export function readTask(value: unknown): AnalysisTask {
  const o = object(value); optional(o, ["id", "origin", "ticker", "instrumentName", "analysisDate", "assetType", "researchDepth", "analysts", "outputLanguage", "status", "queuedAt", "queueOrder", "createdAt", "updatedAt", "decision", "stats", "agentStatuses", "reportSections", "evaluationReviews", "reportVersions", "logs", "error"], ["id", "origin", "ticker", "instrumentName", "analysisDate", "assetType", "researchDepth", "analysts", "outputLanguage", "status", "queuedAt", "queueOrder", "createdAt", "updatedAt", "decision", "stats", "agentStatuses", "reportSections", "evaluationReviews", "reportVersions", "logs", "error", "outputQuality", "evidenceBundle", "evidenceValidation", "memoryBundle", "memoryValidation", "researchReadiness", "readinessValidation", "reportTextSnapshot", "numericValidation", "effectiveRequestIdentity", "identityValidation"]);
  text(o.id, 1024); taskSnapshot(Object.fromEntries(["ticker", "instrumentName", "analysisDate", "assetType", "researchDepth", "analysts", "outputLanguage"].map((key) => [key, o[key]]))); enumValue(o.origin, ["analysis", "demo"]); enumValue(o.status, ["idle", "queued", "running", "completed", "error", "stopped"]);
  [o.queuedAt, o.createdAt, o.updatedAt, o.error].forEach((v) => text(v, 8 * MB, true)); text(o.decision, 8 * MB, true); requireWire(o.queueOrder === null || Number.isSafeInteger(o.queueOrder)); stats(o.stats); statuses(o.agentStatuses); sections(o.reportSections); array(o.evaluationReviews); array(o.reportVersions); array(o.logs).forEach((v) => { const log = object(v); optional(log, ["id", "type", "message", "timestamp"], ["id", "type", "message", "timestamp", "agent"]); text(log.id, 256); text(log.type, 4096, true); text(log.message, 8 * MB, true); text(log.timestamp, 256, true); if (log.agent !== undefined) text(log.agent, 4096, true); }); bounded(o); return detached(o) as AnalysisTask;
}
function readContext(value: unknown): SafeRunContext {
  const o = object(value); exact(o, ["originalTaskSnapshot", "input", "requestedSettings", "originalRunContext"]); taskSnapshot(o.originalTaskSnapshot);
  const input = object(o.input); exact(input, ["ticker", "analysisDate", "assetType", "researchDepth", "analysts", "outputLanguage"]); taskSnapshot({ ...input, instrumentName: "" });
  const s = object(o.requestedSettings); exact(s, [...requestedSettingKeys]); const numeric = ["newsArticleLimit", "globalNewsArticleLimit", "globalNewsLookbackDays", "maxDebateRounds", "maxRiskRounds", "analystConcurrencyLimit"];
  for (const key of requestedSettingKeys) { if (numeric.includes(key)) requireWire(Number.isSafeInteger(s[key]) && Number(s[key]) >= (key === "maxDebateRounds" || key === "maxRiskRounds" ? 0 : 1)); else if (key === "checkpointEnabled") requireWire(typeof s[key] === "boolean"); else if (key === "systemLanguage") enumValue(s[key], ["zh", "en"]); else text(s[key], 4096, true); }
  const run = object(o.originalRunContext); exact(run, ["runId", "manifest"]); text(run.runId, 4096); const manifest = object(run.manifest); optional(manifest, ["appVersion", "llmProvider", "quickThinkLlm", "deepThinkLlm", "coreStockApis", "technicalIndicators", "fundamentalData", "newsData", "maxDebateRounds", "maxRiskRounds", "benchmarkTicker"], ["appVersion", "coreVersion", "toolVendors", "runtimeRunSettings", "llmProvider", "quickThinkLlm", "deepThinkLlm", "coreStockApis", "technicalIndicators", "fundamentalData", "newsData", "maxDebateRounds", "maxRiskRounds", "benchmarkTicker", "holdingPeriodDays"]);
  Object.entries(manifest).forEach(([key, value]) => { if (["maxDebateRounds", "maxRiskRounds", "holdingPeriodDays"].includes(key)) integer(value); else if (key === "toolVendors") stringMap(value); else if (key === "runtimeRunSettings") runtimeSettings(value); else text(value, 4096, true); }); bounded(o, 65536); return detached(o) as SafeRunContext;
}
export function readEvent(value: unknown): PublishedAnalysisEvent {
  const o = object(value); optional(o, ["type"], eventKeys); enumValue(o.type, eventTypes);
  for (const key of ["timestamp", "message", "messageType", "decision", "agent", "error"]) if (Object.hasOwn(o, key)) text(o[key], key === "timestamp" ? 256 : key === "message" || key === "decision" ? 8 * MB : 4096, true);
  if (Object.hasOwn(o, "error")) requireWire(o.error === recoveryMessages.analysis_worker_failed);
  if (o.reportSections !== undefined) sections(o.reportSections); if (o.agentStatuses !== undefined) statuses(o.agentStatuses); if (o.stats !== undefined) stats(o.stats);
  if (o.runSettings !== undefined) runtimeSettings(o.runSettings); if (o.outputQuality !== undefined) outputQuality(o.outputQuality);
  if (o.finalState !== undefined) { const state = object(o.finalState); optional(state, [], finalKeys); if (state.final_rating !== undefined) text(state.final_rating, 8 * MB, true); if (state.output_quality !== undefined) outputQuality(state.output_quality); } bounded(o, 240 * MB); return detached(o) as PublishedAnalysisEvent;
}
export function readRecoveryError(value: unknown): RecoveryError { const o = object(value); exact(o, ["code", "message"]); requireWire(typeof o.code === "string" && Object.hasOwn(recoveryMessages, o.code) && o.message === recoveryMessages[o.code]); return detached(o) as RecoveryError; }
export function readRuntime(value: unknown): RuntimeObservation {
  const o = object(value); exact(o, ["recoveryProtocolVersion", "initialization", "runtimeEpoch", "observationRevision", "owner", "runtimeGate", "journalGate", "blockers"]); version(o); enumValue(o.initialization, ["initializing", "ready", "unavailable"]); if (o.runtimeEpoch !== null) hash(o.runtimeEpoch); requireWire(o.initialization !== "ready" || o.runtimeEpoch !== null); counter(o.observationRevision); enumValue(o.runtimeGate, ["vacant", "occupied", "unknown"]); enumValue(o.journalGate, ["checking", "ready", "blocked", "unknown"]);
  if (o.owner !== null) { const owner = object(o.owner); exact(owner, ["origin", "admissionRequestId", "admissionDigest", "journalId", "binding", "phase", "controlRevision", "cleanupState"]); const origin = readOrigin(owner.origin), binding = readBinding(owner.binding); identity({ origin, binding }); requireWire(origin.runtimeEpoch === o.runtimeEpoch); requestId(owner.admissionRequestId); hash(owner.admissionDigest); hash(owner.journalId); counter(owner.controlRevision); enumValue(owner.phase, ["checking", "reserved", "preparing", "running", "cleaning", "cleanup_failed", "result_pending"]); enumValue(owner.cleanupState, ["pending", "confirmed", "failed", "unknown"]); }
  array(o.blockers).forEach((v) => { const b = object(v); exact(b, ["code", "origin", "journalId"]); requireWire(typeof b.code === "string" && Object.hasOwn(recoveryMessages, b.code)); if (b.origin !== null) readOrigin(b.origin); if (b.journalId !== null) hash(b.journalId); }); return detached(o) as RuntimeObservation;
}
export function readSummary(value: unknown): JournalSummary {
  const o = object(value); exact(o, ["journalId", "origin", "binding", "bodyState", "latestSeq", "appliedSeq", "sealedThroughSeq", "controlRevision", "workerOutcome", "cleanupState", "resultState", "historyState"]); hash(o.journalId); const origin = readOrigin(o.origin), binding = readBinding(o.binding); identity({ origin, binding }); counter(o.latestSeq); counter(o.appliedSeq); counter(o.controlRevision); requireWire(BigInt(String(o.appliedSeq)) <= BigInt(String(o.latestSeq))); if (o.sealedThroughSeq !== null) requireWire(positive(o.sealedThroughSeq) === o.latestSeq); enumValue(o.bodyState, ["available", "purged", "unavailable"]); if (o.workerOutcome !== null) enumValue(o.workerOutcome, ["succeeded", "failed", "cancelled", "not_started"]); enumValue(o.cleanupState, ["pending", "confirmed", "failed", "unknown"]); enumValue(o.resultState, ["unsealed", "pending", "projected", "failed_projection", "unknown", "discarded"]); enumValue(o.historyState, ["current", "historical", "interrupted", "discarded"]); return detached(o) as JournalSummary;
}
export function readHeader(value: unknown): JournalHeader {
  const o = object(value); exact(o, ["recoveryProtocolVersion", "journalId", "origin", "binding", "reservedHead", "admissionRequestId", "admissionDigest", "headerDigest", "acceptedAt", "context"]); version(o); hash(o.journalId); const origin = readOrigin(o.origin), binding = readBinding(o.binding), head = readHead(o.reservedHead); identity({ origin, binding }); requireWire(head.state === "live" && head.taskId === binding.taskId && head.generation === binding.generation); requestId(o.admissionRequestId); hash(o.admissionDigest); hash(o.headerDigest); utc(o.acceptedAt); readContext(o.context); return detached(o) as JournalHeader;
}
export function readCurrent(value: unknown): RecoveryCurrent {
  const o = object(value);
  if (o.state === "unavailable") { exact(o, ["state", "error", "runtime"]); const error = readRecoveryError(o.error); requireWire(["analysis_storage_unavailable", "analysis_observation_changed", "analysis_limit_exceeded"].includes(error.code)); readRuntime(o.runtime); }
  else { requireWire(o.state === "coherent"); exact(o, ["state", "storage", "task", "head", "journal", "runtime"]); const storage = readAuthority(o.storage); const head = o.head === null ? null : readHead(o.head); const task = o.task === null ? null : readTask(o.task); if (head) requireWire(storage.heads.some((h) => sameHead(h, head))); requireWire(task ? !!head && head.state === "live" && head.taskId === task.id : !head || head.state !== "live"); if (o.journal !== null) readSummary(o.journal); readRuntime(o.runtime); }
  return detached(o) as RecoveryCurrent;
}
export function readSnapshot(value: unknown): RecoverySnapshot {
  const o = object(value); exact(o, ["recoveryProtocolVersion", "storage", "tasks", "journals", "clearBlockers", "runtime", "coherent"]); version(o); requireWire(o.coherent === true); const storage = readSnapshotStorage(o.storage); readCollection(storage.collection); const tasks = array(o.tasks).map(readTask); requireWire(new Set(tasks.map((t) => t.id)).size === tasks.length && tasks.every((t) => storage.heads.some((h) => h.taskId === t.id && h.state === "live")) && storage.heads.filter((h) => h.state === "live").length === tasks.length); array(o.journals).forEach(readSummary); array(o.clearBlockers).forEach((v) => { const b = object(v); exact(b, ["requestId", "digest", "collection", "status", "code"]); requestId(b.requestId); hash(b.digest); readCollection(b.collection); enumValue(b.status, ["pending", "partial"]); requireWire(b.code === "analysis_partial_clear" || b.code === "storage_partial_clear" || b.code === "storage_unknown_outcome"); }); readRuntime(o.runtime); bounded(o); return detached(o) as RecoverySnapshot;
}
function readSeed(value: unknown, seq: string, journalId: string, observedAt: string, completed: boolean): EventSeed {
  const o = object(value); exact(o, ["updatedAt", "logId", "logTimestamp", "completionVersionId", "completionCreatedAt"]); requireWire(o.updatedAt === observedAt && o.logId === `log:${journalId}:${seq}`); text(o.logTimestamp, 256, true); requireWire(completed ? o.completionVersionId === `report:${journalId}:${seq}` && o.completionCreatedAt === observedAt : o.completionVersionId === null && o.completionCreatedAt === null); return detached(o) as EventSeed;
}
export function readEnvelope(value: unknown): JournalEnvelope {
  const o = object(value); exact(o, ["recoveryProtocolVersion", "journalId", "origin", "binding", "seq", "kind", "observedAt", "payload", "seed", "payloadDigest"]); version(o); const journalId = hash(o.journalId), seq = positive(o.seq), observedAt = utc(o.observedAt); identity({ origin: readOrigin(o.origin), binding: readBinding(o.binding) }); hash(o.payloadDigest); const p = object(o.payload); let completed = false;
  switch (o.kind) {
    case "accepted": exact(p, ["resetVersion"]); requireWire(p.resetVersion === 1 && seq === "1"); break;
    case "analysis": exact(p, ["event"]); completed = readEvent(p.event).type === "completed"; break;
    case "publication_unavailable": {
      exact(p, ["sourceType", "channels", "outcome", "code", "safeAnalysis"]); if (p.sourceType !== null) enumValue(p.sourceType, eventTypes); enumValue(p.outcome, ["analysis_failed", "optional_unavailable"]); requireWire(p.code === "analysis_publication_unavailable"); const issues = array(p.channels); requireWire(issues.length > 0); const names = issues.map((v) => { const issue = object(v); exact(issue, ["channel", "reason"]); enumValue(issue.channel, channels); enumValue(issue.reason, ["unsafe_content", "verification_unavailable", "malformed", "limit_exceeded"]); return String(issue.channel); }); requireWire(new Set(names).size === names.length && names.join("|") === [...names].sort().join("|")); const critical = names.some((name) => ["event", "reportSections", "decision", "stats", "finalState.final_rating"].includes(name)); requireWire(p.outcome === (critical ? "analysis_failed" : "optional_unavailable") && (p.sourceType !== null || names.includes("event"))); if (p.safeAnalysis !== null) { const event = readEvent(p.safeAnalysis); requireWire(event.type === p.sourceType); completed = p.outcome === "optional_unavailable" && event.type === "completed"; } requireWire(p.outcome !== "optional_unavailable" || p.safeAnalysis !== null); break;
    }
    case "reader_outcome": exact(p, ["stream", "outcome", "code"]); enumValue(p.stream, ["stdout", "stderr"]); enumValue(p.outcome, ["eof", "read_failed", "panicked"]); requireWire(p.code === (p.outcome === "eof" ? null : "analysis_reader_failed")); break;
    case "worker_outcome": { exact(p, ["outcome", "code"]); const matrix: Record<string, readonly unknown[]> = { succeeded: [null, "analysis_missing_terminal"], failed: ["analysis_worker_failed", "analysis_start_failed"], cancelled: [null], not_started: [null, "analysis_start_failed", "analysis_reservation_expired"] }; requireWire(typeof p.outcome === "string" && matrix[p.outcome]?.includes(p.code)); break; }
    default: requireWire(false);
  }
  const seed = readSeed(o.seed, seq, journalId, observedAt, completed);
  const event = o.kind === "analysis" ? readEvent(p.event) : o.kind === "publication_unavailable" && p.safeAnalysis !== null ? readEvent(p.safeAnalysis) : undefined;
  const unavailableTime = o.kind === "publication_unavailable" && (p.sourceType === null || (p.channels as { channel: string }[]).some((issue) => issue.channel === "timestamp"));
  requireWire(seed.logTimestamp === (unavailableTime ? "[unavailable]" : event && Object.hasOwn(event, "timestamp") ? event.timestamp : observedAt));
  bounded(o, 240 * MB); return detached(o) as JournalEnvelope;
}
export function readPage(value: unknown, request: ReadRequest): ReadReply {
  const o = object(value); exact(o, ["recoveryProtocolVersion", "header", "summary", "afterSeq", "throughSeq", "lastSeq", "hasMore", "rows", "rangeProof"]); version(o); const header = readHeader(o.header), summary = readSummary(o.summary); requireWire(header.journalId === request.journalId && summary.journalId === request.journalId && sameOrigin(header.origin, request.origin) && sameOrigin(summary.origin, request.origin) && sameBinding(header.binding, request.binding) && sameBinding(summary.binding, request.binding)); counter(o.afterSeq); counter(o.throughSeq); counter(o.lastSeq); requireWire(o.afterSeq === request.afterSeq && (request.throughSeq === null || o.throughSeq === request.throughSeq) && BigInt(String(o.throughSeq)) <= BigInt(summary.latestSeq)); const rows = array(o.rows).map(readEnvelope); requireWire(rows.length <= request.limit && rows.every((row, index) => row.seq === String(BigInt(request.afterSeq) + BigInt(index + 1)) && row.journalId === request.journalId && sameOrigin(row.origin, request.origin) && sameBinding(row.binding, request.binding)));
  requireWire(o.lastSeq === (rows.at(-1)?.seq ?? request.afterSeq) && BigInt(String(o.lastSeq)) <= BigInt(String(o.throughSeq)) && o.hasMore === (BigInt(String(o.lastSeq)) < BigInt(String(o.throughSeq))));
  if (!rows.length) requireWire(o.rangeProof === null && o.afterSeq === o.throughSeq && o.hasMore === false);
  else { const proof = object(o.rangeProof); exact(proof, ["fromSeq", "throughSeq", "digest"]); requireWire(proof.fromSeq === request.afterSeq && proof.throughSeq === o.lastSeq); hash(proof.digest); }
  bounded(o); return detached(o) as ReadReply;
}
export function readOutcome(value: unknown, scope: Scope, request: AdmissionRequest | StartRequest | StopRequest | ProjectionRequest, query = false): OutcomeReply | AdmissionReply {
  const o = object(value); exact(o, ["recoveryProtocolVersion", "scope", "receipt", "rejection", "current", ...(scope === "analysis_admission" ? ["matchedReservation"] : [])]); version(o); requireWire(o.scope === scope && !(o.receipt !== null && o.rejection !== null)); if (o.rejection !== null) readRecoveryError(o.rejection); requireWire(query || o.receipt !== null || o.rejection !== null); readCurrent(o.current);
  if (o.receipt !== null) { const r = object(o.receipt); const specific = scope === "analysis_admission" ? ["headerDigest", "acceptedSeq"] : scope === "analysis_start" ? ["accepted"] : scope === "analysis_control" ? ["controlRevision", "outcome"] : ["fromSeq", "throughSeq", "rangeDigest", "head"]; exact(r, ["recoveryProtocolVersion", "requestId", "digest", "origin", "journalId", ...(scope !== "analysis_control" ? ["binding"] : []), "sqlCommitted", ...specific]); version(r); requireWire(r.requestId === request.requestId && r.sqlCommitted === true); hash(r.digest); hash(r.journalId); const origin = readOrigin(r.origin); if ("origin" in request) requireWire(sameOrigin(origin, request.origin) && r.journalId === request.journalId);
    if (scope !== "analysis_control") { const binding = readBinding(r.binding); identity({ origin, binding }); if ("binding" in request) requireWire(sameBinding(binding, request.binding)); else { const admission = request as AdmissionRequest; requireWire(sameCollection(binding.collection, admission.collection) && binding.taskId === admission.expectedHead.taskId && binding.generation === admission.expectedHead.generation && origin.runtimeEpoch === admission.runtimeEpoch); } }
    if (scope === "analysis_admission") { hash(r.headerDigest); requireWire(r.acceptedSeq === "1"); }
    else if (scope === "analysis_start") requireWire(r.accepted === true);
    else if (scope === "analysis_control") { counter(r.controlRevision); enumValue(r.outcome, ["cleanup_confirmed", "cleanup_incomplete"]); }
    else { const p = request as ProjectionRequest; requireWire(r.fromSeq === p.expectedAppliedSeq && r.throughSeq === p.throughSeq && r.rangeDigest === p.rangeDigest); const head = readHead(r.head); requireWire(head.taskId === p.expectedHead.taskId && head.generation === p.expectedHead.generation && head.state === "live" && BigInt(head.revision) === BigInt(p.expectedHead.revision) + BigInt(1)); }
  }
  if (scope === "analysis_admission" && o.matchedReservation !== null) { const m = object(o.matchedReservation); exact(m, ["requestId", "digest", "origin", "journalId", "binding", "headerDigest"]); const a = request as AdmissionRequest, origin = readOrigin(m.origin), binding = readBinding(m.binding); requireWire(m.requestId === a.requestId && origin.runtimeEpoch === a.runtimeEpoch && origin.taskId === a.expectedHead.taskId && binding.taskId === a.expectedHead.taskId && binding.generation === a.expectedHead.generation && sameCollection(binding.collection, a.collection)); hash(m.digest); hash(m.journalId); if (m.headerDigest !== null) hash(m.headerDigest); }
  bounded(o); return detached(o) as OutcomeReply | AdmissionReply;
}
export function readWake(value: unknown): WakeNotice { const o = object(value); exact(o, ["recoveryProtocolVersion", "journalId", "origin", "latestSeq", "controlRevision"]); version(o); hash(o.journalId); readOrigin(o.origin); counter(o.latestSeq); counter(o.controlRevision); return detached(o) as WakeNotice; }
export function freezePacket<T extends AdmissionRequest | StartRequest | StopRequest | ReadRequest | ProjectionRequest | AttachRequest | { recoveryProtocolVersion: 1 }>(request: T): FrozenPacket<T> {
  const o = object(request); version(o); const isProjection = Object.hasOwn(o, "projection"); bounded(o, isProjection ? 256 * MB : 65536); if (o.requestId !== undefined) requestId(o.requestId);
  if (Object.hasOwn(o, "expectedObservationRevision")) readAttachRequest(o);
  else if (o.context !== undefined) { exact(o, ["recoveryProtocolVersion", "requestId", "runtimeEpoch", "collection", "expectedHead", "context"]); hash(o.runtimeEpoch); readCollection(o.collection); requireWire(readHead(o.expectedHead).state === "live"); readContext(o.context); }
  else if (o.origin !== undefined) {
    readOrigin(o.origin); hash(o.journalId); if (o.binding !== undefined) identity({ origin: readOrigin(o.origin), binding: readBinding(o.binding) });
    if (isProjection) {
      exact(o, ["recoveryProtocolVersion", "requestId", "journalId", "origin", "binding", "expectedHead", "expectedAppliedSeq", "throughSeq", "rangeDigest", "projection"]);
      const head = readHead(o.expectedHead), binding = readBinding(o.binding); requireWire(head.state === "live" && head.taskId === binding.taskId && head.generation === binding.generation && BigInt(counter(o.throughSeq)) > BigInt(counter(o.expectedAppliedSeq))); hash(o.rangeDigest); const projection = object(o.projection); exact(projection, ["task"]); requireWire(readTask(projection.task).id === binding.taskId);
    } else if (Object.hasOwn(o, "mode")) {
      exact(o, ["recoveryProtocolVersion", "requestId", "origin", "journalId", "mode", "expectedControlRevision"]); requireWire(o.mode === "stop" ? o.expectedControlRevision === null : o.mode === "retry_cleanup" && typeof o.expectedControlRevision === "string"); if (o.expectedControlRevision !== null) counter(o.expectedControlRevision);
    } else if (Object.hasOwn(o, "afterSeq")) {
      exact(o, ["recoveryProtocolVersion", "journalId", "origin", "binding", "afterSeq", "throughSeq", "limit"]); const after = counter(o.afterSeq); requireWire(o.throughSeq === null || BigInt(counter(o.throughSeq)) >= BigInt(after)); requireWire(Number.isSafeInteger(o.limit) && Number(o.limit) >= 1 && Number(o.limit) <= 64);
    } else { exact(o, ["recoveryProtocolVersion", "requestId", "origin", "journalId", "binding", "headerDigest"]); hash(o.headerDigest); }
  } else exact(o, ["recoveryProtocolVersion"]);
  const captured = detached(request); return Object.freeze({ request: captured, requestJson: JSON.stringify(captured) });
}
export function exactRun(owner: NativeOwner | null, origin: RunIdentity, journalId: string): boolean { return !!owner && owner.journalId === journalId && sameOrigin(owner.origin, origin); }
export function gateReady(runtime: RuntimeObservation) { return runtime.initialization === "ready" && runtime.runtimeGate === "vacant" && runtime.journalGate === "ready" && runtime.owner === null && runtime.blockers.length === 0; }
export function finished(summary: JournalSummary) { return summary.sealedThroughSeq !== null && summary.appliedSeq === summary.sealedThroughSeq && summary.cleanupState === "confirmed" && summary.resultState === "projected"; }
export type { Receipt, MatchedReservation, UnavailablePayload, RunContext };

export function readAttachRequest(value: unknown): AttachRequest {
  const o = object(value); exact(o, ["recoveryProtocolVersion", "requestId", "runtimeEpoch", "expectedObservationRevision", "origin", "journalId", "binding", "admissionRequestId", "admissionDigest", "expectedHeaderDigest"]);
  version(o); requestId(o.requestId); hash(o.runtimeEpoch); counter(o.expectedObservationRevision);
  const origin = readOrigin(o.origin), binding = readBinding(o.binding); identity({ origin, binding });
  requireWire(origin.runtimeEpoch === o.runtimeEpoch); hash(o.journalId); requestId(o.admissionRequestId); hash(o.admissionDigest);
  if (o.expectedHeaderDigest !== null) hash(o.expectedHeaderDigest); bounded(o, 65536);
  return detached(o) as AttachRequest;
}
function readControlView(value: unknown, origin: RunIdentity, journalId: string): ControlReconciliation {
  const o = object(value);
  if (o.state === "none") { exact(o, ["state", "controlRevision"]); requireWire(o.controlRevision === "0"); }
  else if (o.state === "pending") { exact(o, ["state", "controlRevision", "attempt"]); counter(o.controlRevision); if (o.attempt !== null) { const a = object(o.attempt); exact(a, ["requestId", "digest"]); requestId(a.requestId); hash(a.digest); } }
  else if (o.state === "known") {
    exact(o, ["state", "controlRevision", "receipt"]); counter(o.controlRevision); const r = object(o.receipt);
    exact(r, ["recoveryProtocolVersion", "requestId", "digest", "origin", "journalId", "controlRevision", "outcome", "sqlCommitted"]);
    version(r); requestId(r.requestId); hash(r.digest); requireWire(sameOrigin(readOrigin(r.origin), origin) && r.journalId === journalId && r.controlRevision === o.controlRevision && r.sqlCommitted === true);
    enumValue(r.outcome, ["cleanup_confirmed", "cleanup_incomplete"]);
  } else { requireWire(o.state === "unavailable"); exact(o, ["state", "controlRevision", "error"]); if (o.controlRevision !== null) counter(o.controlRevision); readRecoveryError(o.error); }
  return detached(o) as ControlReconciliation;
}
function readPrefix(value: unknown, current: RecoveryCurrent, header: JournalHeader): AppliedPrefixAnchor {
  const o = object(value); exact(o, ["recoveryProtocolVersion", "origin", "journalId", "binding", "headerDigest", "collection", "head", "appliedSeq", "safeTerminalThroughApplied", "criticalFailure", "projectionFailureCode", "projectionCompleted"]);
  version(o); requireWire(current.state === "coherent" && current.task !== null && current.head !== null && current.journal !== null);
  const head = readHead(o.head), binding = readBinding(o.binding), origin = readOrigin(o.origin);
  requireWire(sameOrigin(origin, header.origin) && sameBinding(binding, header.binding) && o.journalId === header.journalId && o.headerDigest === header.headerDigest);
  requireWire(sameCollection(readCollection(o.collection), current.storage.collection) && sameCollection(current.storage.collection, binding.collection) && sameHead(head, current.head) && head.state === "live" && head.generation === binding.generation);
  requireWire(counter(o.appliedSeq) === current.journal.appliedSeq && current.journal.bodyState === "available" && sameOrigin(current.journal.origin, origin) && sameBinding(current.journal.binding, binding) && current.journal.journalId === o.journalId);
  requireWire(typeof o.safeTerminalThroughApplied === "boolean" && typeof o.projectionCompleted === "boolean");
  if (o.criticalFailure !== null) { const c = object(o.criticalFailure); exact(c, ["seq", "code"]); requireWire(BigInt(positive(c.seq)) <= BigInt(String(o.appliedSeq)) && c.code === "analysis_publication_unavailable"); }
  if (o.projectionFailureCode !== null) enumValue(o.projectionFailureCode, ["analysis_publication_unavailable", "analysis_reader_failed", "analysis_worker_failed", "analysis_start_failed", "analysis_reservation_expired", "analysis_missing_terminal", "analysis_empty_result"]);
  requireWire(o.appliedSeq !== "0" || o.safeTerminalThroughApplied === false && o.criticalFailure === null && o.projectionFailureCode === null && o.projectionCompleted === false);
  return detached(o) as AppliedPrefixAnchor;
}
export function readAttachmentReply(value: unknown, request: AttachRequest, query = false): AttachReply {
  readAttachRequest(request); const o = object(value);
  exact(o, ["recoveryProtocolVersion", "scope", "receipt", "rejection", "current", "attachment"]); version(o);
  requireWire(o.scope === "analysis_attachment" && !(o.receipt !== null && o.rejection !== null) && (query || o.receipt !== null || o.rejection !== null));
  if (o.rejection !== null) readRecoveryError(o.rejection); const current = readCurrent(o.current);
  const match = (origin: RunIdentity, journalId: unknown, binding: RunBinding) => requireWire(sameOrigin(origin, request.origin) && journalId === request.journalId && sameBinding(binding, request.binding));
  if (o.receipt !== null) {
    const r = object(o.receipt); exact(r, ["recoveryProtocolVersion", "requestId", "digest", "origin", "journalId", "binding", "admissionRequestId", "admissionDigest", "matchedObservationRevision", "confirmation", "permission", "mayStart"]);
    version(r); hash(r.digest); requireWire(r.requestId === request.requestId && r.admissionRequestId === request.admissionRequestId && r.admissionDigest === request.admissionDigest);
    match(readOrigin(r.origin), r.journalId, readBinding(r.binding)); requireWire(BigInt(counter(r.matchedObservationRevision)) >= BigInt(request.expectedObservationRevision));
    requireWire(current.runtime.runtimeEpoch === request.runtimeEpoch && BigInt(String(r.matchedObservationRevision)) <= BigInt(current.runtime.observationRevision));
    requireWire(r.confirmation === "runtime" && r.permission === "same_runtime_watch_project_stop" && r.mayStart === false);
  }
  if (o.attachment !== null) {
    requireWire(o.receipt !== null); const a = object(o.attachment);
    if (a.kind === "durable") {
      exact(a, ["kind", "authority", "header", "prefix", "control"]); enumValue(a.authority, ["live", "retired"]);
      const header = readHeader(a.header); match(header.origin, header.journalId, header.binding);
      requireWire(header.admissionRequestId === request.admissionRequestId && header.admissionDigest === request.admissionDigest && (request.expectedHeaderDigest === null || header.headerDigest === request.expectedHeaderDigest));
      readPrefix(a.prefix, current, header); const control = readControlView(a.control, header.origin, header.journalId);
      if (control.state === "known") requireWire(current.state === "coherent" && control.controlRevision === current.journal?.controlRevision);
      if (a.authority === "live") requireWire(exactRun(current.runtime.owner, header.origin, header.journalId) && current.runtime.owner?.admissionRequestId === request.admissionRequestId && current.runtime.owner.admissionDigest === request.admissionDigest && sameBinding(current.runtime.owner.binding, header.binding));
      else requireWire(current.runtime.owner === null);
    } else {
      requireWire(a.kind === "volatile"); exact(a, ["kind", "witness", "control"]); const w = object(a.witness);
      exact(w, ["origin", "journalId", "binding", "admissionRequestId", "admissionDigest", "headerDigest", "owner", "reason"]);
      match(readOrigin(w.origin), w.journalId, readBinding(w.binding)); requireWire(w.admissionRequestId === request.admissionRequestId && w.admissionDigest === request.admissionDigest);
      if (w.headerDigest !== null) hash(w.headerDigest); enumValue(w.reason, ["header_pending", "storage_unavailable", "binding_mismatch", "body_unavailable"]);
      const owner = object(w.owner); exact(owner, ["origin", "admissionRequestId", "admissionDigest", "journalId", "binding", "phase", "controlRevision", "cleanupState"]);
      requireWire(exactRun(current.runtime.owner, request.origin, request.journalId) && sameOrigin(readOrigin(owner.origin), request.origin) && sameBinding(readBinding(owner.binding), request.binding));
      requireWire(["admissionRequestId", "admissionDigest", "journalId", "phase", "controlRevision", "cleanupState"].every((key) => owner[key] === object(current.runtime.owner)[key]));
      requireWire(current.runtime.owner?.admissionRequestId === request.admissionRequestId && current.runtime.owner.admissionDigest === request.admissionDigest && sameBinding(current.runtime.owner.binding, request.binding));
      if (request.expectedHeaderDigest !== null && w.headerDigest !== null) requireWire(w.headerDigest === request.expectedHeaderDigest);
      const control = readControlView(a.control, request.origin, request.journalId);
      if (control.state === "known" && current.state === "coherent" && current.journal && current.journal.journalId === request.journalId && sameOrigin(current.journal.origin, request.origin)) requireWire(control.controlRevision === current.journal.controlRevision);
    }
  }
  bounded(o); return detached(o) as AttachReply;
}
