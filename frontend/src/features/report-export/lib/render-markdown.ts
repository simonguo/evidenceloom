import type { ReportDocument } from "../types";

export function renderReportMarkdown(document: ReportDocument) {
  const warning = document.fictionalNotice
    ? `> **${escapeInline(document.fictionalNotice)}**\n\n`
    : "";
  const metadata = document.metadata
    .map(([label, value]) => `| ${escapeTable(label)} | ${escapeTable(value)} |`)
    .join("\n");
  const sections = document.sections
    .map((section, index) => `## ${index + 1}. ${section.title}\n\n${section.content}`)
    .join("\n\n");

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
    sections,
    "",
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
}

function escapeTable(value: string) {
  return escapeInline(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function escapeInline(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("`", "\\`");
}
