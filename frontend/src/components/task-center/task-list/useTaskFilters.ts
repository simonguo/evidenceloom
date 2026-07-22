"use client";

import { useMemo, useState } from "react";
import type { AnalysisTask } from "@/lib/types";

export type DecisionFilter = "all" | "buy" | "overweight" | "hold" | "underweight" | "sell" | "none";

export function useTaskFilters(tasks: AnalysisTask[]) {
  const [query, setQuery] = useState("");
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all");

  const filteredTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return tasks.filter((task) => {
      const matchesQuery = !normalizedQuery || [task.ticker, task.instrumentName, task.analysisDate]
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
      const decision = normalizeDecision(task.decision);
      const matchesDecision = decisionFilter === "all"
        || (decisionFilter === "none" ? !decision : decision === decisionFilter);
      return matchesQuery && matchesDecision;
    });
  }, [decisionFilter, query, tasks]);

  return {
    query,
    setQuery,
    decisionFilter,
    setDecisionFilter,
    filteredTasks,
  };
}

function normalizeDecision(decision: string) {
  const normalized = decision.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return ["buy", "overweight", "hold", "underweight", "sell"].includes(normalized) ? normalized : "";
}
