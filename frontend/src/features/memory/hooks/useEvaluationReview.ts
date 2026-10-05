"use client";
import { useState } from "react";
import type { GlobalSettings, ReportVersion, SystemLanguage } from "@/lib/types";
import type { ReviewAttachment } from "../types";
import { getRuntimeAdapter } from "@/lib/runtime";
import { verifyMemoryBundle, verifyReviewAttachment } from "../lib/validation";

export function useEvaluationReview(version: ReportVersion | undefined, language: SystemLanguage, settings?: GlobalSettings, onReviews?: (versionId: string, reviews: ReviewAttachment[], action?: unknown) => Promise<void>, beginReview?: () => unknown) {
  const [pending, setPending] = useState<string | null>(null); const [result, setResult] = useState({ versionId: "", message: "" });
  async function refresh() {
    if (!version?.memoryBundle || !onReviews || pending) return;
    const setMessage = (message: string) => setResult({ versionId: version.id, message });
    setPending(version.id); setMessage("");
    const frozen = JSON.parse(JSON.stringify(version)) as ReportVersion;
    try {
      const action = beginReview?.();
      if (frozen.memoryValidation) throw new Error();
      const completion = await verifyMemoryBundle(frozen.memoryBundle, frozen.evidenceBundle);
      if (completion.persistence_status !== "durable") { setMessage(language === "zh" ? "此版本仅保存在内存中；没有可读取的持久化评估。" : "This version was memory-only; no durable evaluation is available."); return; }
      const inventory = await getRuntimeAdapter().getResearchMemoryInventory({ decisionIds: [completion.run_id], pythonPath: settings?.pythonPath, projectRoot: settings?.projectRoot });
      if (inventory.missing_ids.length) { setMessage(language === "zh" ? "此决策未找到持久化记录；原始报告输入保持不变。" : "No durable record was found for this decision; original report input remains unchanged."); return; }
      const reviews = await Promise.all(inventory.reviews.map((review) => verifyReviewAttachment(review, completion)));
      if (beginReview) await onReviews(frozen.id, reviews, action);
      else await onReviews(frozen.id, reviews);
      setMessage(language === "zh" ? "已读取保存的评估附件；没有重新获取行情或重算。" : "Loaded saved evaluation attachments without fetching prices or re-evaluating.");
    } catch { setMessage(language === "zh" ? "无法核验或读取保存的评估；运行器可能不支持此功能。原始附件保持不变。" : "Saved evaluations could not be read or verified; the runner may not support this feature. Original attachments remain unchanged."); }
    finally { setPending(null); }
  }
  return { loading: pending === version?.id, message: result.versionId === version?.id ? result.message : "", refresh };
}
