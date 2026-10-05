import type { ReportVersion, SystemLanguage } from "@/lib/types";
import { copyExportMemory, memoryAbsent, memoryNotice, memorySummary } from "./export";
import { fencedJson } from "@/features/report-export/lib/markdown-fence";

const html = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const cell = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("`", "\\`").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>");
export function renderMemoryHtml(version: ReportVersion, language: SystemLanguage) {
  const memory = copyExportMemory(version); const title = language === "zh" ? "不可变研究记忆与评估附录" : "Immutable research memory and evaluation appendix";
  if (!memory.bundle) return `<section id="memory-appendix"><h2>${title}</h2><p>${html(memory.invalid ? `Invalid memory attachment: ${memory.invalid}` : memoryAbsent(language))}</p></section>`;
  const bundle = memory.bundle;
  const table = (rows: [string, string][]) => `<table><tbody>${rows.map(([key, value]) => `<tr><th>${html(key)}</th><td>${html(value)}</td></tr>`).join("")}</tbody></table>`;
  return `<section id="memory-appendix"><h2>${title}</h2><p>${html(memoryNotice(language))}</p><h3>${language === "zh" ? "生成时保存的决策与输入" : "Decision and input saved at generation"}</h3>${table(memorySummary(bundle, bundle.decision_snapshot, language))}<p>Bundle SHA-256: ${bundle.bundle_sha256}</p><h3>${language === "zh" ? "确切的历史记忆输入" : "Exact prior memory input"}</h3><pre>${html(bundle.input_snapshot.context_artifact.payload)}</pre>${memory.reviews.map((review) => `<h3>${language === "zh" ? "后续评估审阅" : "Later evaluation review"} · ${review.reviewed_at}</h3>${table(memorySummary(bundle, review.snapshot, language))}`).join("")}<h3>${language === "zh" ? "完整记忆包（含所有内容）" : "Complete memory bundle (all payloads included)"}</h3><pre id="memory-bundle-json">${html(JSON.stringify(bundle, null, 2))}</pre><h3>${language === "zh" ? "完整后续评估附件" : "Complete later evaluation attachments"}</h3><pre id="evaluation-reviews-json">${html(JSON.stringify(memory.reviews, null, 2))}</pre></section>`;
}
export function renderMemoryMarkdown(version: ReportVersion, language: SystemLanguage) {
  const memory = copyExportMemory(version); const title = language === "zh" ? "不可变研究记忆与评估附录" : "Immutable research memory and evaluation appendix";
  if (!memory.bundle) return `\n## ${title}\n\n${memory.invalid ? `Invalid memory attachment: ${memory.invalid}` : memoryAbsent(language)}\n`;
  const bundle = memory.bundle;
  const table = (rows: [string, string][]) => `| Metadata | Value |\n| --- | --- |\n${rows.map(([key, value]) => `| ${cell(key)} | ${cell(value)} |`).join("\n")}`;
  return [`\n## ${title}`, memoryNotice(language), `### ${language === "zh" ? "生成时保存的决策与输入" : "Decision and input saved at generation"}`, table(memorySummary(bundle, bundle.decision_snapshot, language)), `Bundle SHA-256: ${bundle.bundle_sha256}`, ...memory.reviews.flatMap((review) => [`### ${language === "zh" ? "后续评估审阅" : "Later evaluation review"} · ${review.reviewed_at}`, table(memorySummary(bundle, review.snapshot, language))]), `### ${language === "zh" ? "完整记忆包（含所有内容）" : "Complete memory bundle (all payloads included)"}`, fencedJson(bundle), `### ${language === "zh" ? "完整后续评估附件" : "Complete later evaluation attachments"}`, fencedJson(memory.reviews), ""].join("\n\n");
}
