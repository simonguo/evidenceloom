import type { ExportFormat } from "../types";
import type { ReportVersion } from "@/lib/types";

export function reportExportFilename(version: ReportVersion, format: ExportFormat) {
  const ticker = sanitizeFilenamePart(version.task.ticker) || "REPORT";
  const date = sanitizeFilenamePart(version.task.analysisDate) || "undated";
  return `EvidenceLoom_${ticker}_${date}_v${version.versionNumber}.${format}`;
}

export function sanitizeFilenamePart(value: string) {
  const replaced = Array.from(value.normalize("NFKC"), (character) => (
    character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? "_" : character
  )).join("");
  return replaced
    .replace(/[.\s]+$/g, "")
    .replace(/^[.\s]+/g, "")
    .slice(0, 80);
}
