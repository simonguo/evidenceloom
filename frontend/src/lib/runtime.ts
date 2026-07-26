import { streamAnalysis } from "./analysis";
import { errorMessage } from "./errors";
import { createTranslator } from "./i18n";
import { stripSecretFields } from "@/features/persistence/local-storage";
import type { AnalysisEvent, AnalysisForm, AnalysisTask, GlobalSettings, OhlcvBar, ResolvedInstrument, SystemLanguage } from "./types";

export type RuntimeKind = "web" | "tauri";

export type RuntimeInfo = {
  kind: RuntimeKind;
  label: string;
  repoRoot?: string;
  configuredProjectRoot?: string;
  pythonPath?: string;
  runnerPath?: string;
  sidecarPath?: string;
  runnerMode?: string;
};

export type RuntimeCheck = {
  kind: RuntimeKind;
  ok: boolean;
  repoRoot?: string;
  configuredProjectRoot?: string;
  pythonPath?: string;
  runnerPath?: string;
  sidecarPath?: string;
  runnerMode?: string;
  pythonExists: boolean;
  runnerExists: boolean;
  pythonVersion?: string;
  canImportTradingAgents: boolean;
  importError?: string;
  sidecarReal?: boolean;
  errors: string[];
};

export type LlmConnectionCheck = {
  ok: boolean;
  provider?: string;
  model?: string;
  latencyMs?: number;
  message?: string;
  error?: string;
};

export type TextExportRequest = {
  suggestedName: string;
  format: "html" | "md";
  content: string;
};

export type TextExportResult = {
  status: "saved" | "cancelled";
  path?: string;
};

export type DesktopSnapshot = {
  settings?: GlobalSettings;
  tasks: AnalysisTask[];
  secretMigrationError?: string;
};

export type LegacyDesktopData = {
  settings?: GlobalSettings;
  tasks?: AnalysisTask[];
};

