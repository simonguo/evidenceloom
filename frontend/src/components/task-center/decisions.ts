import type { AnalysisEvent } from "@/lib/types";

const ratings = ["Buy", "Overweight", "Hold", "Underweight", "Sell", "REVIEW"] as const;
const chineseRatings: Record<string, string> = {
  买入: "Buy", 看多: "Buy", 超配: "Overweight", 增持: "Overweight", 加仓: "Overweight",
  持有: "Hold", 观望: "Hold", 中性: "Hold", 低配: "Underweight", 减持: "Underweight",
  卖出: "Sell", 清仓: "Sell", 看空: "Sell", 待复核: "REVIEW",
};
// Python's Unicode whitespace, decimal numbering and word boundaries differ
// from JavaScript's ASCII \d/\b and its treatment of BOM as whitespace.
const space = "\\p{White_Space}\\u001C-\\u001F";
const word = "[\\p{L}\\p{N}_]";
const englishValues = "Buy|Overwe[iİı]ght|Hold|Underwe[iİı]ght|Sell|REV[iİı]EW";
const ratingLine = new RegExp(`^[${space}]*(?:\\p{Nd}+[.)][${space}]+)?[*_#${space}]*(?:(?:f[iİı]nal|our)[${space}]+rat[iİı]ng|rat[iİı]ng|(?:最终|建议|组合)?评级|最终(?:交易)?决策|交易决策|决策|建议)[*_${space}]*[:\\-\\u2010-\\u2015][*_${space}]*(.+)$`, "iu");
const englishRating = new RegExp(`(?<!${word})(${englishValues})(?!${word})`, "giu");
const initialEnglishRating = new RegExp(`^(${englishValues})(?!${word})`, "iu");
const explanation = new RegExp(`[${space}]+[\\-\\u2013\\u2014][${space}]+|[:：;；.。]`, "u");
const edgeSpace = new RegExp(`^[${space}]+|[${space}]+$`, "gu");
const chineseRating = new RegExp(Object.keys(chineseRatings).join("|"), "g");

function hasAmbiguousRating(value: string): boolean {
  const clause = value.split(explanation, 1)[0];
  const choices = new Set([
    ...Array.from(clause.matchAll(englishRating), (match) => normalizeRating(match[0])),
    ...Array.from(clause.matchAll(chineseRating), (match) => chineseRatings[match[0]]),
  ]);
  return choices.size > 1;
}

export function normalizeRating(value: unknown): string {
  if (typeof value !== "string") return "";
  return ratings.find((rating) => rating.toLowerCase() === value.replace(edgeSpace, "").toLowerCase()) ?? "";
}

export function extractDecisionFromReport(report: string | null | undefined): string {
  if (!report?.trim()) return "";
  // eslint-disable-next-line no-control-regex -- Match the saved Python/Rust splitlines contract, including Unicode line separators.
  for (const line of report.normalize("NFKC").split(/[\n\r\u000B\u000C\u0085\u2028\u2029\u001C\u001D\u001E]/)) {
    const value = line.match(ratingLine)?.[1]?.replace(edgeSpace, "");
    if (!value) continue;
    const english = value.match(initialEnglishRating)?.[1];
    const chinese = Object.keys(chineseRatings).find((label) => value.startsWith(label));
    if (hasAmbiguousRating(value)) return "";
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
