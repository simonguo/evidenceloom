import { initialStats } from "@/lib/analysis";
import type { AgentStatus, AnalysisEvent, AnalysisTask } from "@/lib/types";
import { detached } from "@/features/desktop-task-store/lib/protocol";
import { prependSeededLog } from "@/components/task-center/utils";
import { resolveTaskDecision } from "@/components/task-center/decisions";
import { appendCompletedReportVersion, hasReportContent } from "@/features/report-export/lib/versioning";
import { evidenceFromEvent, evidenceMatchesSnapshot, normalizeTaskEvidence, sha256, verifyTaskEvidence } from "@/features/evidence/lib/validation";
import { memoryFromEvent, normalizeMemoryTaskFields, verifyTaskMemory } from "@/features/memory/lib/validation";
import { readinessFromEvent, normalizeReadinessTaskFields, verifyTaskReadiness } from "@/features/research-readiness/lib/validation";
import { reportSnapshotFromEvent } from "@/features/numeric-review/lib/snapshot";
import { normalizeNumericTaskFields, verifyNumericTask } from "@/features/numeric-review/lib/tasks";
import { identityFromEvent } from "@/features/source-identity/lib/validation";
import { normalizeIdentityTaskFields, verifyIdentityTask } from "@/features/source-identity/lib/tasks";
import { mergeEventOutputQuality } from "@/features/output-quality/lib/quality";
import type { EventSeed, JournalEnvelope, JournalHeader, PublicationIssue } from "../types";
import { recoveryMessages, requireWire } from "./protocol";

export type RunReduction = Readonly<{ terminalObserved: boolean; criticalFailure: Readonly<{ seq: string; code: "analysis_publication_unavailable" }> | null }>;
export const initialReduction: RunReduction = Object.freeze({ terminalObserved: false, criticalFailure: null });
/** Recover only durable prefix facts; acknowledged task bodies are never reduced again. */
export function journalProgress(rows: readonly JournalEnvelope[], input: RunReduction = initialReduction): RunReduction {
  let progress = detached(input);
  for (const row of rows) {
    if (row.kind !== "analysis" && row.kind !== "publication_unavailable") continue;
    const critical = row.kind === "publication_unavailable" && row.payload.outcome === "analysis_failed";
    const event = row.kind === "analysis" ? row.payload.event : row.payload.safeAnalysis;
    if (critical) progress = { ...progress, criticalFailure: progress.criticalFailure ?? { seq: row.seq, code: "analysis_publication_unavailable" } };
    else if (event?.type === "completed" || event?.type === "error") progress = { ...progress, terminalObserved: true };
  }
  return progress;
}
function finalize(statuses: Record<string, AgentStatus>) { return Object.fromEntries(Object.entries(statuses).map(([key, value]) => [key, value === "in_progress" ? "error" : value])) as Record<string, AgentStatus>; }
function reset(task: AnalysisTask, seed: EventSeed): AnalysisTask {
  return { ...task, status: "running", queuedAt: "", queueOrder: null, updatedAt: seed.updatedAt, decision: "", stats: { ...initialStats }, agentStatuses: {}, reportSections: {}, outputQuality: undefined, evidenceBundle: undefined, evidenceValidation: undefined, memoryBundle: undefined, memoryValidation: undefined, researchReadiness: undefined, readinessValidation: undefined, reportTextSnapshot: undefined, numericValidation: undefined, effectiveRequestIdentity: undefined, identityValidation: undefined, evaluationReviews: [], logs: [], error: "" };
}
function fixedFailure(task: AnalysisTask, seed: EventSeed, code: string): AnalysisTask {
  const message = recoveryMessages[code]; requireWire(message);
  return { ...task, status: "error", updatedAt: seed.updatedAt, error: message, agentStatuses: finalize(task.agentStatuses), logs: prependSeededLog(task.logs, seed.logId, "error", message, seed.logTimestamp) };
}
function overlayIssues(task: AnalysisTask, issues: readonly PublicationIssue[]): AnalysisTask {
  let next = task;
  for (const issue of issues) {
    const reason = issue.reason === "limit_exceeded" ? "verification_unavailable" : issue.reason;
    const channel = issue.channel;
    if (channel === "evidenceBundle" || channel === "finalState.evidence_bundle") next = { ...next, evidenceBundle: undefined, evidenceValidation: { status: "invalid", reason } };
    else if (channel === "memoryBundle" || channel === "finalState.memory_bundle") next = { ...next, memoryBundle: undefined, memoryValidation: { status: "invalid", reason } };
    else if (channel === "researchReadiness" || channel === "finalState.research_readiness") next = { ...next, researchReadiness: undefined, readinessValidation: { status: "invalid", reason } };
    else if (channel === "reportTextSnapshot" || channel === "finalState.report_text_snapshot") next = { ...next, reportTextSnapshot: undefined, numericValidation: { status: "invalid", reason } };
    else if (channel === "effectiveRequestIdentity" || channel === "finalState.effective_request_identity") next = { ...next, effectiveRequestIdentity: undefined, identityValidation: { status: "invalid", reason } };
  }
  return next;
}
async function transform(task: AnalysisTask, event: AnalysisEvent, seed: EventSeed, issues: readonly PublicationIssue[]): Promise<AnalysisTask> {
  const empty = { evidenceBundle: undefined, evidenceValidation: undefined, reportSections: {} } as AnalysisTask;
  let evidence = await evidenceFromEvent(empty, event);
  // Existing evidence helper selects top/nested; the journal wrapper keeps contradiction truth.
  if (event.evidenceBundle !== undefined && event.finalState?.evidence_bundle !== undefined && await sha256(event.evidenceBundle) !== await sha256(event.finalState.evidence_bundle)) evidence = { evidenceBundle: undefined, evidenceValidation: { status: "invalid", reason: "malformed" } };
  const memory = await memoryFromEvent(event, evidence.evidenceBundle);
  const readiness = await readinessFromEvent(event, evidence.evidenceBundle);
  const numeric = await reportSnapshotFromEvent(event, evidence.evidenceBundle);
  const identity = await identityFromEvent(event, evidence.evidenceBundle, numeric?.reportTextSnapshot);
  const reportSections = event.reportSections ?? task.reportSections;
  const status = event.type === "completed" ? "completed" : event.type === "error" ? "error" : task.status;
  const agentStatuses = event.agentStatuses ?? task.agentStatuses;
  const logs = event.message || event.error ? prependSeededLog(task.logs, seed.logId, event.messageType ?? event.type, event.error ?? event.message ?? "", seed.logTimestamp, event.agent) : task.logs;
  let next = normalizeIdentityTaskFields(normalizeNumericTaskFields(normalizeReadinessTaskFields(normalizeMemoryTaskFields(evidenceMatchesSnapshot({
    ...task, status, updatedAt: seed.updatedAt, decision: resolveTaskDecision(task.decision, reportSections.final_trade_decision, event), stats: event.stats ?? task.stats,
    agentStatuses: status === "error" ? finalize(agentStatuses) : agentStatuses, reportSections, outputQuality: mergeEventOutputQuality(task.outputQuality, event),
    ...((event.evidenceBundle !== undefined || event.finalState?.evidence_bundle !== undefined) ? evidence : {}), ...(memory ?? {}), ...(readiness ?? {}), ...(numeric ?? {}), ...(identity ?? {}), logs,
    error: event.error ?? (status === "running" || event.type === "completed" ? "" : task.error),
  })))));
  next = overlayIssues(next, issues);
  if (issues.length) next = { ...next, logs: prependSeededLog(next.logs, seed.logId, "warning", recoveryMessages.analysis_publication_unavailable, seed.logTimestamp, event.agent) };
  return next;
}

