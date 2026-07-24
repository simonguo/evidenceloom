import { describe, expect, it } from "vitest";
import { defaultGlobalSettings } from "@/lib/analysis";
import { normalizeSettingsForSave } from "./normalize-settings";

describe("normalizeSettingsForSave", () => {
  it("canonicalizes provider routing fields before persistence and execution", () => {
    const normalized = normalizeSettingsForSave({
      ...defaultGlobalSettings(),
      llmProvider: " Deepseek ",
      backendUrl: " https://api.deepseek.com/ ",
      quickThinkLlm: " deepseek-v4-pro ",
      deepThinkLlm: " deepseek-v4-pro ",
      apiKey: " sk-test ",
    });

    expect(normalized.llmProvider).toBe("deepseek");
    expect(normalized.backendUrl).toBe("https://api.deepseek.com/");
    expect(normalized.quickThinkLlm).toBe("deepseek-v4-pro");
    expect(normalized.deepThinkLlm).toBe("deepseek-v4-pro");
    expect(normalized.apiKey).toBe("sk-test");
  });
});
