import { memo } from "react";
import { AlertTriangle, Bot, CircleDot, Terminal, Wrench } from "lucide-react";
import clsx from "clsx";
import type { LogEntry, SystemLanguage } from "@/lib/types";
import { agentLabel } from "../utils";

function TimelineLogRowComponent({ log, language, isLast }: { log: LogEntry; language: SystemLanguage; isLast: boolean }) {
  const tone = eventTone(log.type);
  const Icon = tone.icon;

  return (
    <div className={clsx("group relative pl-9", isLast ? "pb-0" : "pb-4")}>
      {!isLast && <span aria-hidden className="absolute bottom-0 left-[0.7rem] top-6 w-px bg-zinc-900" />}
      <span aria-hidden className={clsx("absolute left-0 top-0.5 inline-flex size-6 items-center justify-center rounded-full border bg-black", tone.node)}>
        <Icon className="size-3" />
      </span>

      <div className={clsx("min-w-0 rounded-lg border bg-zinc-950/35 px-4 py-3 transition group-hover:bg-zinc-950/60", tone.border)}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={clsx("inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium", tone.badge)}>{log.type}</span>
            {log.agent && <span className="truncate text-xs text-zinc-500">{agentLabel(log.agent, language)}</span>}
          </div>
          <time className="shrink-0 font-mono text-[11px] text-zinc-600">{log.timestamp}</time>
        </div>
        {log.message && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">{log.message}</p>}
      </div>
    </div>
  );
}

export const TimelineLogRow = memo(TimelineLogRowComponent);

function eventTone(type: string) {
  const normalized = type.toLowerCase();
  if (normalized.includes("error") || normalized === "stderr") {
    return {
      icon: AlertTriangle,
      node: "border-rose-900/80 text-rose-300",
      border: "border-rose-950/80",
      badge: "border-rose-900/70 bg-rose-950/30 text-rose-300",
    };
  }
  if (normalized.includes("tool")) {
    return {
      icon: Wrench,
      node: "border-amber-900/80 text-amber-300",
      border: "border-zinc-900",
      badge: "border-amber-900/60 bg-amber-950/20 text-amber-200",
    };
  }
  if (normalized.includes("agent")) {
    return {
      icon: Bot,
      node: "border-sky-900/80 text-sky-300",
      border: "border-zinc-900",
      badge: "border-sky-900/60 bg-sky-950/20 text-sky-200",
    };
  }
  if (normalized.includes("system") || normalized.includes("runtime")) {
    return {
      icon: Terminal,
      node: "border-zinc-700 text-zinc-300",
      border: "border-zinc-900",
      badge: "border-zinc-800 bg-zinc-900 text-zinc-300",
    };
  }
  return {
    icon: CircleDot,
    node: "border-zinc-800 text-zinc-500",
    border: "border-zinc-900",
    badge: "border-zinc-800 bg-black text-zinc-400",
  };
}