export type RuntimeAdapter = {
  loadDesktopData: (legacy?: LegacyDesktopData) => Promise<DesktopSnapshot>;
  saveDesktopSettings: (settings: GlobalSettings) => Promise<void>;
  setProviderSecret: (provider: string, value: string) => Promise<void>;
  deleteProviderSecret: (provider: string) => Promise<void>;
  setAlphaVantageSecret: (provider: string, value: string) => Promise<void>;
  deleteAlphaVantageSecret: (provider: string) => Promise<void>;
  saveDesktopTask: (task: AnalysisTask) => Promise<void>;
  deleteDesktopTask: (taskId: string) => Promise<void>;
  clearDesktopData: () => Promise<void>;
  saveTextExport: (request: TextExportRequest) => Promise<TextExportResult>;
  runAnalysis: (
    taskId: string,
    payload: AnalysisForm,
    onEvent: (event: AnalysisEvent) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  stopAnalysis: (taskId: string) => Promise<void>;
  resolveInstrument: (query: string, settings: GlobalSettings) => Promise<ResolvedInstrument>;
  loadOhlcvChartData: (symbol: string, currDate: string, settings: GlobalSettings) => Promise<OhlcvBar[]>;
  testLlmConnection: (settings: GlobalSettings) => Promise<LlmConnectionCheck>;
  getRuntimeInfo: () => Promise<RuntimeInfo>;
  checkRuntime: (settings: GlobalSettings) => Promise<RuntimeCheck>;
};

export const webRuntimeAdapter: RuntimeAdapter = {
  async loadDesktopData() {
    return { tasks: [] };
  },
  async saveDesktopSettings() {
  },
  async setProviderSecret() {
  },
  async deleteProviderSecret() {
  },
  async setAlphaVantageSecret() {
  },
  async deleteAlphaVantageSecret() {
  },
  async saveDesktopTask() {
  },
  async deleteDesktopTask() {
  },
  async clearDesktopData() {
  },
  async saveTextExport(request) {
    const mimeType = request.format === "html" ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8";
    const url = URL.createObjectURL(new Blob([request.content], { type: mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = request.suggestedName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return { status: "saved" };
  },
  runAnalysis(_taskId, payload, onEvent, signal) {
    return streamAnalysis(payload, onEvent, signal);
  },
  async stopAnalysis() {
    // Web cancellation is handled by AbortController in the caller.
  },
  async resolveInstrument(query, settings) {
    const response = await fetch("/api/resolve-instrument", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, settings }),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed: ${response.status}`);
    }
    return await response.json() as ResolvedInstrument;
  },
  async loadOhlcvChartData() {
    return [];
  },
  async testLlmConnection(settings) {
    const response = await fetch("/api/test-llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `Request failed: ${response.status}`);
    }
    return await response.json() as LlmConnectionCheck;
  },
  async getRuntimeInfo() {
    return { kind: "web", label: "Web / Next.js API" };
  },
  async checkRuntime(settings) {
    const t = createTranslator(settings.systemLanguage);
    return {
      kind: "web",
      ok: true,
      pythonExists: true,
      runnerExists: true,
      canImportTradingAgents: true,
      errors: [t("webRuntimeDiagnosticsOnly")],
    };
  },
};

export const tauriRuntimeAdapter: RuntimeAdapter = {
  async loadDesktopData(legacy) {
    const { invoke } = await getTauriApi();
    if (legacy?.settings || legacy?.tasks?.length) {
      return await invoke<DesktopSnapshot>("import_legacy_desktop_data", { legacy });
    }
    return await invoke<DesktopSnapshot>("load_desktop_data");
  },
  async saveDesktopSettings(settings) {
    const { invoke } = await getTauriApi(settings.systemLanguage);
    await invoke("save_desktop_settings", { settings: stripSecretFields(settings) });
  },
  async setProviderSecret(provider, value) {
    const { invoke } = await getTauriApi();
    await invoke("set_provider_secret", { provider, value });
  },
  async deleteProviderSecret(provider) {
    const { invoke } = await getTauriApi();
    await invoke("delete_provider_secret", { provider });
  },
  async setAlphaVantageSecret(provider, value) {
    const { invoke } = await getTauriApi();
    await invoke("set_alpha_vantage_secret", { provider, value });
  },
  async deleteAlphaVantageSecret(provider) {
    const { invoke } = await getTauriApi();
    await invoke("delete_alpha_vantage_secret", { provider });
  },
  async saveDesktopTask(task) {
    const { invoke } = await getTauriApi();
    await invoke("save_desktop_task", { task });
  },
  async deleteDesktopTask(taskId) {
    const { invoke } = await getTauriApi();
    await invoke("delete_desktop_task", { taskId });
  },
  async clearDesktopData() {
    const { invoke } = await getTauriApi();
    await invoke("clear_desktop_data");
  },
  async saveTextExport(request) {
    const { invoke } = await getTauriApi();
    return await invoke<TextExportResult>("save_text_export", request);
  },
  async runAnalysis(taskId, payload, onEvent, signal) {
    const { invoke, listen } = await getTauriApi(payload.systemLanguage);
    let unlisten: (() => void) | undefined;
    let aborted = false;

    const abort = () => {
      aborted = true;
      void invoke("stop_analysis", { taskId });
    };

    if (signal?.aborted) {
      throw abortError();
    }

    signal?.addEventListener("abort", abort, { once: true });

    try {
      unlisten = await listen<AnalysisEvent | string>(`analysis-event:${taskId}`, (event) => {
        const eventPayload = event.payload;
        try {
          onEvent(typeof eventPayload === "string" ? JSON.parse(eventPayload) as AnalysisEvent : eventPayload);
        } catch (error) {
          onEvent({
            type: "error",
            error: errorMessage(error, createTranslator(payload.systemLanguage)("analysisRequestFailed")),
          });
        }
      });

      await invoke("start_analysis", {
        taskId,
        payloadJson: JSON.stringify(stripSecretFields(payload)),
      });
      if (aborted || signal?.aborted) throw abortError();
    } catch (error) {
      if (aborted || signal?.aborted) throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      unlisten?.();
    }
  },
  async stopAnalysis(taskId) {
    const { invoke } = await getTauriApi();
    await invoke("stop_analysis", { taskId });
  },
  async resolveInstrument(query, settings) {
    const { invoke } = await getTauriApi(settings.systemLanguage);
    return await invoke<ResolvedInstrument>("resolve_instrument", {
      query,
      payloadJson: JSON.stringify(stripSecretFields(settings)),
    });
  },
  async loadOhlcvChartData(symbol, currDate, settings) {
    const { invoke } = await getTauriApi(settings.systemLanguage);
    return await invoke<OhlcvBar[]>("load_ohlcv_chart_data", {
      symbol,
      currDate,
      payloadJson: JSON.stringify(stripSecretFields(settings)),
    });
  },
  async testLlmConnection(settings) {
    const { invoke } = await getTauriApi(settings.systemLanguage);
    return await invoke<LlmConnectionCheck>("test_llm_connection", {
      payloadJson: JSON.stringify(stripSecretFields(settings)),
    });
  },
  async getRuntimeInfo() {
    const { invoke } = await getTauriApi();
    return await invoke<RuntimeInfo>("runtime_info") ?? { kind: "tauri", label: "Tauri Desktop" };
  },
  async checkRuntime(settings) {
    const { invoke } = await getTauriApi(settings.systemLanguage);
    return await invoke<RuntimeCheck>("check_runtime", { pythonPath: settings.pythonPath, projectRoot: settings.projectRoot });
  },
};

export function getRuntimeAdapter(): RuntimeAdapter {
  return isTauriRuntime() ? tauriRuntimeAdapter : webRuntimeAdapter;
}

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function defaultRuntimeInfo(): RuntimeInfo {
  return { kind: "web", label: "Web / Next.js API" };
}

async function getTauriApi(language: SystemLanguage = "zh") {
  if (!isTauriRuntime()) {
    throw new Error(createTranslator(language)("tauriRuntimeUnavailable"));
  }
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  return { invoke, listen };
}

function abortError() {
  return new DOMException("Analysis was aborted", "AbortError");
}
