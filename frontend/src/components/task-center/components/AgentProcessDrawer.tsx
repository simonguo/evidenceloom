"use client";

import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { X } from "lucide-react";
import clsx from "clsx";
import { createTranslator } from "@/lib/i18n";
import type { AnalysisTask, LogEntry, SystemLanguage } from "@/lib/types";
import { reportWorkflow } from "../constants";
import { agentLabel, agentRole, reportTitle } from "../utils";

const ReportMarkdown = dynamic(
  () => import("./ReportMarkdown").then((module) => module.ReportMarkdown),
  {
    ssr: false,
    loading: () => <div className="text-sm text-zinc-500">正在加载内容...</div>,
  },
);

export function AgentProcessDrawer({
  task,
  agent,
  activeReports,
  language,
  onSelectAgent,
  onClose,
}: {
  task: AnalysisTask;
  agent: string;
  activeReports: Array<[string, string | null]>;
  language: SystemLanguage;
  onSelectAgent: (agent: string) => void;
  onClose: () => void;
}) {
  if (typeof document === "undefined") return null;

  const t = createTranslator(language);
  const status = task.agentStatuses[agent];
  const reportKey = reportWorkflow.find((item) => item.agent === agent)?.key ?? "";
  const reportContent = reportKey ? textValue(task.reportSections[reportKey]) : "";
  const liveContent = status === "in_progress" ? visibleProcessContent(task, agent) : "";
  const agentLogs = task.logs.filter((log) => log.agent === agent).slice(0, 20);
  const showingProcess = status === "in_progress" && (Boolean(liveContent) || agentLogs.length > 0);
  const mainContent = showingProcess ? liveContent : reportContent;

  return createPortal(
    <div className="fixed bottom-0 left-0 right-0 top-0 z-[2147483647]">
      <button type="button" aria-label="关闭角色抽屉" onClick={onClose} className="absolute bottom-0 left-0 right-0 top-0 bg-black/70 backdrop-blur-sm" />
      <aside className="absolute bottom-0 right-0 top-0 flex w-full max-w-3xl flex-col border-l border-zinc-800 bg-black shadow-2xl">
        <div className="border-b border-zinc-900 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">{showingProcess ? t("thinkingProcess") : t("currentReport")}</div>
              <h3 className="mt-1 text-lg font-semibold text-white">{agentLabel(agent, language)}</h3>
              <p className="mt-1 text-sm text-zinc-500">{agentRole(agent, language)}</p>
            </div>
            <button type="button" aria-label="关闭角色抽屉" onClick={onClose} className="inline-flex size-9 items-center justify-center rounded-md border border-zinc-800 text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-900 hover:text-white">
              <X className="size-4" />
            </button>
          </div>
          {activeReports.length > 1 && (
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
              {activeReports.map(([key], index) => {
                const reportAgent = reportWorkflow.find((item) => item.key === key)?.agent;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => reportAgent && onSelectAgent(reportAgent)}
                    className={clsx(
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs transition",
                      key === reportKey ? "border-zinc-100 bg-zinc-100 text-black" : "border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-white",
                    )}
                  >
                    {index + 1}. {reportTitle(key, language)}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {mainContent ? (
            <article className="min-w-0 rounded-xl border border-zinc-900 bg-zinc-950/50 p-5 md:p-6">
              <div className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-zinc-600">
                {showingProcess ? t("visibleProcess") : reportKey ? reportTitle(reportKey, language) : t("currentReport")}
              </div>
              <ReportMarkdown content={mainContent} />
            </article>
          ) : (
            <div className="rounded-xl border border-zinc-900 bg-zinc-950/50 p-5 text-sm leading-6 text-zinc-400">
              <div className="font-medium text-zinc-200">{t("processEmpty")}</div>
              <div className="mt-1 text-zinc-500">{t("processEmptyHint")}</div>
            </div>
          )}

          {agentLogs.length > 0 && (
            <section className="mt-5 rounded-xl border border-zinc-900 bg-zinc-950/30 p-5">
              <div className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-zinc-600">{t("liveEvents")}</div>
              <div className="space-y-3">
                {agentLogs.map((log) => <AgentLogItem key={log.id} log={log} />)}
              </div>
            </section>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function AgentLogItem({ log }: { log: LogEntry }) {
  return (
    <div className="rounded-lg border border-zinc-900 bg-black/50 p-3">
      <div className="flex items-center justify-between gap-3 text-xs text-zinc-600">
        <span>{log.type}</span>
        <span>{log.timestamp}</span>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-300">{log.message}</p>
    </div>
  );
}

function textValue(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : "";
}

function visibleProcessContent(task: AnalysisTask, agent: string) {
  const directReportKey = reportWorkflow.find((item) => item.agent === agent)?.key;
  const directReport = directReportKey ? textValue(task.reportSections[directReportKey]) : "";
  if (directReport) return directReport;

  const latestAgentLog = task.logs.find((log) => log.agent === agent && log.type !== "Tool");
  if (latestAgentLog?.message.trim()) {
    return latestAgentLog.message.trim();
  }

  return "";
}
