import { createAvatar } from "@dicebear/core";
import { avataaars } from "@dicebear/collection";
import { createTranslator } from "@/lib/i18n";
import type { AnalysisTask, AssetType, SystemLanguage } from "@/lib/types";
import {
  agentLabelKeys,
  agentRoleKeys,
  decisionLabelKeys,
  reportTitleKeys,
  teamLabelKeys,
  teamMandateKeys,
} from "./constants";
import type { RuntimeInfo } from "@/lib/runtime";

export function prependLog(logs: AnalysisTask["logs"], type: string, message: string, timestamp = new Date().toLocaleTimeString(), agent?: string) {
  return [{ id: crypto.randomUUID(), type, message, timestamp, agent }, ...logs].slice(0, 100);
}

/** Journal identities and display literals are committed before desktop replay. */
export function prependSeededLog(logs: AnalysisTask["logs"], id: string, type: string, message: string, timestamp: string, agent?: string) {
  return [{ id, type, message, timestamp, ...(agent === undefined ? {} : { agent }) }, ...logs.filter((log) => log.id !== id)].slice(0, 100);
}

export function compactNumber(value: number) {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toString();
}

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const secs = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${secs}`;
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function agentLabel(agent: string, language: SystemLanguage) {
  const key = agentLabelKeys[agent];
  return key ? createTranslator(language)(key) : agent;
}

export function teamLabel(team: string, language: SystemLanguage) {
  const key = teamLabelKeys[team];
  return key ? createTranslator(language)(key) : team;
}

export function teamMandate(team: string, language: SystemLanguage) {
  const key = teamMandateKeys[team];
  return key ? createTranslator(language)(key) : "";
}

export function agentRole(agent: string, language: SystemLanguage) {
  const key = agentRoleKeys[agent];
  return key ? createTranslator(language)(key) : "";
}

export function reportTitle(reportKey: string, language: SystemLanguage) {
  const key = reportTitleKeys[reportKey];
  return key ? createTranslator(language)(key) : reportKey;
}

export function localizedDecision(decision: string, language: SystemLanguage) {
  const trimmed = decision.trim();
  if (!trimmed) return "";
  const normalized = trimmed.toLowerCase().replace(/[\s_-]+/g, "");
  const key = decisionLabelKeys[normalized];
  if (!key) return decision;
  return createTranslator(language)(key);
}

export { extractDecisionFromReport } from "./decisions";

export function runtimeLabel(runtimeInfo: RuntimeInfo, language: SystemLanguage) {
  const t = createTranslator(language);
  return runtimeInfo.kind === "tauri" ? t("tauriRuntime") : t("webRuntime");
}

export function agentWorkStateLabel(status: "pending" | "in_progress" | "completed" | "error", language: SystemLanguage) {
  const t = createTranslator(language);
  if (status === "in_progress") return t("agentWorking");
  if (status === "completed") return t("agentDelivered");
  if (status === "error") return t("agentFailed");
  return t("agentQueued");
}

const avatarCache = new Map<string, string>();

export function avatarUrl(seed: string) {
  const cached = avatarCache.get(seed);
  if (cached) return cached;

  const dataUri = createAvatar(avataaars, {
    seed,
    backgroundColor: ["18181b", "27272a", "0f172a", "1f2937"],
    radius: 50,
    size: 96,
  }).toDataUri();
  avatarCache.set(seed, dataUri);
  return dataUri;
}

export function depthLabel(depth: number, language: SystemLanguage) {
  const t = createTranslator(language);
  if (depth >= 5) return t("deep");
  if (depth >= 3) return t("medium");
  return t("shallow");
}

export function assetTypeLabel(assetType: AssetType, language: SystemLanguage) {
  return createTranslator(language)(assetType);
}

export function taskDetailHref(taskId: string) {
  return `/tasks/detail?id=${encodeURIComponent(taskId)}`;
}

export function pageTitle(pathname: string, language: SystemLanguage) {
  const t = createTranslator(language);
  if (pathname === "/") return t("tasks");
  if (pathname === "/tasks/new") return t("newTask");
  if (pathname === "/tasks/detail") return t("taskDetails");
  if (pathname === "/diagnostics") return t("diagnostics");
  if (pathname === "/settings") return t("settings");
  return "Evidence Loom";
}

export function draftLanguage(language: SystemLanguage): SystemLanguage {
  return language === "en" ? "en" : "zh";
}
