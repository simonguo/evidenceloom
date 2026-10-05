"use client";
import { useEffect, useRef, useState } from "react";
import type { ReportVersion, SystemLanguage } from "@/lib/types";
import type { ContextBindings, NumericReview, TableSelector, TextSpan } from "../types";
import { verifiedNumericExport } from "../lib/export";
import { createNumericReview } from "../lib/validation";
import { utf8Sha } from "../lib/guards";
import { invalidNumeric } from "../lib/snapshot";
export type NumericReviewDraft = {
    sectionKey: string;
    numericSpan: TextSpan;
    operand: {
        evidenceId: string;
        sourceIndex: number;
        selector: TableSelector;
    };
    contexts: ContextBindings;
    places: number;
};
export function useNumericReview(taskId: string, version: ReportVersion, language: SystemLanguage, onSave?: (taskId: string, versionId: string, reviews: NumericReview[], action?: unknown) => Promise<void>, beginReview?: () => unknown) {
    const [state, setState] = useState<{
        version: ReportVersion;
        verified?: ReportVersion;
        reason?: string;
    }>({ version });
    const [preview, setPreview] = useState<NumericReview | null>(null), [pending, setPending] = useState(false), [message, setMessage] = useState("");
    const current = useRef(version);
    current.current = version;
    const generation = useRef(0), zh = language === "zh";
    const previewAction = useRef<unknown>(undefined);
    useEffect(() => {
        let active = true;
        generation.current++;
        setPreview(null);
        previewAction.current = undefined;
        setPending(false);
        setMessage("");
        void verifiedNumericExport(taskId, version).then((verified) => { if (active)
            setState({ version, verified }); }).catch((error) => { if (active)
            setState({ version, reason: invalidNumeric(error).reason }); });
        return () => { active = false; };
    }, [taskId, version]);
    const verified = state.version === version ? state.verified : undefined;
    async function compare(draft: NumericReviewDraft) {
        if (!verified?.reportTextSnapshot || !verified.evidenceBundle || pending)
            return;
        const frozen = structuredClone(verified), requestGeneration = generation.current;
        setPending(true);
        setMessage("");
        setPreview(null);
        try {
            const action = beginReview?.();
            const snapshot = frozen.reportTextSnapshot!, section = snapshot.report_sections[draft.sectionKey]!;
            const review = await createNumericReview(snapshot, frozen.evidenceBundle!, {
                review_id: crypto.randomUUID(), reviewed_at: new Date().toISOString().replace(/([0-9]{3})Z$/, "$1000Z"), previous_review_sha256: frozen.numericReviews?.at(-1)?.review_sha256 ?? null,
                target: { task_id: taskId, version_id: frozen.id, run_id: snapshot.run_id, report_snapshot_sha256: snapshot.snapshot_sha256, section_key: draft.sectionKey, section_utf8_sha256: await utf8Sha(section) },
                numeric_span: structuredClone(draft.numericSpan), operand: { evidence_id: draft.operand.evidenceId, source_index: draft.operand.sourceIndex, selector: structuredClone(draft.operand.selector) },
                rounding: { mode: "saved_decimal_half_up", places: draft.places }, context_bindings: structuredClone(draft.contexts),
            });
            if (current.current === version && generation.current === requestGeneration) {
                previewAction.current = action;
                setPreview(review);
            }
        }
        catch (error) {
            if (current.current === version && generation.current === requestGeneration)
                setMessage(`${zh ? "审阅无法验证" : "Review could not be verified"}: ${invalidNumeric(error).reason}`);
        }
        finally {
            if (current.current === version)
                setPending(false);
        }
    }
    async function save() {
        if (!preview || !onSave || pending)
            return;
        const frozen = structuredClone(preview), owner = version, requestGeneration = generation.current;
        setPending(true);
        setMessage("");
        try {
            if (beginReview) await onSave(taskId, owner.id, [frozen], previewAction.current);
            else await onSave(taskId, owner.id, [frozen]);
            if (current.current.id === owner.id && generation.current === requestGeneration) {
                setPreview(null);
                setMessage(zh ? "数值字段审阅已保存。" : "Saved numeric field review.");
            }
        }
        catch {
            if (current.current.id === owner.id && generation.current === requestGeneration)
                setMessage(zh ? "数值审阅保存失败；附件尚未确认持久保存。" : "Numeric review could not be saved. The attachment is not confirmed durable.");
        }
        finally {
            if (current.current.id === owner.id)
                setPending(false);
        }
    }
    return { verified, reason: state.version === version ? state.reason : undefined, preview, pending, message, compare, save, clearPreview: () => { generation.current++; previewAction.current = undefined; setPreview(null); } };
}
