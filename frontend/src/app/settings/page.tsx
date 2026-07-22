"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import { getRuntimeAdapter, type LlmConnectionCheck } from "@/lib/runtime";
import type { GlobalSettings, SystemLanguage } from "@/lib/types";
import { useTaskCenter } from "@/components/task-center/context";
import { draftLanguage } from "@/components/task-center/utils";
import { CredentialField } from "@/features/settings/components/CredentialField";
import { SegmentedControl } from "@/components/task-center/components/SegmentedControl";
import { TextField } from "@/components/task-center/components/TextField";

type SettingsTab = "llm" | "data" | "strategy" | "interface";

export default function Page() {
  const router = useRouter();
  const { settings, saveSettings, deleteProviderSecret, deleteAlphaVantageSecret, clearAllLocalData } = useTaskCenter();
  const [draft, setDraft] = useState<GlobalSettings>(settings);
  const [activeTab, setActiveTab] = useState<SettingsTab>("llm");
  const [llmTest, setLlmTest] = useState<LlmConnectionCheck | null>(null);
  const [testingLlm, setTestingLlm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [saveError, setSaveError] = useState("");
  const language = draftLanguage(draft.systemLanguage);
  const t = createTranslator(language);
  const label = createSettingsLabels(language);

  useEffect(() => setDraft(settings), [settings]);

  function patch(patch: Partial<GlobalSettings>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      await saveSettings(draft);
      router.push("/");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function testLlmConnection() {
    setTestingLlm(true);
    setLlmTest(null);
    try {
      const savedDraft = await saveSettings(draft);
      setDraft(savedDraft);
      const result = await getRuntimeAdapter().testLlmConnection(savedDraft);
      setLlmTest(result);
    } catch (error) {
      setLlmTest({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingLlm(false);
    }
  }

  async function clearLocalData() {
    if (!window.confirm(t("clearLocalDataConfirm"))) return;
    setClearing(true);
    try {
      if (await clearAllLocalData()) router.push("/");
    } finally {
      setClearing(false);
    }
  }

  const tabs = [
    { key: "llm", label: label.tabs.llm },
    { key: "data", label: label.tabs.data },
    { key: "strategy", label: label.tabs.strategy },
    { key: "interface", label: label.tabs.interface },
  ];

  return (
    <section className="space-y-6">
      <form onSubmit={submit} className="space-y-6 pb-24">
        <SegmentedControl items={tabs} value={activeTab} onChange={(value) => setActiveTab(value as SettingsTab)} />
        <div className="rounded-lg border border-zinc-900 bg-zinc-950/50 px-4 py-3 text-sm leading-6 text-zinc-400">
          {label.localPrivacyNotice}
        </div>

        {activeTab === "llm" && (
          <SettingsPanel
            title={t("groupLlm")}
            hint={t("groupLlmHint")}
            action={
              <button
                type="button"
                onClick={testLlmConnection}
                disabled={testingLlm}
                className="inline-flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testingLlm && <Loader2 className="size-4 animate-spin" />}
                {testingLlm ? label.testingModel : label.testModel}
              </button>
            }
          >
            <div className="grid gap-5 md:grid-cols-2">
              <TextField label={t("llmProviderLabel")} value={draft.llmProvider} onChange={(llmProvider) => patch({ llmProvider })} placeholder="openai / google / anthropic / qwen ..." />
              <TextField label={t("backendUrlLabel")} value={draft.backendUrl} onChange={(backendUrl) => patch({ backendUrl })} placeholder="https://api.openai.com/v1" />
              <TextField label={t("quickModelLabel")} value={draft.quickThinkLlm} onChange={(quickThinkLlm) => patch({ quickThinkLlm })} placeholder="gpt-5.4-mini" />
              <TextField label={t("deepModelLabel")} value={draft.deepThinkLlm} onChange={(deepThinkLlm) => patch({ deepThinkLlm })} placeholder="gpt-5.5" />
              <CredentialField
                label={t("llmApiKeyLabel")}
                value={draft.apiKey}
                onChange={(apiKey) => patch({ apiKey })}
                placeholder={t("llmApiKeyPlaceholder")}
                showLabel={label.showApiKey}
                hideLabel={label.hideApiKey}
                configured={draft.providerConfigured}
                configuredLabel={label.credentialConfigured}
                deleteLabel={label.deleteCredential}
                onDelete={async () => {
                  await deleteProviderSecret();
                  patch({ apiKey: "", providerConfigured: false });
                }}
              />
              <TextField label={label.temperature} value={draft.temperature} onChange={(temperature) => patch({ temperature })} placeholder="0.2" />
              <SelectField label={label.openaiEffort} value={draft.openaiReasoningEffort} onChange={(openaiReasoningEffort) => patch({ openaiReasoningEffort })} options={label.effortOptions} />
              <SelectField label={label.googleThinking} value={draft.googleThinkingLevel} onChange={(googleThinkingLevel) => patch({ googleThinkingLevel })} options={label.googleThinkingOptions} />
              <SelectField label={label.anthropicEffort} value={draft.anthropicEffort} onChange={(anthropicEffort) => patch({ anthropicEffort })} options={label.effortOptions} />
            </div>
            {llmTest && <LlmTestResult result={llmTest} labels={label} />}
          </SettingsPanel>
        )}

        {activeTab === "data" && (
          <SettingsPanel title={t("groupData")} hint={label.dataHint}>
            <div className="grid gap-5 md:grid-cols-2">
              <CredentialField
                label={t("alphaVantageApiKeyLabel")}
                value={draft.alphaVantageApiKey}
                onChange={(alphaVantageApiKey) => patch({ alphaVantageApiKey })}
                placeholder={t("alphaVantagePlaceholder")}
                showLabel={label.showApiKey}
                hideLabel={label.hideApiKey}
                configured={draft.alphaVantageConfigured}
                configuredLabel={label.credentialConfigured}
                deleteLabel={label.deleteCredential}
                onDelete={async () => {
                  await deleteAlphaVantageSecret();
                  patch({ alphaVantageApiKey: "", alphaVantageConfigured: false });
                }}
              />
              <VendorField label={label.coreStockApis} value={draft.coreStockApis} onChange={(coreStockApis) => patch({ coreStockApis })} placeholder="eastmoney,yfinance" />
              <VendorField label={label.technicalIndicators} value={draft.technicalIndicators} onChange={(technicalIndicators) => patch({ technicalIndicators })} placeholder="yfinance" />
              <VendorField label={label.fundamentalData} value={draft.fundamentalData} onChange={(fundamentalData) => patch({ fundamentalData })} placeholder="akshare,yfinance" />
              <VendorField label={label.newsData} value={draft.newsData} onChange={(newsData) => patch({ newsData })} placeholder="yfinance" />
              <NumberField label={label.newsArticleLimit} value={draft.newsArticleLimit} onChange={(newsArticleLimit) => patch({ newsArticleLimit })} min={1} max={80} />
              <NumberField label={label.globalNewsArticleLimit} value={draft.globalNewsArticleLimit} onChange={(globalNewsArticleLimit) => patch({ globalNewsArticleLimit })} min={1} max={50} />
              <NumberField label={label.globalNewsLookbackDays} value={draft.globalNewsLookbackDays} onChange={(globalNewsLookbackDays) => patch({ globalNewsLookbackDays })} min={1} max={60} />
            </div>
            <div className="mt-5 rounded-lg border border-zinc-900 bg-zinc-950/50 p-4 text-sm leading-6 text-zinc-400">
              {label.aShareSentimentNote}
            </div>
          </SettingsPanel>
        )}

        {activeTab === "strategy" && (
          <SettingsPanel title={t("groupPreferences")} hint={label.strategyHint}>
            <div className="grid gap-5 md:grid-cols-2">
              <NumberField label={label.maxDebateRounds} value={draft.maxDebateRounds} onChange={(maxDebateRounds) => patch({ maxDebateRounds })} min={0} max={8} />
              <NumberField label={label.maxRiskRounds} value={draft.maxRiskRounds} onChange={(maxRiskRounds) => patch({ maxRiskRounds })} min={0} max={8} />
              <NumberField label={label.analystConcurrencyLimit} value={draft.analystConcurrencyLimit} onChange={(analystConcurrencyLimit) => patch({ analystConcurrencyLimit })} min={1} max={6} />
              <TextField label={label.benchmarkTicker} value={draft.benchmarkTicker} onChange={(benchmarkTicker) => patch({ benchmarkTicker })} placeholder="000300.SS / SPY / ^HSI" />
              <ToggleCard checked={draft.checkpointEnabled} onChange={(checkpointEnabled) => patch({ checkpointEnabled })} title={t("checkpoint")} hint={t("checkpointHint")} />
            </div>
          </SettingsPanel>
        )}

        {activeTab === "interface" && (
          <SettingsPanel title={t("groupInterface")} hint={t("groupInterfaceHint")}>
            <div className="grid gap-5 md:grid-cols-2">
              <label className="field-label">{t("systemLanguage")}
                <select className="field-input" value={draft.systemLanguage} onChange={(event) => patch({ systemLanguage: event.target.value as SystemLanguage })}>
                  <option value="zh">{t("chinese")}</option>
                  <option value="en">{t("english")}</option>
                </select>
              </label>
            </div>
            <div className="mt-6 flex flex-col gap-3 rounded-lg border border-rose-950 bg-rose-950/10 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium text-rose-200">{t("clearLocalData")}</div>
                <div className="mt-1 text-xs leading-5 text-zinc-500">{label.clearDataHint}</div>
              </div>
              <button type="button" onClick={clearLocalData} disabled={clearing} className="shrink-0 rounded-md border border-rose-900 px-3 py-2 text-sm text-rose-200 transition hover:border-rose-700 hover:bg-rose-950/40 disabled:opacity-50">
                {clearing ? label.clearing : t("clearLocalData")}
              </button>
            </div>
          </SettingsPanel>
        )}

        <div className="sticky bottom-0 z-20 -mx-4 flex flex-wrap justify-end gap-3 border-t border-zinc-900 bg-black/85 px-4 py-4 backdrop-blur-xl sm:-mx-6 sm:px-6">
          {saveError && <div className="mr-auto text-sm text-rose-300">{saveError}</div>}
          <button type="submit" disabled={saving} className="vercel-button disabled:opacity-50">
            {saving ? label.saving : t("saveSettings")}
          </button>
        </div>
      </form>
    </section>
  );
}

function SettingsPanel({ title, hint, action, children }: { title: string; hint: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-900 bg-black p-6">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-2">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <span className="text-xs text-zinc-500">{hint}</span>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function LlmTestResult({ result, labels }: { result: LlmConnectionCheck; labels: ReturnType<typeof createSettingsLabels> }) {
  return (
    <div className={[
      "mt-5 rounded-lg border px-4 py-3 text-sm leading-6",
      result.ok ? "border-emerald-900/60 bg-emerald-950/20 text-emerald-200" : "border-rose-900/60 bg-rose-950/20 text-rose-200",
    ].join(" ")}
    >
      <div className="font-medium">{result.ok ? labels.testSucceeded : labels.testFailed}</div>
      <div className="mt-1 text-xs opacity-80">
        {[result.provider, result.model, result.latencyMs ? `${result.latencyMs}ms` : ""].filter(Boolean).join(" · ")}
      </div>
      {(result.ok ? result.message : result.error) && (
        <div className="mt-2 break-words text-xs opacity-90">{result.ok ? result.message : result.error}</div>
      )}
    </div>
  );
}

function SelectField({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="field-label">{label}
      <select className="field-input" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => <option key={option.value || "default"} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function VendorField(props: { label: string; value: string; onChange: (value: string) => void; placeholder: string }) {
  return <TextField {...props} />;
}

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (value: number) => void; min: number; max: number }) {
  return (
    <label className="field-label">{label}
      <input className="field-input" type="number" min={min} max={max} value={value} onChange={(event) => onChange(clampNumber(event.target.value, value, min, max))} />
    </label>
  );
}

function ToggleCard({ checked, onChange, title, hint }: { checked: boolean; onChange: (value: boolean) => void; title: string; hint: string }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-zinc-900 bg-zinc-950/50 p-4 text-sm text-zinc-300 md:col-span-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="toggle-switch mt-0.5" />
      <span>
        <span className="block">{title}</span>
        <span className="mt-1 block text-xs text-zinc-500">{hint}</span>
      </span>
    </label>
  );
}

function clampNumber(raw: string, fallback: number, min: number, max: number) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function createSettingsLabels(language: SystemLanguage) {
  const zh = language === "zh";
  return {
    tabs: zh
      ? { llm: "模型", data: "数据源", strategy: "分析策略", interface: "界面" }
      : { llm: "Models", data: "Data", strategy: "Strategy", interface: "Interface" },
    temperature: zh ? "Temperature（可选）" : "Temperature (optional)",
    openaiEffort: zh ? "OpenAI 推理强度" : "OpenAI reasoning effort",
    googleThinking: zh ? "Google Thinking Level" : "Google thinking level",
    anthropicEffort: zh ? "Anthropic Effort" : "Anthropic effort",
    testModel: zh ? "测试模型" : "Test model",
    testingModel: zh ? "测试中…" : "Testing...",
    testSucceeded: zh ? "模型连接成功" : "Model connection succeeded",
    testFailed: zh ? "模型连接失败" : "Model connection failed",
    showApiKey: zh ? "显示 API Key" : "Show API key",
    hideApiKey: zh ? "隐藏 API Key" : "Hide API key",
    credentialConfigured: zh ? "已安全保存到系统凭据库" : "Stored in the operating-system credential store",
    deleteCredential: zh ? "删除凭据" : "Delete credential",
    saving: zh ? "保存中…" : "Saving...",
    clearing: zh ? "正在清除…" : "Clearing...",
    clearDataHint: zh
      ? "删除任务、报告、设置和系统凭据库中的 Evidence Loom API Key。此操作不可撤销。"
      : "Deletes tasks, reports, settings, and Evidence Loom API keys from the system credential store. This cannot be undone.",
    dataHint: zh ? "选择行情、基本面、新闻等数据源顺序。" : "Choose vendor priority for market, fundamentals, and news data.",
    localPrivacyNotice: zh
      ? "桌面端 API Key 保存在系统凭据库；Web 模式只在当前会话内保留。分析内容仍会发送到你选择的模型和数据提供商。"
      : "Desktop API keys use the operating-system credential store; web keys remain only for this session. Analysis data is still sent to the providers you select.",
    coreStockApis: zh ? "行情数据源顺序" : "Market data vendors",
    technicalIndicators: zh ? "技术指标数据源顺序" : "Technical indicator vendors",
    fundamentalData: zh ? "基本面数据源顺序" : "Fundamental data vendors",
    newsData: zh ? "新闻数据源顺序" : "News data vendors",
    newsArticleLimit: zh ? "个股新闻数量上限" : "Ticker news article limit",
    globalNewsArticleLimit: zh ? "宏观新闻数量上限" : "Macro news article limit",
    globalNewsLookbackDays: zh ? "宏观新闻回看天数" : "Macro news lookback days",
    aShareSentimentNote: zh
      ? "A 股情绪分析会优先使用东方财富个股新闻、资讯搜索和人气关键词；股吧为空时会作为数据缺失处理，不再直接判定无情绪信号。"
      : "China A-share sentiment prioritizes Eastmoney stock news, search, and hot keywords. Empty stock-bar results are treated as missing data, not neutral sentiment.",
    strategyHint: zh ? "控制辩论深度、并发和业绩归因基准。" : "Control debate depth, concurrency, and benchmark attribution.",
    maxDebateRounds: zh ? "投研多空辩论轮数（0 跟随任务深度）" : "Bull/bear debate rounds (0 follows task depth)",
    maxRiskRounds: zh ? "风险讨论轮数（0 跟随任务深度）" : "Risk discussion rounds (0 follows task depth)",
    analystConcurrencyLimit: zh ? "分析师并发数" : "Analyst concurrency",
    benchmarkTicker: zh ? "统一基准指数（可选）" : "Benchmark ticker override (optional)",
    effortOptions: [
      { value: "", label: zh ? "使用模型默认" : "Use provider default" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
    googleThinkingOptions: [
      { value: "", label: zh ? "使用模型默认" : "Use provider default" },
      { value: "minimal", label: "minimal" },
      { value: "low", label: "low" },
      { value: "medium", label: "medium" },
      { value: "high", label: "high" },
    ],
  };
}
