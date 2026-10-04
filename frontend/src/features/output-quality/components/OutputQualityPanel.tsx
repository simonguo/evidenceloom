import type { SystemLanguage } from "@/lib/types";
import { buildOutputQualityView } from "../lib/quality";

export function OutputQualityPanel({ quality, language, headingLevel = 3 }: {
  quality: unknown;
  language: SystemLanguage;
  headingLevel?: 3 | 5;
}) {
  const view = buildOutputQualityView(quality, language);
  const Heading = headingLevel === 5 ? "h5" : "h3";
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-4" aria-label={view.title}>
      <Heading className="text-sm font-semibold text-zinc-200">{view.title}</Heading>
      <p className="mt-2 text-xs leading-5 text-zinc-400">{view.disclaimer}</p>
      {view.entries.length ? (
        <ul className="mt-3 space-y-3">
          {view.entries.map((entry) => (
            <li key={entry.agent} className="rounded-md border border-zinc-800 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-zinc-200">{entry.agent}</span>
                <span className={entry.validated ? "text-emerald-300" : "text-amber-200"}>{entry.status}</span>
              </div>
              <p className="mt-1 text-xs text-zinc-400">{entry.schema} · {entry.source}</p>
              {entry.reason && <p className="mt-2 text-xs leading-5 text-amber-100">{entry.reason}</p>}
            </li>
          ))}
        </ul>
      ) : <p className="mt-3 text-sm text-zinc-300">{view.emptyMessage}</p>}
    </section>
  );
}
