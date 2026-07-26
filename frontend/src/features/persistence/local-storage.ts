import {
  createEmptyTask,
  defaultGlobalSettings,
  detectAssetType,
  inferInstrumentName,
  initialStats,
  normalizeGlobalSettings,
} from "@/lib/analysis";
import { ensureLegacyReportVersion } from "@/features/report-export/lib/versioning";
import type { AnalysisForm, AnalysisTask, GlobalSettings } from "@/lib/types";

const settingsStorageKey = "evidenceloom.globalSettings.v1";
const tasksStorageKey = "evidenceloom.analysisTasks.v1";
const legacySettingsKeys = [
  "marketquorum.globalSettings.v1",
  "tradingagents.globalSettings.v1",
  "tradingagents.analysis.form.v1",
];
const legacyTasksKeys = [
  "marketquorum.analysisTasks.v1",
  "tradingagents.analysisTasks.v1",
];

export type LegacyDesktopData = {
  settings?: GlobalSettings;
  tasks?: AnalysisTask[];
};

export function loadGlobalSettings(): GlobalSettings {
  if (typeof window === "undefined") return defaultGlobalSettings();
  const parsed = readJson<Partial<AnalysisForm>>(settingsStorageKey)
    ?? firstJson<Partial<AnalysisForm>>(legacySettingsKeys);
  if (!parsed) return defaultGlobalSettings();

  const settings = sessionSafeSettings(normalizeGlobalSettings(parsed));
  saveGlobalSettings(settings);
  removeKeys(legacySettingsKeys);
  return settings;
}

export function saveGlobalSettings(settings: GlobalSettings) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(settingsStorageKey, JSON.stringify(stripSecretFields(settings)));
}

export function loadTasks(): AnalysisTask[] {
  if (typeof window === "undefined") return [];
  const tasks = readJson<AnalysisTask[]>(tasksStorageKey)
    ?? firstJson<AnalysisTask[]>(legacyTasksKeys)
    ?? [];
  const normalized = normalizeTasks(tasks);
  saveTasks(normalized);
  removeKeys(legacyTasksKeys);
  return normalized;
}

export function saveTasks(tasks: AnalysisTask[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(tasksStorageKey, JSON.stringify(tasks));
}

export function loadLegacyDesktopData(): LegacyDesktopData {
  if (typeof window === "undefined") return {};
  const settings = firstJson<Partial<AnalysisForm>>([
    ...legacySettingsKeys,
    settingsStorageKey,
  ]);
  const tasks = firstJson<AnalysisTask[]>([
    ...legacyTasksKeys,
    tasksStorageKey,
  ]);
  return {
    ...(settings ? { settings: normalizeGlobalSettings(settings) } : {}),
    ...(tasks ? { tasks: normalizeTasks(tasks) } : {}),
  };
}

export function clearLegacyDesktopData() {
  if (typeof window === "undefined") return;
  removeKeys([
    settingsStorageKey,
    tasksStorageKey,
    ...legacySettingsKeys,
    ...legacyTasksKeys,
  ]);
}

export function clearGlobalSettings() {
  if (typeof window === "undefined") return;
  removeKeys([settingsStorageKey, ...legacySettingsKeys]);
}

export function clearTasks() {
  if (typeof window === "undefined") return;
  removeKeys([tasksStorageKey, ...legacyTasksKeys]);
}

export function sessionSafeSettings(settings: GlobalSettings): GlobalSettings {
  return {
    ...settings,
    apiKey: "",
    alphaVantageApiKey: "",
    providerConfigured: false,
    alphaVantageConfigured: false,
  };
}

export function stripSecretFields<T extends { apiKey?: string; alphaVantageApiKey?: string }>(
  value: T,
): Omit<T, "apiKey" | "alphaVantageApiKey"> {
  const { apiKey: _apiKey, alphaVantageApiKey: _alphaVantageApiKey, ...safe } = value;
  return safe;
}

function normalizeTasks(tasks: AnalysisTask[]): AnalysisTask[] {
  return tasks.map((task) => {
    const status = task.status === "running" ? "stopped" : task.status;
    const normalized: AnalysisTask = {
      ...createEmptyTask({
        ticker: task.ticker,
        instrumentName: task.instrumentName ?? inferInstrumentName(task.ticker),
        analysisDate: task.analysisDate,
        assetType: task.assetType ?? detectAssetType(task.ticker, "stock"),
        researchDepth: task.researchDepth ?? 1,
        analysts: task.analysts,
        outputLanguage: task.outputLanguage ?? "中文",
      }, task.id, task.createdAt),
      ...task,
      origin: task.origin ?? "analysis",
      instrumentName: task.instrumentName ?? inferInstrumentName(task.ticker),
      assetType: task.assetType ?? detectAssetType(task.ticker, "stock"),
      researchDepth: task.researchDepth ?? 1,
      outputLanguage: task.outputLanguage ?? "中文",
      status,
      queuedAt: task.queuedAt ?? "",
      queueOrder: Number.isFinite(task.queueOrder) ? task.queueOrder : null,
      stats: { ...initialStats, ...task.stats },
      logs: task.logs ?? [],
      agentStatuses: task.agentStatuses ?? {},
      reportSections: task.reportSections ?? {},
      reportVersions: task.reportVersions ?? [],
    };
    return ensureLegacyReportVersion(normalized);
  });
}

function firstJson<T>(keys: string[]): T | undefined {
  for (const key of keys) {
    const value = readJson<T>(key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readJson<T>(key: string): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : undefined;
  } catch {
    return undefined;
  }
}

function removeKeys(keys: string[]) {
  keys.forEach((key) => window.localStorage.removeItem(key));
}
