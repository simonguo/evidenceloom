"use client";

import { useEffect, useState } from "react";
import type { ReportVersion } from "@/lib/types";
import { verifyEvidenceBundle } from "@/features/evidence/lib/validation";
import { savedReportCitations, type SavedReportCitations } from "../lib/saved-report-citations";

type VerifiedSelection = {
  taskId: string;
  versionId: string;
  runId: string;
  ticker: string;
  analysisDate: string;
  bundle: ReportVersion["evidenceBundle"];
  reports: ReportVersion["reportSections"];
  citations: SavedReportCitations;
};

export function useSavedReportCitations(taskId: string, version: ReportVersion): SavedReportCitations | undefined {
  const bundle = version.evidenceBundle;
  const reports = version.reportSections;
  const invalid = version.evidenceValidation;
  const versionId = version.id;
  const runId = version.runId;
  const ticker = version.task?.ticker;
  const analysisDate = version.task?.analysisDate;
  const [verified, setVerified] = useState<VerifiedSelection>();

  useEffect(() => {
    let active = true;
    setVerified(undefined);
    if (taskId && versionId && bundle && !invalid && bundle.run_id === runId
      && bundle.instrument === ticker && bundle.analysis_date === analysisDate) {
      void verifyEvidenceBundle(bundle, reports).then((checked) => {
        if (active) setVerified({ taskId, versionId, runId, ticker, analysisDate, bundle, reports,
          citations: savedReportCitations(taskId, versionId, checked) });
      }).catch(() => { if (active) setVerified(undefined); });
    }
    return () => { active = false; };
  }, [taskId, versionId, runId, ticker, analysisDate, bundle, reports, invalid]);

  // Effects reset after render. Bind synchronously so an old verified frame cannot
  // enable links for a new selection, bundle, or arriving live report.
  if (invalid || !verified || verified.taskId !== taskId || verified.versionId !== versionId
    || verified.runId !== runId || verified.ticker !== ticker || verified.analysisDate !== analysisDate
    || verified.bundle !== bundle || verified.reports !== reports) return undefined;
  return verified.citations;
}
