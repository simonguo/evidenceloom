import { Search, X } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import type { SystemLanguage } from "@/lib/types";
import { localizedDecision } from "../utils";
import type { DecisionFilter } from "./useTaskFilters";

type TaskListFiltersProps = {
  query: string;
  decisionFilter: DecisionFilter;
  resultCount: number;
  totalCount: number;
  language: SystemLanguage;
  onQueryChange: (query: string) => void;
  onDecisionChange: (decision: DecisionFilter) => void;
};

const decisions: Exclude<DecisionFilter, "all" | "none">[] = ["buy", "overweight", "hold", "underweight", "sell"];

export function TaskListFilters({ query, decisionFilter, resultCount, totalCount, language, onQueryChange, onDecisionChange }: TaskListFiltersProps) {
  const t = createTranslator(language);

  return (
    <div className="flex flex-col gap-3 border-b border-zinc-900 px-5 py-3 sm:flex-row sm:items-center">
      <label className="relative min-w-0 flex-1">
        <span className="sr-only">{t("taskSearch")}</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-600" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("taskSearchPlaceholder")}
          className="h-10 w-full rounded-md border border-zinc-800 bg-black pl-9 pr-9 text-sm text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-600"
        />
        {query && (
          <button type="button" onClick={() => onQueryChange("")} title={t("clearSearch")} aria-label={t("clearSearch")} className="absolute right-2 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-900 hover:text-white">
            <X className="size-3.5" />
          </button>
        )}
      </label>

      <label className="flex items-center">
        <span className="sr-only">{t("decision")}</span>
        <select value={decisionFilter} onChange={(event) => onDecisionChange(event.target.value as DecisionFilter)} className="h-10 min-w-36 rounded-md border border-zinc-800 bg-black px-3 text-sm text-zinc-300 outline-none focus:border-zinc-600">
          <option value="all">{t("allDecisions")}</option>
          {decisions.map((decision) => <option key={decision} value={decision}>{localizedDecision(decision, language)}</option>)}
          <option value="none">{t("noDecision")}</option>
        </select>
      </label>

      <span className="shrink-0 text-xs text-zinc-600">{t("filteredTasks", { count: resultCount, total: totalCount })}</span>
    </div>
  );
}
