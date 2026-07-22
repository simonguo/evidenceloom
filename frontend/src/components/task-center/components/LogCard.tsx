import type { LogEntry } from "@/lib/types";

export function LogCard({ log }: { log: LogEntry }) {
  return <div className="rounded-lg border border-zinc-900 bg-zinc-950/50 p-3"><div className="flex items-center justify-between gap-3 text-xs text-zinc-600"><span>{log.type}</span><span>{log.timestamp}</span></div><p className="mt-2 line-clamp-5 text-sm leading-6 text-zinc-300">{log.message}</p></div>;
}
