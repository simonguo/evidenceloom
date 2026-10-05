import type { ReportVersion, SystemLanguage } from "@/lib/types";
import { fencedJson } from "@/features/report-export/lib/markdown-fence";
import { checkLabel, readinessAbsent, readinessNotice, readinessSummary } from "./display";
import { copyExportReadiness } from "./export";

const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const escapeTable = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", "<br>").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function renderReadinessMarkdown(version: ReportVersion, language: SystemLanguage) {
  const title = language === "zh" ? "研究输入检查附录" : "Research input-check appendix"; const bundle = copyExportReadiness(version);
  if (!bundle) return `\n## ${title}\n\n${readinessAbsent(language)}\n`;
  const metadata = readinessSummary(bundle, language).map(([label, value]) => `| ${escapeTable(label)} | ${escapeTable(value)} |`).join("\n");
  const checks = bundle.checks.map((input) => `- ${checkLabel(input.key, language)}: ${input.status} (${input.required ? "required" : "advisory"}) · ${input.reason_codes.join(", ") || "none"}`).join("\n");
  return `\n## ${title}\n\n${readinessNotice(language)}\n\n| Metadata | Value |\n| --- | --- |\n${metadata}\n\n${checks}\n\n${fencedJson(bundle)}\n`;
}
export function renderReadinessHtml(version: ReportVersion, language: SystemLanguage) {
  const title = language === "zh" ? "研究输入检查附录" : "Research input-check appendix"; const bundle = copyExportReadiness(version);
  if (!bundle) return `<section id="research-readiness"><h2>${title}</h2><p>${readinessAbsent(language)}</p></section>`;
  const metadata = readinessSummary(bundle, language).map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("");
  const checks = bundle.checks.map((input) => `<li>${escapeHtml(checkLabel(input.key, language))}: ${input.status} (${input.required ? "required" : "advisory"}) · ${escapeHtml(input.reason_codes.join(", ") || "none")}</li>`).join("");
  return `<section id="research-readiness"><h2>${title}</h2><p>${escapeHtml(readinessNotice(language))}</p><table class="metadata">${metadata}</table><ul>${checks}</ul><pre id="research-readiness-json">${escapeHtml(JSON.stringify(bundle, null, 2))}</pre></section>`;
}
