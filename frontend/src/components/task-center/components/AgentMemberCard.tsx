import clsx from "clsx";
import type { AgentStatus, SystemLanguage } from "@/lib/types";
import { agentStatusDotStyle, agentStatusTextStyle } from "../constants";
import { agentLabel, agentRole, agentWorkStateLabel, avatarUrl } from "../utils";

export function AgentMemberCard({
  agent,
  status,
  language,
  active,
  reportKey,
  reportReadyLabel,
  onSelectAgent,
}: {
  agent: string;
  status: AgentStatus;
  language: SystemLanguage;
  active: boolean;
  reportKey?: string;
  reportReadyLabel: string;
  onSelectAgent: (agent: string, reportKey?: string) => void;
}) {
  const canOpen = Boolean(reportKey) || status === "in_progress";
  const content = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={avatarUrl(agent)}
        alt={agentLabel(agent, language)}
        className="size-12 shrink-0 rounded-full border border-zinc-800 bg-zinc-950 object-cover"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-semibold text-zinc-100">{agentLabel(agent, language)}</div>
          <span className={clsx("size-2 shrink-0 rounded-full", agentStatusDotStyle[status])} />
        </div>
        <div className="mt-1 truncate text-xs text-zinc-500">{agentRole(agent, language)}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={clsx("text-xs font-medium", agentStatusTextStyle[status])}>{agentWorkStateLabel(status, language)}</span>
        {reportKey && <span className="rounded-full border border-zinc-800 px-2 py-0.5 text-[11px] text-zinc-500">{reportReadyLabel}</span>}
      </div>
    </>
  );
  const className = clsx(
    "flex w-full min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition",
    status === "in_progress" && "agent-card-working relative overflow-hidden",
    active
      ? "border-zinc-500 bg-zinc-900/80 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
      : "border-zinc-900 bg-black/45 hover:border-zinc-700 hover:bg-zinc-950",
    canOpen && "cursor-pointer",
  );

  if (canOpen) {
    return (
      <button type="button" onClick={() => onSelectAgent(agent, reportKey)} className={className}>
        {content}
      </button>
    );
  }

  return <div className={className}>{content}</div>;
}
