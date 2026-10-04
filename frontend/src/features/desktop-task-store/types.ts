import type { AnalysisTask, ReportVersion } from "@/lib/types";

export type CollectionToken = Readonly<{ collectionId: string; epoch: string }>;
export type TaskHead = Readonly<{ taskId: string; generation: string; revision: string; state: "never_seen" | "live" | "tombstone" }>;
type Common = Readonly<{ protocolVersion: 1; requestId: string; collection: CollectionToken }>;
export type TaskMutationRequest = Common & (
  | Readonly<{ operation: "create" | "recreate" | "update"; expectedHead: TaskHead; task: AnalysisTask }>
  | Readonly<{ operation: "delete"; expectedHead: TaskHead }>
  | Readonly<{ operation: "import"; expectedHeads: readonly TaskHead[]; tasks: readonly AnalysisTask[] }>
  | Readonly<{ operation: "clear" }>
);
export type StorageAuthority = Readonly<{ collection: CollectionToken; heads: readonly TaskHead[] }>;
export type SnapshotStorage = StorageAuthority & Readonly<{ legacyTaskImportAllowed: boolean }>;
export type SqlMutationReceipt = Readonly<{ protocolVersion: 1; requestId: string; digest: string;
  operation: TaskMutationRequest["operation"]; collection: CollectionToken; heads: readonly TaskHead[]; sqlCommitted: true }>;
export type StorageError = Readonly<{ code: string; message: string }>;
export type StorageReply = Readonly<{ scope: "sql" | "desktop_clear"; receipt: SqlMutationReceipt | null;
  rejection: StorageError | null; current: StorageAuthority }>;
export type TaskAction = Readonly<{ token: object }>;
export type ReviewAction = TaskAction & Readonly<{ versionId: string; version: ReportVersion }>;
export type RunOwner = Readonly<{ token: object }>;
export type TaskStoreState = "unavailable" | "ready" | "pending" | "unknown" | "conflict";
export type MutationOutcome =
  | Readonly<{ kind: "committed"; reply: StorageReply; publishable: boolean }>
  | Readonly<{ kind: "rejected"; error: StorageError }>
  | Readonly<{ kind: "unknown"; error: StorageError }>;
export type MutationTransport = {
  execute: (request: TaskMutationRequest, beforeInvoke: () => void) => Promise<unknown>;
  query: (request: TaskMutationRequest) => Promise<unknown>;
};
