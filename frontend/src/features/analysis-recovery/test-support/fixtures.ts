import { buildRunForm, createEmptyTask, defaultGlobalSettings } from "@/lib/analysis";
import { createRunContext } from "@/features/report-export/lib/versioning";
import { captureAdmission } from "../lib/consumer";
import type { JournalEnvelope, JournalHeader, JournalSummary, RuntimeObservation } from "../types";

/** Fictional shape fixtures; these digests are not native serializer/canonical proof. */
export const stamp = "2026-01-01T00:00:00.000Z";
export const collection = { collectionId: "a".repeat(64), epoch: "0" };
export const task = () => createEmptyTask({ ticker: "FICT", instrumentName: "Fictional instrument", analysisDate: "2025-01-01", assetType: "stock", researchDepth: 1, analysts: ["market"], outputLanguage: "English" }, "owned-task", stamp);
export const head = { taskId: "owned-task", generation: "1", revision: "1", state: "live" as const };
export const origin = { runtimeEpoch: "b".repeat(64), taskId: head.taskId, runId: "analysis-0" };
export const binding = { collection, taskId: head.taskId, generation: "1" };
export function captured(id = "owned-task") { const t = { ...task(), id }, form = buildRunForm(t, defaultGlobalSettings()); return captureAdmission(t, form, createRunContext(form, "owned-fallback-run"), collection, { ...head, taskId: id }, origin.runtimeEpoch); }
export function header(): JournalHeader {
  const c = captured();
  return { recoveryProtocolVersion: 1, journalId: "c".repeat(64), origin, binding, reservedHead: head, admissionRequestId: c.packet.request.requestId, admissionDigest: "d".repeat(64), headerDigest: "e".repeat(64), acceptedAt: stamp, context: c.packet.request.context };
}
export function envelope(h: JournalHeader, seq: number, kind: JournalEnvelope["kind"], payload: JournalEnvelope["payload"]): JournalEnvelope {
  const event = kind === "analysis" && "event" in payload ? payload.event : kind === "publication_unavailable" && "safeAnalysis" in payload && payload.outcome === "optional_unavailable" ? payload.safeAnalysis : undefined;
  const unavailable = kind === "publication_unavailable" && "sourceType" in payload && (payload.sourceType === null || payload.channels.some((c) => c.channel === "timestamp"));
  const completed = event?.type === "completed";
  return { recoveryProtocolVersion: 1, journalId: h.journalId, origin: h.origin, binding: h.binding, seq: String(seq), kind, observedAt: stamp, payload, seed: { updatedAt: stamp, logId: `log:${h.journalId}:${seq}`, logTimestamp: unavailable ? "[unavailable]" : event?.timestamp === undefined ? stamp : event.timestamp, completionVersionId: completed ? `report:${h.journalId}:${seq}` : null, completionCreatedAt: completed ? stamp : null }, payloadDigest: "f".repeat(64) } as JournalEnvelope;
}
export function runtime(ready = true): RuntimeObservation { return { recoveryProtocolVersion: 1, initialization: "ready", runtimeEpoch: origin.runtimeEpoch, observationRevision: "1", owner: null, runtimeGate: ready ? "vacant" : "unknown", journalGate: ready ? "ready" : "unknown", blockers: [] }; }
export function summary(h: JournalHeader, latest = "1", applied = "0"): JournalSummary { return { journalId: h.journalId, origin: h.origin, binding: h.binding, bodyState: "available", latestSeq: latest, appliedSeq: applied, sealedThroughSeq: null, controlRevision: "0", workerOutcome: null, cleanupState: "pending", resultState: "unsealed", historyState: "current" }; }
