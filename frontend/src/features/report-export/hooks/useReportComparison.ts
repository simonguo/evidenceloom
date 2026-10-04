"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReportVersion } from "@/lib/types";
import type { ComparisonSelection } from "../comparison-types";
import { hasDuplicateVersionIds, hasSelectableVersionId, newestReportVersions, resolveComparisonSelection } from "../lib/comparison";

export function useReportComparison(taskId: string, reportVersions: readonly ReportVersion[]) {
  const versions = useMemo(() => newestReportVersions(reportVersions.filter(hasSelectableVersionId)), [reportVersions]);
  const unavailableIds = reportVersions.some((version) => !hasSelectableVersionId(version));
  const ambiguous = hasDuplicateVersionIds(versions);
  const [savedSelection, setSavedSelection] = useState<ComparisonSelection>(() => resolveComparisonSelection(taskId, ambiguous ? [] : versions));
  const selection = resolveComparisonSelection(taskId, versions, savedSelection);
  const { baselineId, targetId } = selection;

  useEffect(() => {
    if (ambiguous) return;
    setSavedSelection((previous) => previous.taskId === taskId
      && previous.baselineId === baselineId && previous.targetId === targetId
      ? previous : { taskId, baselineId, targetId });
  }, [taskId, baselineId, targetId, ambiguous]);

  return {
    versions,
    ambiguous,
    unavailableIds,
    baseline: versions.find((version) => version.id === selection.baselineId),
    target: versions.find((version) => version.id === selection.targetId),
    baselineId: selection.baselineId,
    targetId: selection.targetId,
    selectBaseline: (id: string) => setSavedSelection({ ...selection, baselineId: id }),
    selectTarget: (id: string) => setSavedSelection({ ...selection, targetId: id }),
  };
}
