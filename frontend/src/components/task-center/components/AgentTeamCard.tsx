import { createTranslator } from "@/lib/i18n";
import type { AgentStatus, SystemLanguage } from "@/lib/types";
import { reportWorkflow } from "../constants";
import { teamLabel, teamMandate } from "../utils";
import { AgentMemberCard } from "./AgentMemberCard";
import { TeamIcon } from "./TeamIcon";

export function AgentTeamCard({
  team,
  agents,
  statuses,
  activeReports,
  activeAgent,
  language,
  onSelectAgent,
}: {
  team: string;
  agents: string[];
  statuses: Record<string, AgentStatus>;
  activeReports: string[];
  activeAgent: string;
  language: SystemLanguage;
  onSelectAgent: (agent: string, reportKey?: string) => void;
}) {
  const t = createTranslator(language);
  const delivered = agents.filter((agent) => statuses[agent] === "completed").length;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-900 bg-[radial-gradient(circle_at_top_left,rgba(39,39,42,0.72),rgba(0,0,0,0.82)_42%)] p-5">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-zinc-500/50 to-transparent" />
      <div className="flex items-start gap-4">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-zinc-800 bg-black text-zinc-200">
          <TeamIcon team={team} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h4 className="text-base font-semibold text-white">{teamLabel(team, language)}</h4>
            <span className="rounded-full border border-zinc-800 bg-black/50 px-2.5 py-1 text-xs text-zinc-500">{delivered}/{agents.length}</span>
          </div>
          <p className="mt-1 line-clamp-2 text-sm leading-6 text-zinc-500">{teamMandate(team, language)}</p>
        </div>
      </div>

      <div className="mt-5 grid gap-3">
        {agents.map((agent) => {
          const report = reportWorkflow.find((item) => item.agent === agent && activeReports.includes(item.key));
          const active = activeAgent === agent;
          return (
            <AgentMemberCard
              key={agent}
              agent={agent}
              status={statuses[agent] ?? "pending"}
              language={language}
              active={active}
              reportKey={report?.key}
              reportReadyLabel={t("reportReady")}
              onSelectAgent={onSelectAgent}
            />
          );
        })}
      </div>
    </div>
  );
}
