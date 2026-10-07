import { createTranslator } from "@/lib/i18n";
import type { SystemLanguage } from "@/lib/types";
import type { RecoveryPhase } from "../types";

export type AnalysisRefreshOutcome = "interrupted" | "blocked" | "unavailable";
export type NativeAnalysisView = { taskId: string | null; phase: RecoveryPhase; attached: boolean; canRetryCleanup: boolean; refreshing: boolean; refreshOutcome: AnalysisRefreshOutcome | null };

/** Global owner controls remain visible for missing tasks and SQL-normalized status. */
export function NativeAnalysisControls({ view, label, language, onWatch, onStop, onResult, onCleanup }: {
  view: NativeAnalysisView; label?: string; language: SystemLanguage;
  onWatch: () => void; onStop: () => void; onResult: () => void; onCleanup: () => void;
}) {
  const t = createTranslator(language);
  return <aside role="alert" aria-label={t("analysisRecoveryTitle")} className="fixed bottom-5 left-5 z-50 max-w-md rounded-lg border border-amber-800 bg-zinc-950 p-4 text-sm text-amber-100">
    <p className="font-semibold">{label ?? t("analysisRecoveryTitle")}</p>
    <p className="mt-2">{t(view.phase === "stopping" ? "analysisStopping" : view.phase === "cleanup_failed" ? "analysisCleanupUnconfirmed" : view.taskId === null ? "analysisRecoveryUnconfirmed" : "analysisRecoveryBlocked")}</p>
    {(view.refreshing || view.refreshOutcome) && <p role="status" aria-live="polite" className="mt-2">{t(view.refreshing ? "analysisRefreshing" : view.refreshOutcome === "interrupted" ? "analysisRefreshInterrupted" : view.refreshOutcome === "unavailable" ? "analysisRefreshUnavailable" : "analysisRefreshBlocked")}</p>}
    <div className="mt-3 flex flex-wrap gap-2">
      {view.taskId !== null && !view.attached && <button type="button" onClick={onWatch} className="vercel-button">{t("watchExistingAnalysis")}</button>}
      {view.taskId !== null && <button type="button" disabled={view.phase === "stopping"} onClick={onStop} className="vercel-button">{t("stopTask")}</button>}
      <button type="button" disabled={view.refreshing} aria-busy={view.refreshing} onClick={onResult} className="vercel-button">{t(view.refreshing ? "analysisRefreshing" : view.taskId === null ? "refreshAnalysisState" : "retryAnalysisResult")}</button>
      {view.canRetryCleanup && <button type="button" onClick={onCleanup} className="vercel-button">{t("retryAnalysisCleanup")}</button>}
    </div>
  </aside>;
}
