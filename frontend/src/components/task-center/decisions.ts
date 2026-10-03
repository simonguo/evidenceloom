import type { AnalysisEvent } from "@/lib/types";

const ratings = ["Buy", "Overweight", "Hold", "Underweight", "Sell", "REVIEW"] as const;
const chineseRatings: Record<string, string> = {
  买入: "Buy", 看多: "Buy", 超配: "Overweight", 增持: "Overweight", 加仓: "Overweight",
  持有: "Hold", 观望: "Hold", 中性: "Hold", 低配: "Underweight", 减持: "Underweight",
  卖出: "Sell", 清仓: "Sell", 看空: "Sell", 待复核: "REVIEW",
};
const ratingLine = /^\s*(?:\d+[.)]\s+)?[*_#\s]*(?:(?:final|our)\s+rating|rating|(?:最终|建议|组合)?评级|最终(?:交易)?决策|交易决策|决策|建议)[*_\s]*[:\-\u2010-\u2015][*_\s]*(.+)$/i;
const englishRating = /\b(Buy|Overweight|Hold|Underweight|Sell|REVIEW)\b/gi;
const chineseRating = new RegExp(Object.keys(chineseRatings).join("|"), "g");

function hasAmbiguousRating(value: string): boolean {
  const clause = value.split(/[:：;；.。]|\s+[-–—]\s+/, 1)[0];
  const choices = new Set([
    ...Array.from(clause.matchAll(englishRating), (match) => normalizeRating(match[0])),
    ...Array.from(clause.matchAll(chineseRating), (match) => chineseRatings[match[0]]),
  ]);
  return choices.size > 1;
}

export function normalizeRating(value: unknown): string {
  if (typeof value !== "string") return "";
  return ratings.find((rating) => rating.toLowerCase() === value.trim().toLowerCase()) ?? "";
}

export function extractDecisionFromReport(report: string | null | undefined): string {
  if (!report?.trim()) return "";
  for (const line of report.normalize("NFKC").split(/\r?\n/)) {
    const value = line.match(ratingLine)?.[1]?.trim();
    if (!value) continue;
    const english = value.match(/^(Buy|Overweight|Hold|Underweight|Sell|REVIEW)\b/i)?.[1];
    const chinese = Object.keys(chineseRatings).find((label) => value.startsWith(label));
    if ((english || chinese) && hasAmbiguousRating(value)) return "";
    if (english) return normalizeRating(english).toLowerCase();
    if (chinese) return chineseRatings[chinese].toLowerCase();
  }
  return "";
}

export function resolveTaskDecision(
  stored: string, report: string | null | undefined, event?: AnalysisEvent,
): string {
  // The backend owns its final rating. A quoted rating in prose cannot replace
  // it, including when the backend explicitly flags the decision for review.
  const backend = event?.decision?.trim() ? event.decision : event?.finalState?.final_rating;
  if (typeof backend === "string" && backend.trim()) return normalizeRating(backend) || "REVIEW";
  return normalizeRating(stored) || normalizeRating(extractDecisionFromReport(report))
    || (event?.type === "completed" ? "REVIEW" : "");
}
