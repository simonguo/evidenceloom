import path from "node:path";

type RunnerSettings = {
  llmProvider?: string;
  backendUrl?: string;
  apiKey?: string;
  alphaVantageApiKey?: string;
};

const sensitiveEnvName = /(API[_-]?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)/i;

const providerApiKeyEnv: Record<string, string | undefined> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  "qwen-cn": "DASHSCOPE_CN_API_KEY",
  glm: "ZHIPU_API_KEY",
  "glm-cn": "ZHIPU_CN_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export function buildRunnerEnv(settings: RunnerSettings, repoRoot: string): NodeJS.ProcessEnv {
  const provider = (
    settings.llmProvider
    || process.env.EVIDENCELOOM_LLM_PROVIDER
    || process.env.TRADINGAGENTS_LLM_PROVIDER
    || "openai"
  ).trim().toLowerCase();
  const hasCustomBackend = Boolean(settings.backendUrl?.trim());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: [repoRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  };
  const apiKey = settings.apiKey?.trim();

  if (apiKey) {
    const envName = providerApiKeyEnv[provider];
    if (envName) env[envName] = apiKey;
    if (provider === "openai" || (hasCustomBackend && providerUsesOpenAiSdk(provider))) {
      env.OPENAI_API_KEY = apiKey;
    }
  }

  if (settings.alphaVantageApiKey?.trim()) {
    env.ALPHA_VANTAGE_API_KEY = settings.alphaVantageApiKey.trim();
  }

  return env;
}

export function stripSensitiveKeys<T extends Record<string, unknown>>(payload: T): Omit<T, "apiKey" | "alphaVantageApiKey"> {
  const { apiKey: _apiKey, alphaVantageApiKey: _alphaVantageApiKey, ...safePayload } = payload;
  return safePayload;
}

export function collectSensitiveValues(
  settings: RunnerSettings,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = [settings.apiKey?.trim(), settings.alphaVantageApiKey?.trim()];
  Object.entries(processEnvironment).forEach(([name, value]) => {
    if (sensitiveEnvName.test(name)) values.push(value?.trim());
  });
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(
    (left, right) => right.length - left.length,
  );
}

export function redactSensitiveText(text: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce(
    (redacted, value) => value ? redacted.split(value).join("[REDACTED]") : redacted,
    text,
  );
}

export function createRedactedLineBuffer(
  sensitiveValues: readonly string[],
  emit: (line: string) => void,
) {
  let pending = "";
  return {
    push(chunk: string) {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        emit(redactSensitiveText(pending.slice(0, newline), sensitiveValues));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    },
    flush() {
      if (pending) emit(redactSensitiveText(pending, sensitiveValues));
      pending = "";
    },
  };
}

function providerUsesOpenAiSdk(provider: string) {
  return ["openai", "xai", "deepseek", "qwen", "qwen-cn", "glm", "glm-cn", "minimax", "minimax-cn", "openrouter"].includes(provider);
}
