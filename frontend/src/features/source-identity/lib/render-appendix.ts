import type { ReportVersion, SystemLanguage } from "@/lib/types";
import { fencedJson } from "@/features/report-export/lib/markdown-fence";
import { copyExportIdentity } from "./export";
import { identityAbsent, identityAlignment, identityNotice, identityTitle } from "./display";
function appendix(version: ReportVersion, language: SystemLanguage) {
  const assessment = copyExportIdentity(version),
    zh = language === "zh";
  const lines = assessment
    ? [
        `${zh ? "对照时间（UTC）" : "Assessed at (UTC)"}: ${assessment.reviewed_at}`,
        ...assessment.records.flatMap((record) => {
          const original = version.evidenceBundle!.records.find(
            (row) => row.id === record.evidence_id,
          )!;
          const selected =
            record.canonical_selector_key === null
              ? undefined
              : original.parameters[record.canonical_selector_key];
          return [
            `${record.evidence_id} · ${record.tool} · ${identityAlignment(record.record_alignment, language)} · ${record.record_reason}`,
            `${zh ? "外层选择参数" : "Outer selector"}: ${record.canonical_selector_key ?? "none"}=${JSON.stringify(selected) ?? "not saved"} · ${identityAlignment(record.canonical_alignment, language)} · ${record.canonical_reason} / ${record.canonical_rule}`,
            ...record.sources.map(
              (source) =>
                `${zh ? "来源序号" : "Source index"} ${source.source_index} · ${source.provider} · ${zh ? "提供方请求未知 / 实体未知" : "Provider request unknown / entity unknown"} · ${source.data_sha256 ?? "no saved data"}`,
            ),
          ];
        }),
      ]
    : [identityAbsent(language)];
  return { assessment, lines, title: identityTitle(language), notice: identityNotice(language) };
}
export function identityMarkdown(version: ReportVersion, language: SystemLanguage) {
  const value = appendix(version, language);
  return `## ${value.title}\n\n${value.notice}\n\n${value.lines.join("\n\n")}\n\n${fencedJson({ effective_request_identity: value.assessment })}`;
}
export function identityHtml(
  version: ReportVersion,
  language: SystemLanguage,
  escape: (value: string) => string,
) {
  const value = appendix(version, language);
  return `<section class="report-section"><h2>${escape(value.title)}</h2><p>${escape(value.notice)}</p>${value.lines.map((line) => `<p>${escape(line)}</p>`).join("")}<details><summary>${escape(language === "zh" ? "完整冻结请求对照附件" : "Complete frozen request assessment")}</summary><pre id="effective-request-identity">${escape(JSON.stringify({ effective_request_identity: value.assessment }, null, 2))}</pre></details></section>`;
}
