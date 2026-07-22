import { Check } from "lucide-react";
import clsx from "clsx";
import { createTranslator } from "@/lib/i18n";
import { analystOptions, type AssetType, type NewTaskDraft } from "@/lib/types";
import { useTaskCenter } from "../context";

export function AnalystSelector({ analysts, assetType, onChange }: { analysts: NewTaskDraft["analysts"]; assetType: AssetType; onChange: (analysts: NewTaskDraft["analysts"]) => void }) {
  const { settings } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  return (
    <div className="md:col-span-2">
      <div className="mb-3 flex items-center justify-between gap-3"><span className="field-label">{t("analystTeam")}</span><span className="text-xs text-zinc-600">{t("cryptoDisablesFundamentals")}</span></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {analystOptions.map((analyst) => {
          const disabled = assetType === "crypto" && analyst.key === "fundamentals";
          const selected = analysts.includes(analyst.key);
          return (
            <button
              key={analyst.key}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => onChange(selected ? analysts.filter((item) => item !== analyst.key) : [...analysts, analyst.key])}
              className={clsx(
                "group relative min-h-32 overflow-hidden rounded-xl border p-5 text-left transition",
                selected
                  ? "border-blue-500 bg-blue-500/[0.08] shadow-[0_0_0_1px_rgba(59,130,246,0.35),0_18px_55px_rgba(59,130,246,0.12)]"
                  : "border-zinc-800 bg-black/40 hover:border-zinc-600 hover:bg-zinc-950",
                disabled && "cursor-not-allowed opacity-40 hover:border-zinc-800 hover:bg-black/40",
              )}
            >
              {selected && (
                <div className="absolute right-0 top-0 flex size-12 items-start justify-end overflow-hidden">
                  <div className="absolute right-0 top-0 size-12 bg-blue-500 [clip-path:polygon(100%_0,0_0,100%_100%)]" />
                  <Check className="relative z-10 mr-1.5 mt-1.5 size-4 text-white" />
                </div>
              )}
              <div className={clsx("text-base font-semibold", selected ? "text-white" : "text-zinc-100")}>{t(analyst.labelKey)}</div>
              <div className={clsx("mt-2 text-sm leading-6", selected ? "text-zinc-300" : "text-zinc-500")}>{t(analyst.descriptionKey)}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
