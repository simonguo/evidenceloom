/** Same-native-runtime attachment wire; no admission or start authority. */
import type { AnalysisTask } from "@/lib/types";
import type { CollectionToken, TaskHead } from "@/features/desktop-task-store/types";
import type {
  Counter, ControlReceipt, JournalHeader, NativeOwner, RecoveryCurrent,
  RecoveryError, RunBinding, RunIdentity,
} from "@/features/analysis-recovery/types";

/** A NEW attachment intent, never a reconstructed original admission request. */
export type AttachRequest = Readonly<{
  recoveryProtocolVersion: 1;
  requestId: string;
  runtimeEpoch: string;
  /** Observed lower bound: <= current; NOT equality CAS. Full exact owner still must match. */
  expectedObservationRevision: Counter;
  origin: RunIdentity;
  journalId: string;
  binding: RunBinding;
  admissionRequestId: string;
  admissionDigest: string;
  expectedHeaderDigest: string | null;
}>;

/** Immutable acknowledgement of an exact native match at attachment admission. */
export type AttachReceipt = Readonly<{
  recoveryProtocolVersion: 1;
  requestId: string;
  digest: string;
  origin: RunIdentity;
  journalId: string;
  binding: RunBinding;
  admissionRequestId: string;
  admissionDigest: string;
  matchedObservationRevision: Counter;
  confirmation: "runtime";
  permission: "same_runtime_watch_project_stop";
  mayStart: false;
}>;

export type ProjectionFailureCode =
  | "analysis_publication_unavailable"
  | "analysis_reader_failed"
  | "analysis_worker_failed"
  | "analysis_start_failed"
  | "analysis_reservation_expired"
  | "analysis_missing_terminal"
  | "analysis_empty_result";

/**
 * Same SQL cut as reply.current's task/head/storage/journal.
 * No task body is replayed from this anchor; the winning canonical task is used.
 * criticalFailure and safeTerminalThroughApplied cover ONLY [1, appliedSeq].
 * safeTerminalThroughApplied is independent of publication-wide terminal_observed.
 * Canonical task/history itself is authoritative; no version identity list is rebuilt.
 */
export type AppliedPrefixAnchor = Readonly<{
  recoveryProtocolVersion: 1;
  origin: RunIdentity;
  journalId: string;
  binding: RunBinding;
  headerDigest: string;
  collection: CollectionToken;
  head: TaskHead;
  appliedSeq: Counter;
  safeTerminalThroughApplied: boolean;
  criticalFailure: Readonly<{
    seq: Counter;
    code: "analysis_publication_unavailable";
  }> | null;
  projectionFailureCode: ProjectionFailureCode | null;
  projectionCompleted: boolean;
}>;

/** Current control truth, never a reconstruction of the previous request packet. */
export type ControlReconciliation =
  | Readonly<{ state: "none"; controlRevision: "0" }>
  | Readonly<{
      state: "pending";
      controlRevision: Counter;
      attempt: Readonly<{ requestId: string; digest: string }> | null;
    }>
  | Readonly<{
      state: "known";
      controlRevision: Counter;
      receipt: ControlReceipt;
    }>
  | Readonly<{
      state: "unavailable";
      controlRevision: Counter | null;
      error: RecoveryError;
    }>;

/** A matched runtime-only witness can be watched/stopped but grants no project authority. */
export type VolatileWitness = Readonly<{
  origin: RunIdentity;
  journalId: string;
  binding: RunBinding;
  admissionRequestId: string;
  admissionDigest: string;
  headerDigest: string | null;
  owner: NativeOwner;
  /** binding_mismatch/body_unavailable can coexist with coherent SQL; exact watch/Stop available, 0project. */
  reason: "header_pending" | "storage_unavailable" | "binding_mismatch" | "body_unavailable";
}>;

/**
 * Current match is separate from historical AttachReceipt.
 * durable.live requires exact current native owner + matching live SQL incarnation.
 * volatile.binding_mismatch/body_unavailable exposes exact watch/Stop even when SQL is coherent;
 * no project or old-body adoption is allowed.
 * durable.retired grants no new project/control effect; it only reconciles a
 * previously acknowledged attachment with the winning canonical result.
 */
export type CurrentAttachment =
  | Readonly<{
      kind: "durable";
      authority: "live" | "retired";
      header: JournalHeader;
      prefix: AppliedPrefixAnchor;
      control: ControlReconciliation;
    }>
  | Readonly<{
      kind: "volatile";
      witness: VolatileWitness;
      control: ControlReconciliation;
    }>;

export type AttachReply = Readonly<{
  recoveryProtocolVersion: 1;
  scope: "analysis_attachment";
  receipt: AttachReceipt | null;
  rejection: RecoveryError | null;
  current: RecoveryCurrent;
  attachment: CurrentAttachment | null;
}>;

/** Candidate new transport surface, not extra fields on existing strict DTOs. */
export type ProposedAttachmentCommands = Readonly<{
  attach_analysis_recovery: Readonly<{
    args: Readonly<{ requestJson: string }>;
    reply: AttachReply;
  }>;
  query_analysis_attachment: Readonly<{
    /** Exact original AttachRequest JSON, not latest owner/current form. */
    args: Readonly<{ requestJson: string }>;
    reply: AttachReply;
  }>;
}>;

/** Local-only projection parent, captured before validation/read transport awaits. */
export type AttachedCanonicalParent = Readonly<{
  task: AnalysisTask;
  collection: CollectionToken;
  head: TaskHead;
  appliedSeq: Counter;
  prefix: AppliedPrefixAnchor;
  /** Native identity is wire data; frontendLifetime is never transmitted. */
  frontendLifetime: object;
}>;
