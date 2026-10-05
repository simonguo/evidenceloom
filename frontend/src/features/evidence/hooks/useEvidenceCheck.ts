"use client";

import { useEffect, useState } from "react";
import type { EvidenceBundle, EvidenceCheck, EvidenceValidation } from "../types";
import { invalidEvidence, verifyEvidenceBundle } from "../lib/validation";

export function useEvidenceCheck(bundle: EvidenceBundle | undefined, invalid: EvidenceValidation | undefined, reports?: Record<string, string | null>) {
  const [check, setCheck] = useState<EvidenceCheck>({ status: bundle ? "checking" : "unknown" });
  useEffect(() => {
    let active = true;
    if (!bundle) { setCheck(invalid ?? { status: "unknown" }); return; }
    setCheck({ status: "checking" });
    void verifyEvidenceBundle(bundle, reports).then(() => {
      if (active) setCheck({ status: "verified" });
    }).catch((error) => { if (active) setCheck(invalidEvidence(error)); });
    return () => { active = false; };
  }, [bundle, invalid, reports]);
  return check;
}
