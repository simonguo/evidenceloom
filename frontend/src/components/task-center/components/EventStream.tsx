import { useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry, SystemLanguage } from "@/lib/types";
import { TimelineLogRow } from "./TimelineLogRow";

const INITIAL_VISIBLE_LOGS = 30;
const LOG_LOAD_STEP = 30;

export function EventStream({ logs, language }: { logs: LogEntry[]; language: SystemLanguage }) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_LOGS);
  const containerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const labels = language === "en"
    ? {
      empty: "Messages, tool calls, and system events will appear here.",
      loading: "Loading earlier events...",
      loadMore: "Load earlier events",
      summary: (shown: number, total: number) => `${shown}/${total} shown`,
    }
    : {
      empty: "消息、工具调用和系统事件会出现在这里。",
      loading: "正在加载更早事件...",
      loadMore: "加载更早事件",
      summary: (shown: number, total: number) => `已显示 ${shown}/${total}`,
    };

  const visibleLogs = useMemo(
    () => logs.slice(0, Math.min(visibleCount, logs.length)),
    [logs, visibleCount],
  );
  const hasMore = visibleLogs.length < logs.length;

  useEffect(() => {
    if (!hasMore || !loadMoreRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisibleCount((current) => Math.min(current + LOG_LOAD_STEP, logs.length));
      },
      {
        root: containerRef.current,
        rootMargin: "160px 0px",
      },
    );

    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, logs.length]);

  if (logs.length === 0) {
    return <p className="text-sm text-zinc-500">{labels.empty}</p>;
  }

  return (
    <div ref={containerRef} className="max-h-[34rem] min-h-0 overflow-y-auto overscroll-contain pr-1">
      <div className="space-y-0">
        {visibleLogs.map((log, index) => <TimelineLogRow key={log.id} log={log} language={language} isLast={index === visibleLogs.length - 1 && !hasMore} />)}
      </div>
      {hasMore && (
        <div ref={loadMoreRef} className="relative py-3 pl-9">
          <span aria-hidden className="absolute bottom-0 left-[0.7rem] top-0 w-px bg-zinc-900" />
          <span aria-hidden className="absolute left-[0.43rem] top-5 size-2.5 rounded-full border border-zinc-700 bg-black" />
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => setVisibleCount((current) => Math.min(current + LOG_LOAD_STEP, logs.length))}
              className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-400 transition hover:border-zinc-600 hover:text-white"
            >
              {labels.loadMore}
            </button>
            <span className="text-xs text-zinc-600">{labels.summary(visibleLogs.length, logs.length)}</span>
            <span className="sr-only">{labels.loading}</span>
          </div>
        </div>
      )}
    </div>
  );
}
