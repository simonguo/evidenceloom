import { ChevronRight, Scale } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import type { SystemLanguage } from "@/lib/types";
import { localizedDecision } from "../utils";

type DecisionSummaryCardProps = {
  decision: string;
  error: string;
  language: SystemLanguage;
  hasDetails: boolean;
  onOpen: () => void;
};

export function DecisionSummaryCard({ decision, error, language, hasDetails, onOpen }: DecisionSummaryCardProps) {
  const t = createTranslator(language);
  const content = (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-zinc-800 bg-black text-zinc-200">
            <Scale className="size-4" />
          </span>
          <div>
            <div className="text-sm font-semibold text-white">{t("finalDecision")}</div>
            {hasDetails && <div className="mt-0.5 text-xs text-zinc-500">{t("decisionDetails")}</div>}
          </div>
        </div>
        {hasDetails && <ChevronRight className="size-4 shrink-0 text-zinc-500 transition group-hover:translate-x-0.5 group-hover:text-zinc-200" />}
      </div>
      <p className="mt-3 text-sm leading-6 text-zinc-300">{localizedDecision(decision, language) || t("waitingDecision")}</p>
      {error && (
        <div className="mt-3 rounded-md border border-red-900/60 bg-red-950/20 px-3 py-2 text-sm leading-6 text-red-200">
          {error}
        </div>
      )}
    </>
  );
  const className = "group w-full rounded-lg border border-zinc-900 bg-zinc-950/50 p-4 text-left transition";

  if (!hasDetails) return <div className={className}>{content}</div>;

  return (
    <button type="button" onClick={onOpen} aria-label={t("openDecisionDetails")} className={`${className} hover:border-zinc-700 hover:bg-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-600`}>
      {content}
    </button>
  );
}
