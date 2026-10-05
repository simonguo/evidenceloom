import { createTranslator } from "./i18n";
import type { AnalysisEvent, AnalysisForm, SystemLanguage } from "./types";
import type { SameSessionConsumer } from "@/features/analysis-recovery/lib/consumer";
import { RecoveryPendingError } from "@/features/analysis-recovery/lib/transport";
import { requireWire } from "@/features/analysis-recovery/lib/protocol";

export class AnalysisCleanupError extends Error {
  constructor(language: SystemLanguage, cause: unknown) { super(createTranslator(language)("analysisCleanupFailed"), { cause }); this.name = "AnalysisCleanupError"; }
}
export function isAnalysisCleanupError(error: unknown): boolean {
  return error instanceof AnalysisCleanupError || error instanceof RecoveryPendingError && error.kind === "cleanup"
    || typeof error === "object" && error !== null && "code" in error && error.code === "analysis_cleanup_incomplete";
}
const sessions = new Map<string, SameSessionConsumer>();

/** Tokenless desktop callers cannot recover native/storage identity from a task ID. */
export async function runDesktopAnalysis(_api: unknown, _taskId: string, _payload: AnalysisForm, _onEvent: (event: AnalysisEvent) => void, _signal?: AbortSignal): Promise<void> {
  throw new RecoveryPendingError("admission");
}
export async function runPreparedDesktopAnalysis(session: SameSessionConsumer, taskId: string, signal?: AbortSignal, retry = false): Promise<void> {
  requireWire(session.captured.task.id === taskId);
  const existing = sessions.get(taskId);
  if (existing && existing !== session) throw new RecoveryPendingError("admission");
  sessions.set(taskId, session);
  let stop: Promise<void> | undefined;
  const abort = () => { stop ??= session.stop(); void stop.catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try { await session.run(retry); }
  finally {
    signal?.removeEventListener("abort", abort);
    // Only actual native result+cleanup confirmation, never promise completion, retires.
    if (session.phase === "ready" && sessions.get(taskId) === session) sessions.delete(taskId);
  }
}
export async function stopDesktopAnalysis(taskId: string): Promise<void> {
  const session = sessions.get(taskId); // Capture exact original identity before any await.
  if (!session) throw new RecoveryPendingError("admission");
  await session.stop(session.phase === "cleanup_failed");
}
