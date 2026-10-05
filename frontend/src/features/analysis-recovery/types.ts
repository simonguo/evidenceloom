import type { AnalysisEvent, AnalysisForm, AnalysisTask, GlobalSettings, ReportTaskSnapshot, RunContext } from "@/lib/types";
import type { CollectionToken, SnapshotStorage, StorageAuthority, TaskHead } from "@/features/desktop-task-store/types";

export type Counter = string;
export type RunIdentity = Readonly<{ runtimeEpoch: string; taskId: string; runId: string }>;
export type RunBinding = Readonly<{ collection: CollectionToken; taskId: string; generation: Counter }>;
export type RecoveryError = Readonly<{ code: string; message: string }>;
export const requestedSettingKeys = ["llmProvider", "quickThinkLlm", "deepThinkLlm", "temperature", "openaiReasoningEffort", "googleThinkingLevel", "anthropicEffort", "coreStockApis", "technicalIndicators", "fundamentalData", "newsData", "newsArticleLimit", "globalNewsArticleLimit", "globalNewsLookbackDays", "maxDebateRounds", "maxRiskRounds", "analystConcurrencyLimit", "benchmarkTicker", "checkpointEnabled", "systemLanguage"] as const;
export type RequestedSettings = Readonly<Pick<GlobalSettings, typeof requestedSettingKeys[number]>>;
export type SafeRunContext = Readonly<{ originalTaskSnapshot: ReportTaskSnapshot; input: Pick<AnalysisForm, "ticker" | "analysisDate" | "assetType" | "researchDepth" | "analysts" | "outputLanguage">; requestedSettings: RequestedSettings; originalRunContext: RunContext }>;
type Packet = Readonly<{ recoveryProtocolVersion: 1; requestId: string }>;
export type AdmissionRequest = Packet & Readonly<{ runtimeEpoch: string; collection: CollectionToken; expectedHead: TaskHead; context: SafeRunContext }>;
export type JournalHeader = Readonly<{ recoveryProtocolVersion: 1; journalId: string; origin: RunIdentity; binding: RunBinding; reservedHead: TaskHead; admissionRequestId: string; admissionDigest: string; headerDigest: string; acceptedAt: string; context: SafeRunContext }>;
export type StartRequest = Packet & Readonly<{ origin: RunIdentity; journalId: string; binding: RunBinding; headerDigest: string }>;
export type StopRequest = Packet & Readonly<{ origin: RunIdentity; journalId: string; mode: "stop" | "retry_cleanup"; expectedControlRevision: Counter | null }>;
export type AdmissionReceipt = Packet & Readonly<{ digest: string; origin: RunIdentity; journalId: string; binding: RunBinding; headerDigest: string; acceptedSeq: "1"; sqlCommitted: true }>;
export type StartReceipt = Packet & Readonly<{ digest: string; origin: RunIdentity; journalId: string; binding: RunBinding; accepted: true; sqlCommitted: true }>;
export type ControlReceipt = Packet & Readonly<{ digest: string; origin: RunIdentity; journalId: string; controlRevision: Counter; outcome: "cleanup_confirmed" | "cleanup_incomplete"; sqlCommitted: true }>;
export type EventSeed = Readonly<{ updatedAt: string; logId: string; logTimestamp: string; completionVersionId: string | null; completionCreatedAt: string | null }>;
export type PublicationIssue = Readonly<{ channel: string; reason: "unsafe_content" | "verification_unavailable" | "malformed" | "limit_exceeded" }>;
// The recovery wrapper uses the frozen event values; unsafe fields have explicit side markers.
export type PublishedAnalysisEvent = AnalysisEvent;
export type UnavailablePayload = Readonly<{ sourceType: AnalysisEvent["type"] | null; channels: readonly PublicationIssue[]; outcome: "analysis_failed" | "optional_unavailable"; code: "analysis_publication_unavailable"; safeAnalysis: PublishedAnalysisEvent | null }>;
export type WorkerOutcome = "succeeded" | "failed" | "cancelled" | "not_started";
type EnvelopeCommon = Readonly<{ recoveryProtocolVersion: 1; journalId: string; origin: RunIdentity; binding: RunBinding; seq: Counter; observedAt: string; seed: EventSeed; payloadDigest: string }>;
export type JournalEnvelope = EnvelopeCommon & (
  | Readonly<{ kind: "accepted"; payload: { resetVersion: 1 } }>
  | Readonly<{ kind: "analysis"; payload: { event: PublishedAnalysisEvent } }>
  | Readonly<{ kind: "publication_unavailable"; payload: UnavailablePayload }>
  | Readonly<{ kind: "reader_outcome"; payload: { stream: "stdout" | "stderr"; outcome: "eof" | "read_failed" | "panicked"; code: "analysis_reader_failed" | null } }>
  | Readonly<{ kind: "worker_outcome"; payload: { outcome: WorkerOutcome; code: "analysis_worker_failed" | "analysis_start_failed" | "analysis_reservation_expired" | "analysis_missing_terminal" | null } }>
);
export type JournalSummary = Readonly<{ journalId: string; origin: RunIdentity; binding: RunBinding; bodyState: "available" | "purged" | "unavailable"; latestSeq: Counter; appliedSeq: Counter; sealedThroughSeq: Counter | null; controlRevision: Counter; workerOutcome: WorkerOutcome | null; cleanupState: "pending" | "confirmed" | "failed" | "unknown"; resultState: "unsealed" | "pending" | "projected" | "failed_projection" | "unknown" | "discarded"; historyState: "current" | "historical" | "interrupted" | "discarded" }>;
export type NativeOwner = Readonly<{ origin: RunIdentity; admissionRequestId: string; admissionDigest: string; journalId: string; binding: RunBinding; phase: "checking" | "reserved" | "preparing" | "running" | "cleaning" | "cleanup_failed" | "result_pending"; controlRevision: Counter; cleanupState: JournalSummary["cleanupState"] }>;
export type RuntimeObservation = Readonly<{ recoveryProtocolVersion: 1; initialization: "initializing" | "ready" | "unavailable"; runtimeEpoch: string | null; observationRevision: Counter; owner: NativeOwner | null; runtimeGate: "vacant" | "occupied" | "unknown"; journalGate: "checking" | "ready" | "blocked" | "unknown"; blockers: readonly { code: string; origin: RunIdentity | null; journalId: string | null }[] }>;
export type RecoveryCurrent = Readonly<{ state: "coherent"; storage: StorageAuthority; task: AnalysisTask | null; head: TaskHead | null; journal: JournalSummary | null; runtime: RuntimeObservation }> | Readonly<{ state: "unavailable"; error: RecoveryError; runtime: RuntimeObservation }>;
export type RecoverySnapshot = Readonly<{ recoveryProtocolVersion: 1; storage: SnapshotStorage; tasks: readonly AnalysisTask[]; journals: readonly JournalSummary[]; clearBlockers: readonly { requestId: string; digest: string; collection: CollectionToken; status: "pending" | "partial"; code: string }[]; runtime: RuntimeObservation; coherent: true }>;
export type ReadRequest = Readonly<{ recoveryProtocolVersion: 1; journalId: string; origin: RunIdentity; binding: RunBinding; afterSeq: Counter; throughSeq: Counter | null; limit: number }>;
export type ReadReply = Readonly<{ recoveryProtocolVersion: 1; header: JournalHeader; summary: JournalSummary; afterSeq: Counter; throughSeq: Counter; lastSeq: Counter; hasMore: boolean; rows: readonly JournalEnvelope[]; rangeProof: { fromSeq: Counter; throughSeq: Counter; digest: string } | null }>;
export type ProjectionRequest = Packet & Readonly<{ journalId: string; origin: RunIdentity; binding: RunBinding; expectedHead: TaskHead; expectedAppliedSeq: Counter; throughSeq: Counter; rangeDigest: string; projection: { task: AnalysisTask } }>;
export type ProjectionReceipt = Packet & Readonly<{ digest: string; journalId: string; origin: RunIdentity; binding: RunBinding; fromSeq: Counter; throughSeq: Counter; rangeDigest: string; head: TaskHead; sqlCommitted: true }>;
export type MatchedReservation = Readonly<{ requestId: string; digest: string; origin: RunIdentity; journalId: string; binding: RunBinding; headerDigest: string | null }>;
export type Receipt = AdmissionReceipt | StartReceipt | ControlReceipt | ProjectionReceipt;
export type Scope = "analysis_admission" | "analysis_start" | "analysis_control" | "analysis_projection_sql";
export type OutcomeReply<T extends Receipt = Receipt> = Readonly<{ recoveryProtocolVersion: 1; scope: Scope; receipt: T | null; rejection: RecoveryError | null; current: RecoveryCurrent }>;
export type AdmissionReply = OutcomeReply<AdmissionReceipt> & Readonly<{ matchedReservation: MatchedReservation | null }>;
export type WakeNotice = Readonly<{ recoveryProtocolVersion: 1; journalId: string; origin: RunIdentity; latestSeq: Counter; controlRevision: Counter }>;
export type RecoveryApi = { invoke: (command: string, args: { requestJson: string; executionInputJson?: string }) => Promise<unknown>; listen: (channel: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> };
export type FrozenPacket<T> = Readonly<{ request: T; requestJson: string }>;
export type RecoveryPhase = "checking" | "ready" | "reserving" | "running" | "stopping" | "cleanup_failed" | "result_pending" | "unknown";
