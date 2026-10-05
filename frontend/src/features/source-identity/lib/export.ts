import type { ReportVersion } from "@/lib/types";
import { clone } from "@/features/memory/lib/guards";
import { IdentityError } from "./guards";
import {
  bindIdentityOwner,
  copyEffectiveRequestIdentity,
  verifyEffectiveRequestIdentity,
} from "./validation";
export function copyExportIdentity(version: ReportVersion) {
  if (version.identityValidation) throw new IdentityError(version.identityValidation.reason);
  bindIdentityOwner(version);
  if (version.effectiveRequestIdentity === undefined) return null;
  return copyEffectiveRequestIdentity(
    version.effectiveRequestIdentity,
    version.evidenceBundle,
    version.reportTextSnapshot,
  );
}
export async function verifiedIdentityExport(version: ReportVersion): Promise<ReportVersion> {
  const frozen = clone(version),
    assessment = copyExportIdentity(frozen);
  if (!assessment) return frozen;
  return bindIdentityOwner({
    ...frozen,
    effectiveRequestIdentity: await verifyEffectiveRequestIdentity(
      assessment,
      frozen.evidenceBundle,
      frozen.reportTextSnapshot,
    ),
  });
}
