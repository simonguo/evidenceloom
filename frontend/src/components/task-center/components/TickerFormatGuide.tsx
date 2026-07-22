import { createTranslator } from "@/lib/i18n";
import { useTaskCenter } from "../context";

export function TickerFormatGuide() {
  const { settings } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  const examples = [
    t("tickerUsExample"),
    t("tickerCnExample"),
    t("tickerHkExample"),
    t("tickerOtherExample"),
    t("tickerCryptoExample"),
  ];

  return (
    <div className="md:col-span-2 rounded-xl border border-zinc-900 bg-zinc-950/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-zinc-100">{t("tickerFormatTitle")}</div>
          <p className="mt-1 text-sm leading-6 text-zinc-500">{t("tickerFormatHint")}</p>
        </div>
        <span className="rounded-full border border-zinc-800 px-2.5 py-1 text-xs text-zinc-500">Yahoo Finance</span>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {examples.map((example) => (
          <div key={example} className="rounded-lg border border-zinc-900 bg-black/40 px-3 py-2 text-sm leading-6 text-zinc-400">
            {example}
          </div>
        ))}
      </div>
    </div>
  );
}
