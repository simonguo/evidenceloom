import type { AnalysisTask, GlobalSettings } from "@/lib/types";
import type { RunBinding, RunIdentity } from "@/features/analysis-recovery/types";

export const DRIVER_MARKER = "evidenceloom-private-ui-driver-v1" as const;
export const BOOTSTRAP_KEY = "__EVIDENCELOOM_ACCEPTANCE_BOOTSTRAP__" as const;
export const BUILD_ASSET = "/desktop-acceptance-build.json" as const;
export const STEPS = ["renderer_ready", "settings_saved", "a_started", "b_queued", "a_stopped", "b_saved", "c_started", "d_queued", "realm_reloaded", "b_report_restored", "c_stopped", "d_saved", "complete"] as const;
export const ERRORS = ["bootstrap_mismatch", "dom_unavailable", "ipc_rejected", "identity_mismatch", "report_mismatch", "deadline_exceeded", "control_unavailable", "unexpected_state"] as const;
export type DriverStep = typeof STEPS[number];
export type DriverError = typeof ERRORS[number];
export type TaskSlot = "a" | "b" | "c" | "d";
export type Bootstrap = Readonly<{ schemaVersion: 1; planVersion: 1; sessionId: string; buildId: string; compiledStampSha256: string; target: "x86_64-apple-darwin" | "aarch64-apple-darwin" | "x86_64-pc-windows-msvc"; driverMarker: typeof DRIVER_MARKER }>;
export type TaskAttestation = Readonly<{ slot: TaskSlot; taskId: string; status: "queued" | "running" | "succeeded" | "stopped" | "failed"; reportVersionId: string | null; runId: string | null }>;
export type DriverReport = Readonly<{ schemaVersion: 1; planVersion: 1; sessionId: string; buildId: string; requestId: string; realmNonce: string; driverMarker: typeof DRIVER_MARKER; step: DriverStep; verdict: "pass" | "fail"; errorCode: DriverError | null; route: "tasks" | "settings" | "report"; tasks: readonly TaskAttestation[]; renderedReport: boolean; stopControlVisible: boolean; watchControlVisible: boolean }>;
export type DriverReply = Readonly<{ schemaVersion: 1; sessionId: string; buildId: string; requestId: string; status: "driver_attestation_recorded"; attestationOnly: true }>;
export type FinishRequest = Readonly<{ schemaVersion: 1; planVersion: 1; sessionId: string; buildId: string; requestId: string; realmNonce: string; driverMarker: typeof DRIVER_MARKER; reason: "complete" | "failed" }>;
export type FinishReply = Readonly<{ schemaVersion: 1; sessionId: string; buildId: string; requestId: string; status: "finish_requested"; driverReason: "complete" | "failed"; privateControlsClosed: true; nativeLifecycleHookAttached: boolean; admissionState: "unverified"; cleanupState: "unverified"; nativeExitAuthorized: false }>;
export type WorkerWitness = Readonly<{ origin: RunIdentity; journalId: string; binding: RunBinding; headerDigest: string; releaseNonce: string }>;
export type Checkpoint = "renderer_ready" | "runtime_ready" | "owner_observed" | "projection_saved" | "stop_confirmed" | "run_complete";
export type ControlReply = Readonly<{ schemaVersion: 1; sessionId: string; requestId: string; status: Checkpoint | "worker_released"; worker: WorkerWitness | null; workerStarted: boolean }>;
/** Observation only: these properties expose no provider actions or mutation callbacks. */
export type DriverView = Readonly<{ hydrated: boolean; storageState: string; settings: GlobalSettings; tasks: readonly AnalysisTask[]; nativeAnalysis: Readonly<{ taskId: string | null; attached: boolean; phase: string }> | null }>;
/** A single reload hint contains identities and digests, never settings or report bodies. */
export type ReloadHint = Readonly<{ schemaVersion: 1; sessionId: string; buildId: string; stage: "cd_queued"; firstRealmNonce: string; expiresAt: number; tasks: readonly TaskAttestation[]; bReportDigest: string; bRenderedDigest: string }>;