/** All causal input is detached synchronously, before research validation awaits. */
export async function reduceJournalPage(input: AnalysisTask, inputHeader: JournalHeader, inputRows: readonly JournalEnvelope[], inputProgress: RunReduction = initialReduction): Promise<{ task: AnalysisTask; progress: RunReduction }> {
  let task = detached(input), progress = detached(inputProgress);
  const header = detached(inputHeader), rows = detached(inputRows);
  for (const row of rows) {
    if (row.kind === "accepted") { task = reset(task, row.seed); continue; }
    if (row.kind === "analysis" || row.kind === "publication_unavailable") {
      const event = row.kind === "analysis" ? row.payload.event : row.payload.safeAnalysis;
      const critical = row.kind === "publication_unavailable" && row.payload.outcome === "analysis_failed";
      if (!critical && (event?.type === "completed" || event?.type === "error")) progress = { ...progress, terminalObserved: true };
      if (event) task = await transform(task, event as AnalysisEvent, row.seed, row.kind === "publication_unavailable" ? row.payload.channels : []);
      if (critical) {
        progress = { ...progress, criticalFailure: progress.criticalFailure ?? { seq: row.seq, code: "analysis_publication_unavailable" } };
        task = fixedFailure(task, row.seed, "analysis_publication_unavailable");
      } else if (progress.criticalFailure) task = fixedFailure(task, row.seed, progress.criticalFailure.code);
      else if (event?.type === "error" && !event.error) task = fixedFailure(task, row.seed, "analysis_worker_failed");
      else if (event?.type === "completed") {
        if (!hasReportContent(task.reportSections)) task = fixedFailure(task, row.seed, "analysis_empty_result");
        else {
          requireWire(row.seed.completionVersionId !== null && row.seed.completionCreatedAt !== null);
          task = appendCompletedReportVersion(task, event as AnalysisEvent, header.context.originalRunContext, row.seed.completionCreatedAt, row.seed.completionVersionId);
        }
      }
    } else if (row.kind === "reader_outcome") {
      if (row.payload.outcome !== "eof") task = fixedFailure(task, row.seed, "analysis_reader_failed");
      else task = { ...task, updatedAt: row.seed.updatedAt };
    } else if (row.kind === "worker_outcome") {
      if (row.payload.code) task = fixedFailure(task, row.seed, row.payload.code);
      else if (progress.criticalFailure) task = fixedFailure(task, row.seed, progress.criticalFailure.code);
      else if (row.payload.outcome === "succeeded" && !progress.terminalObserved) task = fixedFailure(task, row.seed, "analysis_missing_terminal");
      else if (row.payload.outcome === "cancelled" || row.payload.outcome === "not_started") task = { ...task, status: task.status === "error" ? "error" : "stopped", agentStatuses: finalize(task.agentStatuses), updatedAt: row.seed.updatedAt };
      else task = { ...task, updatedAt: row.seed.updatedAt };
    }
  }
  task = await verifyIdentityTask(await verifyNumericTask(await verifyTaskReadiness(await verifyTaskMemory(await verifyTaskEvidence(normalizeTaskEvidence(task))))));
  return detached({ task, progress });
}
