"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Search } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";
import { defaultTaskDraft, detectAssetType, normalizeAnalystsForAssetType } from "@/lib/analysis";
import { getRuntimeAdapter } from "@/lib/runtime";
import type { AnalystKey, AssetType, NewTaskDraft, ResolvedInstrument } from "@/lib/types";
import { useTaskCenter } from "@/components/task-center/context";
import { assetTypeLabel, taskDetailHref } from "@/components/task-center/utils";
import { AnalystSelector } from "@/components/task-center/components/AnalystSelector";
import { ErrorList } from "@/components/task-center/components/ErrorList";
import { TickerFormatGuide } from "@/components/task-center/components/TickerFormatGuide";

type Step = "search" | "resolving" | "configure" | "error";

export function NewTaskFlow() {
  const router = useRouter();
  const { settings, runningTask, queuedTasks, createAndQueueTask } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  const [step, setStep] = useState<Step>("search");
  const [query, setQuery] = useState("");
  const [resolved, setResolved] = useState<ResolvedInstrument | null>(null);
  const [draft, setDraft] = useState<NewTaskDraft>(() => defaultTaskDraft());
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [tickerEdited, setTickerEdited] = useState(false);
  const assetType = detectAssetType(draft.ticker, draft.assetType);
  const runtime = useMemo(() => getRuntimeAdapter(), []);

  function patchDraft(patch: Partial<NewTaskDraft>, options?: { tickerEdited?: boolean }) {
    setDraft((current) => {
      const next = { ...current, ...patch };
      const assetType = detectAssetType(next.ticker, next.assetType);
      return { ...next, assetType, analysts: normalizeAnalystsForAssetType(next.analysts, assetType) };
    });
    if (options?.tickerEdited) setTickerEdited(true);
  }

  async function resolveQuery(event?: FormEvent) {
    event?.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || step === "resolving") {
      setErrors(trimmed ? [] : [t("instrumentQueryRequired")]);
      return;
    }
    setStep("resolving");
    setErrors([]);
    setResolved(null);
    try {
      const result = await runtime.resolveInstrument(trimmed, settings);
      const nextDraft = draftFromResolvedInstrument(result, settings.systemLanguage);
      setResolved(result);
      setDraft(nextDraft);
      setTickerEdited(false);
      setStep("configure");
    } catch (error) {
      setErrors([errorMessage(error, t("instrumentResolveFailed"))]);
      setStep("error");
    }
  }

  function backToSearch() {
    setStep("search");
    setErrors([]);
    setResolved(null);
    setTickerEdited(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrors([]);
    try {
      const result = await createAndQueueTask(draft);
      setErrors(result.errors);
      if (result.task) {
        router.push(taskDetailHref(result.task.id));
        return;
      }
    } catch (error) {
      setErrors([errorMessage(error, t("analysisRequestFailed"))]);
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "search" || step === "resolving" || step === "error") {
    return (
      <section className="flex min-h-[34rem] items-center justify-center px-2 py-10">
        <div className="w-full max-w-3xl">
          <div className="mb-8 text-center">
            <h2 className="text-3xl font-semibold text-white md:text-5xl">{t("instrumentSearchTitle")}</h2>
            <p className="mt-4 text-sm text-zinc-500 md:text-base">{t("instrumentSearchHint")}</p>
          </div>
          <form onSubmit={resolveQuery} className="rounded-xl border border-zinc-800 bg-black shadow-[0_24px_90px_rgba(0,0,0,0.45)] focus-within:border-zinc-600">
            <div className="flex flex-col gap-1 p-1 sm:flex-row">
              <label className="sr-only" htmlFor="instrument-query">{t("instrumentQuery")}</label>
              <input
                id="instrument-query"
                autoFocus
                disabled={step === "resolving"}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("instrumentSearchPlaceholder")}
                className="h-14 flex-1 rounded-lg border-0 bg-transparent px-4 text-base text-zinc-100 outline-none placeholder:text-zinc-600 disabled:cursor-wait disabled:text-zinc-500"
              />
              <button type="submit" disabled={step === "resolving"} className="inline-flex h-14 items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-50 px-6 text-sm font-semibold text-zinc-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60">
                {step === "resolving" ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                {step === "resolving" ? t("resolvingInstrument") : "GO"}
              </button>
            </div>
          </form>
          <div className="mt-5">
            <ErrorList errors={errors} />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      {resolved && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="text-xs font-medium uppercase text-zinc-500">{t("resolvedAs")}</div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-semibold text-white">{resolved.ticker}</h2>
                <span className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300">{assetTypeLabel(resolved.assetType, settings.systemLanguage)}</span>
                {resolved.exchange && <span className="rounded-full border border-zinc-800 px-2.5 py-1 text-xs text-zinc-500">{resolved.exchange}</span>}
              </div>
              <p className="mt-2 text-sm text-zinc-400">{resolved.displayName}</p>
              <p className="mt-2 text-xs leading-5 text-zinc-600">{resolved.reason} · {Math.round(resolved.confidence * 100)}%</p>
            </div>
            <button type="button" onClick={backToSearch} className="inline-flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2 text-sm text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-900">
              <ArrowLeft className="size-4" /> {t("searchAgain")}
            </button>
          </div>
        </div>
      )}

      <section className="rounded-xl border border-zinc-900 bg-black p-6">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold text-white">{t("confirmTask")}</h2>
          <p className="mt-2 text-sm text-zinc-500">{t("confirmTaskHint")}</p>
        </div>
        <form onSubmit={submit} className="grid gap-5 md:grid-cols-2">
          <label className="field-label">{t("ticker")}
            <input className="field-input" value={draft.ticker} onChange={(event) => patchDraft({ ticker: event.target.value, instrumentName: "" }, { tickerEdited: true })} placeholder={t("tickerPlaceholder")} />
            {tickerEdited && <span className="mt-2 block text-xs font-normal text-amber-300">{t("tickerEditedHint")}</span>}
          </label>
          <label className="field-label">{t("analysisDate")}
            <input className="field-input" type="date" value={draft.analysisDate} onChange={(event) => patchDraft({ analysisDate: event.target.value })} />
          </label>
          <label className="field-label">{t("assetType")}
            <select className="field-input" value={draft.assetType} onChange={(event) => patchDraft({ assetType: event.target.value as AssetType })}>
              <option value="stock">{t("stock")}</option>
              <option value="crypto">{t("crypto")}</option>
            </select>
          </label>
          <label className="field-label">{t("researchDepth")}
            <select className="field-input" value={draft.researchDepth} onChange={(event) => patchDraft({ researchDepth: Number(event.target.value) })}>
              <option value={1}>{t("shallow")} · {t("round", { count: 1 })}</option>
              <option value={3}>{t("medium")} · {t("round", { count: 3 })}</option>
              <option value={5}>{t("deep")} · {t("round", { count: 5 })}</option>
            </select>
          </label>
          <label className="field-label">{t("outputLanguage")}
            <input className="field-input" value={draft.outputLanguage} onChange={(event) => patchDraft({ outputLanguage: event.target.value })} placeholder={t("outputLanguagePlaceholder")} />
          </label>
          <TickerFormatGuide />
          {resolved && shouldWarnNonCompany(resolved) && (
            <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-4 text-sm leading-6 text-amber-200 md:col-span-2">
              {t("nonCompanyFundamentalsHint")}
            </div>
          )}
          <AnalystSelector analysts={draft.analysts} assetType={assetType} onChange={(analysts) => patchDraft({ analysts })} />
          <ErrorList errors={errors} />
          <div className="flex justify-end gap-3 md:col-span-2">
            <Link href="/" className="vercel-button-secondary" aria-disabled={submitting}>{t("cancel")}</Link>
            <button type="submit" disabled={submitting} className="vercel-button disabled:cursor-not-allowed disabled:opacity-60">
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {runningTask || queuedTasks.length > 0 ? t("addToQueue") : t("startAnalysis")}
            </button>
          </div>
        </form>
      </section>
    </section>
  );
}

function draftFromResolvedInstrument(instrument: ResolvedInstrument, language: "zh" | "en"): NewTaskDraft {
  const assetType = detectAssetType(instrument.ticker, instrument.assetType);
  const analysts = defaultAnalystsForInstrument(instrument);
  return {
    ...defaultTaskDraft(),
    ticker: instrument.ticker,
    instrumentName: instrument.displayName,
    assetType,
    analysts: normalizeAnalystsForAssetType(analysts, assetType),
    outputLanguage: language === "en" ? "English" : "中文",
  };
}

function defaultAnalystsForInstrument(instrument: ResolvedInstrument): AnalystKey[] {
  if (instrument.assetType === "crypto") return ["market", "social", "news"];
  if (shouldWarnNonCompany(instrument)) return ["market", "news"];
  return ["market", "social", "news", "fundamentals"];
}

function shouldWarnNonCompany(instrument: ResolvedInstrument) {
  const quoteType = instrument.quoteType.toUpperCase();
  return ["ETF", "INDEX", "MUTUALFUND", "FUTURE", "CURRENCY"].some((type) => quoteType.includes(type));
}
