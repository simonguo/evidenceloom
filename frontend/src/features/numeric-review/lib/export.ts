import type { ReportVersion } from "@/lib/types";
import { clone } from "@/features/memory/lib/guards";
import { copyNumericHistory, verifyNumericHistory } from "./history";
import { bindReportSnapshot, copyReportTextSnapshot, verifyReportTextSnapshot } from "./snapshot";
import { NumericError } from "./guards";
export function copyNumericExport(taskId: string, version: ReportVersion) {
    if (version.numericValidation)
        throw new NumericError(version.numericValidation.reason);
    if (!version.reportTextSnapshot) {
        if (version.numericReviews?.length)
            throw new NumericError("reference_mismatch");
        return { report_text_snapshot: null, numeric_reviews: [] };
    }
    const snapshot = copyReportTextSnapshot(version.reportTextSnapshot, version.evidenceBundle);
    bindReportSnapshot(version, snapshot);
    return { report_text_snapshot: snapshot, numeric_reviews: copyNumericHistory(version.numericReviews ?? [], snapshot, version.evidenceBundle!, { taskId, versionId: version.id }) };
}
export async function verifiedNumericExport(taskId: string, version: ReportVersion): Promise<ReportVersion> {
    const frozen = clone(version), attachment = copyNumericExport(taskId, frozen);
    if (!attachment.report_text_snapshot)
        return frozen;
    const snapshot = await verifyReportTextSnapshot(attachment.report_text_snapshot, frozen.evidenceBundle);
    return { ...frozen, reportTextSnapshot: snapshot, numericReviews: await verifyNumericHistory(attachment.numeric_reviews, snapshot, frozen.evidenceBundle!, { taskId, versionId: frozen.id }) };
}
