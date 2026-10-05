import type { ReportVersion } from "@/lib/types";
import { copyResearchReadiness, ReadinessError, verifySavedReadiness } from "./validation";

export function copyExportReadiness(version: ReportVersion) {
  if (version.readinessValidation) throw new ReadinessError(version.readinessValidation.reason);
  return version.researchReadiness ? copyResearchReadiness(version.researchReadiness, version.evidenceBundle) : undefined;
}
export async function verifiedReadinessExport(version: ReportVersion) {
  const safe = await verifySavedReadiness(version);
  if (safe.readinessValidation) throw new ReadinessError(safe.readinessValidation.reason);
  return safe;
}
