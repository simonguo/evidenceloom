import type { GlobalSettings } from "@/lib/types";

export function normalizeSettingsForSave(settings: GlobalSettings): GlobalSettings {
  return {
    ...settings,
    llmProvider: settings.llmProvider.trim().toLowerCase(),
    backendUrl: settings.backendUrl.trim(),
    quickThinkLlm: settings.quickThinkLlm.trim(),
    deepThinkLlm: settings.deepThinkLlm.trim(),
    apiKey: settings.apiKey.trim(),
    alphaVantageApiKey: settings.alphaVantageApiKey.trim(),
  };
}
