"use client";
import { useEffect, useState } from "react";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import { verifySavedReadiness } from "../lib/validation";

export function useReadinessCheck(snapshot: AnalysisTask | ReportVersion) {
  const [state, setState] = useState<{ source?: AnalysisTask | ReportVersion; saved?: AnalysisTask | ReportVersion; status: "checking" | "verified" | "unknown" | "invalid"; reason?: string }>({ status: "checking" });
  useEffect(() => {
    let active = true;
    void verifySavedReadiness(snapshot).then((saved) => {
      if (active) setState({ source: snapshot, saved, status: saved.readinessValidation ? "invalid" : saved.researchReadiness ? "verified" : "unknown", reason: saved.readinessValidation?.reason });
    }).catch(() => { if (active) setState({ source: snapshot, status: "invalid", reason: "verification_unavailable" }); });
    return () => { active = false; };
  }, [snapshot]);
  return state.source === snapshot ? state : { status: "checking" as const, saved: undefined, reason: undefined };
}
