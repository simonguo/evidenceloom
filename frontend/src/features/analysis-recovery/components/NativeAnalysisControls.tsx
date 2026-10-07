import { createTranslator } from "@/lib/i18n";
import { X } from "lucide-react";
import type { SystemLanguage } from "@/lib/types";
import type { RecoveryPhase } from "../types";

export type AnalysisRefreshOutcome = "interrupted" | "blocked" | "unavailable";
export type NativeAnalysisView = { taskId: string | null; phase: RecoveryPhase; attached: boolean; canRetryCleanup: boolean; refreshing: boolean; refreshOutcome: AnalysisRefreshOutcome | null };
export const NATIVE_ANALYSIS_STATUS_ID = "native-analysis-recovery-status";
export const NATIVE_ANALYSIS_CONTROLS_ID = "native-analysis-recovery-controls";

/** Global owner controls remain visible for missing tasks and SQL-normalized status. */
export function NativeAnalysisControls({ view, label, language, onWatch, onStop, onResult, onCleanup, onDismiss }: {
  view: NativeAnalysisView; label?: string; language: SystemLanguage;
  onWatch: () => void; onStop: () => void; onResult: () => void; onCleanup: () => void; onDismiss: () => void;
}) {
  const t = createTranslator(language);
  const feedback = view.refreshing || view.refreshOutcome;
  const message = feedback
    ? view.refreshing ? "analysisRefreshing" : view.refreshOutcome === "interrupted" ? "analysisRefreshInterrupted" : view.refreshOutcome === "unavailable" ? "analysisRefreshUnavailable" : "analysisRefreshBlocked"
    : view.phase === "stopping" ? "analysisStopping" : view.phase === "cleanup_failed" ? "analysisCleanupUnconfirmed" : view.taskId === null ? "analysisRecoveryUnconfirmed" : "analysisRecoveryBlocked";
  return <aside id={NATIVE_ANALYSIS_CONTROLS_ID} role="alert" aria-label={t("analysisRecoveryTitle")} className="fixed bottom-5 left-5 z-50 max-w-md rounded-lg border border-amber-800 bg-zinc-950 p-4 text-sm text-amber-100">
    <div className="flex items-start justify-between gap-3">
      <p className="font-semibold">{label ?? t("analysisRecoveryTitle")}</p>
      <button type="button" aria-label={t("dismissAnalysisRecovery")} title={t("dismissAnalysisRecovery")} className="inline-flex size-7 shrink-0 items-center justify-center rounded text-amber-200 transition hover:bg-amber-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300" onClick={() => { onDismiss(); document.getElementById(NATIVE_ANALYSIS_STATUS_ID)?.focus(); }}><X className="size-4" aria-hidden="true" /></button>
    </div>
    <p role={feedback ? "status" : undefined} aria-live={feedback ? "polite" : undefined} className="mt-2">{t(message)}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {view.taskId !== null && !view.attached && <button type="button" onClick={onWatch} className="vercel-button">{t("watchExistingAnalysis")}</button>}
      {view.taskId !== null && <button type="button" disabled={view.phase === "stopping"} onClick={onStop} className="vercel-button">{t("stopTask")}</button>}
      <button type="button" disabled={view.refreshing} aria-busy={view.refreshing} onClick={onResult} className="vercel-button">{t(view.refreshing ? "analysisRefreshing" : view.taskId === null ? "refreshAnalysisState" : "retryAnalysisResult")}</button>
      {view.canRetryCleanup && <button type="button" onClick={onCleanup} className="vercel-button">{t("retryAnalysisCleanup")}</button>}
    </div>
  </aside>;
}
