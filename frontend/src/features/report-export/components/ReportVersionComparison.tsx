"use client";

import { useId, useState } from "react";
import type { ReportVersion, SystemLanguage } from "@/lib/types";
import type { OriginalSection, ReportSectionKey } from "../comparison-types";
import { useReportComparison } from "../hooks/useReportComparison";
import { compareReportSections } from "../lib/comparison";
import { comparisonLabels } from "../lib/comparison-labels";
import { comparisonVersionLabel, savedMetadataText } from "../lib/comparison-metadata";
import { ComparisonVersionSummary } from "./ComparisonVersionSummary";

export function ReportVersionComparison({ taskId, reportVersions, language }: {
  taskId: string; reportVersions: readonly ReportVersion[]; language: SystemLanguage;
}) {
  const text = comparisonLabels[language];
  const id = useId();
  const [open, setOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Partial<Record<ReportSectionKey, boolean>>>({ market_report: true });
  const comparison = useReportComparison(taskId, reportVersions);
  const { baseline, target } = comparison;
  const sections = !comparison.ambiguous && baseline && target ? compareReportSections(baseline, target) : [];

  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="mt-4 rounded-lg border border-zinc-800 p-4">
      <summary className="cursor-pointer text-sm font-medium text-zinc-200 focus-visible:outline focus-visible:outline-offset-4">{text.title}</summary>
      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-sm leading-6 text-zinc-400">{text.description}</p>
          {comparison.unavailableIds && <p role="status" className="text-sm text-amber-200">{text.unavailableIds}</p>}
          {comparison.ambiguous ? <p role="alert" className="text-sm text-amber-200">{text.duplicateIds}</p>
            : comparison.versions.length < 2 ? <p className="text-sm text-zinc-300">{text.needsVersions}</p> : baseline && target && (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <VersionSelector id={`${id}-baseline`} label={text.baseline} versions={comparison.versions} value={comparison.baselineId} unknown={text.unknown} onChange={comparison.selectBaseline} />
                <VersionSelector id={`${id}-target`} label={text.target} versions={comparison.versions} value={comparison.targetId} unknown={text.unknown} onChange={comparison.selectTarget} />
              </div>
              {baseline.id === target.id && <p role="status" className="text-sm text-zinc-300">{text.sameVersion}</p>}
              <div className="grid gap-4 lg:grid-cols-2">
                <ComparisonVersionSummary version={baseline} side="baseline" language={language} />
                <ComparisonVersionSummary version={target} side="target" language={language} />
              </div>
              <p role="status" aria-live="polite" className="text-sm text-zinc-200">{text.changeCount(
                sections.filter((section) => section.status === "changed").length,
                sections.filter((section) => section.status === "unavailable").length,
              )}</p>
              <nav aria-label={text.navigation}>
                <ul className="flex flex-wrap gap-2 text-sm">
                  {sections.map((section) => (
                    <li key={section.key}>
                      <a href={`#${id}-${section.key}`} onClick={() => setOpenSections((previous) => ({ ...previous, [section.key]: true }))}
                        className="inline-block rounded-md border border-zinc-700 px-3 py-2 text-zinc-200 underline underline-offset-4 focus-visible:outline focus-visible:outline-offset-4">
                        {text.sections[section.key]} · {text[section.status]}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
              <div className="space-y-3">
                {sections.map((section) => (
                  <details key={section.key} open={Boolean(openSections[section.key])}
                    onToggle={(event) => {
                      const expanded = event.currentTarget.open;
                      setOpenSections((previous) => previous[section.key] === expanded ? previous : { ...previous, [section.key]: expanded });
                    }} className="rounded-lg border border-zinc-800 p-4">
                    <summary id={`${id}-${section.key}`} className="scroll-mt-4 cursor-pointer text-sm font-medium text-zinc-200 focus-visible:outline focus-visible:outline-offset-4">
                      {text.sections[section.key]} · {text[section.status]}
                    </summary>
                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <OriginalSectionText side="baseline" version={baseline} section={section.baseline} sectionKey={section.key} language={language} />
                      <OriginalSectionText side="target" version={target} section={section.target} sectionKey={section.key} language={language} />
                    </div>
                  </details>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </details>
  );
}

function VersionSelector({ id, label, versions, value, unknown, onChange }: {
  id: string; label: string; versions: readonly ReportVersion[]; value: string; unknown: string; onChange: (id: string) => void;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-2 block text-sm font-medium text-zinc-200">{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}
        className="min-h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 focus-visible:outline focus-visible:outline-offset-4">
        {versions.map((version) => <option key={version.id} value={version.id}>{comparisonVersionLabel(version, unknown)} · {savedMetadataText(version.createdAt) ?? unknown} · {version.id}</option>)}
      </select>
    </div>
  );
}

function OriginalSectionText({ side, version, section, sectionKey, language }: {
  side: "baseline" | "target"; version: ReportVersion; section: OriginalSection; sectionKey: ReportSectionKey; language: SystemLanguage;
}) {
  const text = comparisonLabels[language];
  const versionLabel = comparisonVersionLabel(version, text.unknown);
  const label = `${text[side]} ${versionLabel} · ${text.sections[sectionKey]}`;
  const [escapedOpen, setEscapedOpen] = useState(false);
  return (
    <section className="min-w-0 rounded-md border border-zinc-800 p-3" aria-label={label}>
      <h5 className="text-sm font-medium text-zinc-200">{text[side]} · {versionLabel}</h5>
      <p className="mt-2 text-xs text-zinc-400">{text.states[section.state]}</p>
      {"value" in section && (
        <>
          <p className="mt-1 text-xs text-zinc-400">{text.characters(Array.from(section.value).length)}</p>
          <pre tabIndex={0} aria-label={`${label} · ${text.original}`}
            className="mt-3 max-h-96 min-h-8 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 p-3 text-sm leading-6 text-zinc-200 focus-visible:outline focus-visible:outline-offset-4">{section.value}</pre>
          <details open={escapedOpen} onToggle={(event) => setEscapedOpen(event.currentTarget.open)} className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-300 focus-visible:outline focus-visible:outline-offset-4">{text.escaped}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-zinc-300">{JSON.stringify(section.value)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
