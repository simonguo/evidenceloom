import type { ReportDocument } from "../types";
import { evidenceAbsent, evidenceNotice, linkEvidenceCitations } from "@/features/evidence/lib/export";

export function renderReportMarkdown(document: ReportDocument) {
  const invalid = document.evidence.invalid ?? document.version.evidenceValidation;
  if (invalid) document = { ...document, evidence: { invalid } };
  const warning = document.fictionalNotice
    ? `> **${escapeInline(document.fictionalNotice)}**\n\n`
    : "";
  const metadata = document.metadata
    .map(([label, value]) => `| ${escapeTable(label)} | ${escapeTable(value)} |`)
    .join("\n");
  const sections = document.sections
    .map((section, index) => `## ${index + 1}. ${section.title}\n\n${linkEvidenceCitations(section.content, document.evidence.bundle)}`)
    .join("\n\n");
  const quality = document.outputQuality;
  const qualityEntries = quality.entries.length
    ? quality.entries.map((entry) => [
      `- **${entry.agent}: ${entry.status}** — ${entry.schema} · ${entry.source}`,
      ...(entry.reason ? [`  ${entry.reason}`] : []),
    ].join("\n")).join("\n\n")
    : quality.emptyMessage;

  return [
    `# ${escapeInline(document.title)}`,
    "",
    warning.trimEnd(),
    `> ${escapeInline(document.disclaimer)}`,
    "",
    "| Metadata | Value |",
    "| --- | --- |",
    metadata,
    "",
    `## ${quality.title}`,
    "",
    quality.disclaimer,
    "",
    qualityEntries,
    "",
    sections,
    renderEvidenceAppendix(document),
    "",
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
}

function renderEvidenceAppendix(document: ReportDocument) {
  const bundle = document.evidence.bundle;
  const title = document.language === "zh" ? "研究证据附录" : "Research evidence appendix";
  if (!bundle) return `\n## ${title}\n\n${evidenceAbsent(document.language, document.evidence.invalid)}\n`;
  const fence = "`".repeat(Math.max(3, ...[...JSON.stringify(bundle).matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return `\n## ${title}\n\n${evidenceNotice(document.language)}\n\nBundle SHA-256: ${bundle.bundle_sha256}\n\n${bundle.records.map((record) => `<a id="${record.id}"></a>\n\n### [E:${record.id}] · ${record.tool}\n\nOutput SHA-256: ${record.output_sha256}\n`).join("\n")}\n### ${document.language === "zh" ? "完整证据包（含所有内容）" : "Complete evidence bundle (all payloads included)"}\n\n${fence}json\n${JSON.stringify(bundle, null, 2)}\n${fence}\n`;
}

function escapeTable(value: string) {
  return escapeInline(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function escapeInline(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}
