"use client";

import { useState } from "react";
import type { ReportVersion, SystemLanguage } from "@/lib/types";
import { OutputQualityPanel } from "@/features/output-quality/components/OutputQualityPanel";
import { comparisonLabels } from "../lib/comparison-labels";
import { comparisonMetadata, comparisonVersionLabel, publicComparisonManifest, recordedValidationReason } from "../lib/comparison-metadata";

export function ComparisonVersionSummary({ version, side, language }: {
  version: ReportVersion; side: "baseline" | "target"; language: SystemLanguage;
}) {
  const text = comparisonLabels[language];
  const [manifestOpen, setManifestOpen] = useState(false);
  const metadata = comparisonMetadata(version);
  const versionLabel = comparisonVersionLabel(version, text.unknown);
  const manifest = publicComparisonManifest(version.run);
  const rows = [
    [text.versionId, metadata.id ?? text.unknown], [text.runId, metadata.runId ?? text.unknown],
    [text.instrument, [metadata.ticker, metadata.instrumentName].filter(Boolean).join(" · ") || text.unknown],
    [text.analysisDate, metadata.analysisDate ?? text.unknown], [text.createdAt, metadata.createdAt ?? text.unknown],
    [text.rating, metadata.rating ?? text.unknown], [text.legacy, metadata.legacy === undefined ? text.unknown : metadata.legacy ? text.yes : text.no],
    [text.provider, metadata.provider && metadata.quickModel && metadata.deepModel
      ? `${metadata.provider} · ${metadata.quickModel} / ${metadata.deepModel}` : text.unknown],
  ];
  const attachments = [
    { label: text.attachments.evidence, saved: Boolean(version.evidenceBundle), invalid: version.evidenceValidation },
    { label: text.attachments.memory, saved: Boolean(version.memoryBundle), invalid: version.memoryValidation },
    { label: text.attachments.readiness, saved: Boolean(version.researchReadiness), invalid: version.readinessValidation },
    { label: text.attachments.numeric, saved: Boolean(version.reportTextSnapshot), invalid: version.numericValidation },
    { label: text.attachments.identity, saved: Boolean(version.effectiveRequestIdentity), invalid: version.identityValidation },
  ];

  return (
    <section className="min-w-0 space-y-3 rounded-lg border border-zinc-800 p-4" aria-label={`${text[side]} ${versionLabel}`}>
      <h4 className="font-semibold text-zinc-100">{text[side]} · {versionLabel}</h4>
      {metadata.unavailable && <p role="status" className="text-sm text-amber-200">{text.unavailableMetadata}</p>}
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-zinc-400">{label}</dt>
            <dd className="break-words text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>
      {manifest && (
        <details open={manifestOpen} onToggle={(event) => setManifestOpen(event.currentTarget.open)} className="rounded-md border border-zinc-800 p-3">
          <summary className="cursor-pointer text-sm text-zinc-200 focus-visible:outline focus-visible:outline-offset-4">{text.manifest}</summary>
          <pre className="mt-3 whitespace-pre-wrap break-words text-xs text-zinc-300">{JSON.stringify(manifest, null, 2)}</pre>
        </details>
      )}
      <OutputQualityPanel quality={version.outputQuality} language={language} headingLevel={5} />
      <section aria-label={text.attachmentTitle}>
        <h5 className="text-sm font-medium text-zinc-200">{text.attachmentTitle}</h5>
        <p className="mt-2 text-xs leading-5 text-zinc-400">{text.attachmentNotice}</p>
        <dl className="mt-3 space-y-2 text-xs">
          {attachments.map(({ label, saved, invalid }) => (
            <div key={label}>
              <dt className="text-zinc-400">{label}</dt>
              <dd className={invalid ? "break-words text-amber-200" : "text-zinc-300"}>
                {invalid ? `${text.invalid}: ${recordedValidationReason(invalid) ?? text.unknown}` : saved ? text.attached : text.unknown}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </section>
  );
}
