"use client";
import { useEffect, useState } from "react";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import { verifyIdentityOwner } from "../lib/validation";
type Owner = AnalysisTask | ReportVersion;
export function useIdentityCheck(owner: Owner) {
  const [checked, setChecked] = useState<{ input: Owner; saved: Owner }>();
  useEffect(() => {
    let active = true;
    void verifyIdentityOwner(owner).then((saved) => {
      if (active) setChecked({ input: owner, saved });
    });
    return () => {
      active = false;
    };
  }, [owner]);
  const saved = checked?.input === owner ? checked.saved : undefined;
  return {
    saved,
    status: !saved
      ? "checking"
      : saved.identityValidation
        ? "invalid"
        : saved.effectiveRequestIdentity
          ? "verified"
          : "absent",
  } as const;
}
