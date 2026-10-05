import type { EvidenceBundle } from "@/features/evidence/types";
import { citationReferences, copyEvidenceBundle, sha256 } from "@/features/evidence/lib/validation";
import type { NumericReview, ReportTextSnapshot } from "../types";
import { checkHash, fixed, requireNumeric, utf8Sha } from "./guards";
import { numericPolicy, numericPolicyHash } from "./policy";
import { copySnapshotAgainstEvidence } from "./snapshot";
import { prepareSourceResolver } from "./source";
import { prepareSectionSpans, type SectionSpans } from "./spans";
const preparedInputs = new WeakSet<object>();
function freeze<T>(value: T): T {
    if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
    }
    return value;
}
/** Private operation lifetime: captured copies, no global or persistent cache. */
export function prepareNumericInput(snapshotValue: unknown, evidenceValue: unknown) {
    try {
        const evidence: EvidenceBundle = freeze(copyEvidenceBundle(evidenceValue));
        const snapshot: ReportTextSnapshot = freeze(copySnapshotAgainstEvidence(snapshotValue, evidence));
        const source = prepareSourceResolver(evidence), sections = new Map<string, SectionSpans>(), sectionHashes = new Map<string, Promise<string>>();
        let verified: Promise<void> | undefined, policyHash: Promise<void> | undefined;
        function section(key: string) {
            let spans = sections.get(key);
            if (!spans) {
                requireNumeric(typeof snapshot.report_sections[key] === "string", "reference_mismatch");
                spans = prepareSectionSpans(snapshot.report_sections[key]!);
                Object.freeze(spans);
                sections.set(key, spans);
            }
            return spans;
        }
        function sectionHash(key: string) {
            let hash = sectionHashes.get(key);
            if (!hash) {
                requireNumeric(typeof snapshot.report_sections[key] === "string", "reference_mismatch");
                hash = utf8Sha(snapshot.report_sections[key]!);
                sectionHashes.set(key, hash);
            }
            return hash;
        }
        function verifyPolicy() {
            return policyHash ??= sha256(numericPolicy).then((hash) => requireNumeric(hash === numericPolicyHash, "reference_mismatch")).catch(fixed);
        }
        function verify() {
            return verified ??= (async () => {
                try {
                    await Promise.all([checkHash(evidence as unknown as Record<string, unknown>, "bundle_sha256"), checkHash(snapshot as unknown as Record<string, unknown>, "snapshot_sha256"),
                        sha256(evidence.manifest).then((hash) => requireNumeric(hash === evidence.manifest_sha256, "hash_mismatch")),
                        ...Object.entries(evidence.artifacts).map(([hash, artifact]) => sha256(artifact).then((actual) => requireNumeric(actual === hash, "hash_mismatch"))), verifyPolicy()]);
                    for (const [key, report] of Object.entries(snapshot.report_sections)) {
                        const actual = citationReferences(report ?? "").sort(), recorded = evidence.citation_audit[key]?.referenced_ids ?? [];
                        requireNumeric(JSON.stringify(actual) === JSON.stringify([...recorded].sort()));
                    }
                }
                catch (error) {
                    fixed(error);
                }
            })();
        }
        async function verifyReceipt(review: NumericReview) {
            await Promise.all([checkHash(review as unknown as Record<string, unknown>, "review_sha256"), verifyPolicy(), sectionHash(review.target.section_key).then((hash) => requireNumeric(hash === review.target.section_utf8_sha256, "reference_mismatch"))]);
        }
        const prepared = Object.freeze({ evidence, snapshot, source, section, sectionHash, verify, verifyReceipt });
        preparedInputs.add(prepared);
        return prepared;
    }
    catch (error) {
        return fixed(error);
    }
}
export type PreparedNumericInput = ReturnType<typeof prepareNumericInput>;
export function assertPreparedNumericInput(value: unknown): asserts value is PreparedNumericInput {
    requireNumeric(typeof value === "object" && value !== null && preparedInputs.has(value), "reference_mismatch");
}
