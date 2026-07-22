"use client";

import { useEffect, useState } from "react";
import { Gauge, Loader2 } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import type { RuntimeCheck } from "@/lib/runtime";
import { useTaskCenter } from "@/components/task-center/context";
import { Panel } from "@/components/task-center/components/Panel";
import { StatusPillLike } from "@/components/task-center/components/StatusPillLike";
import { KeyValue } from "@/components/task-center/components/KeyValue";
import { CheckCard } from "@/components/task-center/components/CheckCard";
import { LogCard } from "@/components/task-center/components/LogCard";
import { runtimeLabel } from "@/components/task-center/utils";

export default function Page() {
  const { runtimeInfo, settings, checkRuntime, saveSettings } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  const [pythonPath, setPythonPath] = useState(settings.pythonPath);
  const [projectRoot, setProjectRoot] = useState(settings.projectRoot);
  const [result, setResult] = useState<RuntimeCheck | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => setPythonPath(settings.pythonPath), [settings.pythonPath]);
  useEffect(() => setProjectRoot(settings.projectRoot), [settings.projectRoot]);

  async function runCheck() {
    const nextSettings = { ...settings, pythonPath, projectRoot };
    await saveSettings(nextSettings);
    setChecking(true);
    try {
      setResult(await checkRuntime(nextSettings));
    } catch (error) {
      const message = error instanceof Error ? error.message : t("diagnosticsFailed");
      setResult({
        kind: runtimeInfo.kind,
        ok: false,
        pythonExists: false,
        runnerExists: false,
        canImportTradingAgents: false,
        errors: [message],
      });
    } finally {
      setChecking(false);
    }
  }

  const effectiveResult = result;
  const runnerMode = effectiveResult?.runnerMode ?? runtimeInfo.runnerMode ?? "python";
  const isSidecarMode = runnerMode === "sidecar";

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-zinc-900 bg-black p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-white">{t("desktopDiagnostics")}</h2>
            <p className="mt-2 text-sm text-zinc-500">{t("diagnosticsHint")}</p>
          </div>
          <StatusPillLike ok={effectiveResult?.ok} />
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-[1fr_1fr_auto]">
          <label className="field-label">{t("projectRoot")}
            <input className="field-input" value={projectRoot} onChange={(event) => setProjectRoot(event.target.value)} placeholder={runtimeInfo.repoRoot || t("projectRootPlaceholder")} />
          </label>
          <label className="field-label">{t("pythonExecutable")}
            <input className="field-input" value={pythonPath} onChange={(event) => setPythonPath(event.target.value)} placeholder={runtimeInfo.pythonPath || t("pythonPathPlaceholder")} />
          </label>
          <button type="button" onClick={runCheck} disabled={checking} className="vercel-button self-end disabled:cursor-not-allowed disabled:opacity-50">
            {checking ? <Loader2 className="size-4 animate-spin" /> : <Gauge className="size-4" />} {t("runCheck")}
          </button>
        </div>
        <p className="mt-3 text-xs text-zinc-600">{t("diagnosticsPathHint")}</p>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Panel title={t("runtime")}>
          <div className="space-y-3">
            <KeyValue label={t("mode")} value={runtimeLabel(runtimeInfo, settings.systemLanguage)} />
            <KeyValue label={t("repoRoot")} value={effectiveResult?.repoRoot ?? runtimeInfo.repoRoot ?? "--"} />
            <KeyValue label={t("configuredProjectRoot")} value={effectiveResult?.configuredProjectRoot ?? runtimeInfo.configuredProjectRoot ?? settings.projectRoot ?? "--"} />
            <KeyValue label={t("python")} value={effectiveResult?.pythonPath ?? runtimeInfo.pythonPath ?? "--"} />
            <KeyValue label={t("runner")} value={effectiveResult?.runnerPath ?? runtimeInfo.runnerPath ?? "--"} />
            <KeyValue label={t("runnerMode")} value={effectiveResult?.runnerMode ?? runtimeInfo.runnerMode ?? "python"} />
            <KeyValue label={t("sidecar")} value={effectiveResult?.sidecarPath ?? runtimeInfo.sidecarPath ?? "--"} />
          </div>
        </Panel>
        <Panel title={t("checks")}>
          <div className="grid gap-3 sm:grid-cols-2">
            {!isSidecarMode && <CheckCard label={t("pythonExecutableCheck")} ok={effectiveResult?.pythonExists} />}
            {!isSidecarMode && <CheckCard label={t("runnerScript")} ok={effectiveResult?.runnerExists} />}
            {!isSidecarMode && <CheckCard label={t("importTradingAgents")} ok={effectiveResult?.canImportTradingAgents} />}
            <CheckCard label={t("sidecarConfigured")} ok={isSidecarMode ? effectiveResult?.sidecarReal : Boolean(effectiveResult?.sidecarPath ?? runtimeInfo.sidecarPath)} />
            <CheckCard label={t("overall")} ok={effectiveResult?.ok} />
          </div>
        </Panel>
      </section>

      <Panel title={t("details")}>
        {!effectiveResult ? (
          <p className="text-sm text-zinc-500">{t("diagnosticsIdle")}</p>
        ) : (
          <div className="space-y-4">
            <KeyValue label={t("pythonVersion")} value={effectiveResult.pythonVersion ?? "--"} />
            {effectiveResult.importError && <LogCard log={{ id: "import-error", type: t("importError"), message: effectiveResult.importError, timestamp: "diagnostics" }} />}
            {effectiveResult.errors.length > 0 ? (
              <div className="rounded-lg border border-rose-300/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                {effectiveResult.errors.map((error) => <div key={error}>{error}</div>)}
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-300/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">{t("diagnosticsHealthy")}</div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
