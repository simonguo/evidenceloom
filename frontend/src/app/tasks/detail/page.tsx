"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Activity, BarChart3, BrainCircuit, FileText, Loader2, MoreHorizontal, Play, Square, Trash2, X } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import { getRuntimeAdapter } from "@/lib/runtime";
import { agentTeams, type OhlcvBar } from "@/lib/types";
import { useTaskCenter } from "@/components/task-center/context";
import {
  assetTypeLabel,
  compactNumber,
  depthLabel,
  formatDateTime,
  formatDuration,
} from "@/components/task-center/utils";
import { AgentTeamCard } from "@/components/task-center/components/AgentTeamCard";
import { AgentProcessDrawer } from "@/components/task-center/components/AgentProcessDrawer";
import { MetricCard } from "@/components/task-center/components/MetricCard";
import { Panel } from "@/components/task-center/components/Panel";
import { SegmentedControl } from "@/components/task-center/components/SegmentedControl";
import { StatusPill } from "@/components/task-center/components/StatusPill";
import { EventStream } from "@/components/task-center/components/EventStream";
import { DecisionSummaryCard } from "@/components/task-center/components/DecisionSummaryCard";

const CandlestickChart = dynamic(
  () => import("@/components/charts/CandlestickChart").then((module) => module.CandlestickChart),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[360px] items-center justify-center rounded-lg border border-zinc-900 bg-zinc-950 text-sm text-zinc-500">
        <Loader2 className="mr-2 size-4 animate-spin" /> 正在加载图表…
      </div>
    ),
  },
);

export default function Page() {
  return (
    <Suspense fallback={null}>
      <TaskDetailRouteContent />
    </Suspense>
  );
}

function TaskDetailRouteContent() {
  const searchParams = useSearchParams();
  return <TaskDetailPage taskId={searchParams.get("id") ?? ""} />;
}

function TaskDetailPage({ taskId }: { taskId: string }) {
  const router = useRouter();
  const { getTask, queueTask, cancelQueuedTask, getQueuePosition, stopRunningTask, deleteTask, settings, hydrated, setActiveTaskId } = useTaskCenter();
  const t = createTranslator(settings.systemLanguage);
  const task = getTask(taskId);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chartData, setChartData] = useState<OhlcvBar[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState("");
  const [activeTopTab, setActiveTopTab] = useState("overview");
  const [reportDrawerOpen, setReportDrawerOpen] = useState(false);
  const [drawerAgent, setDrawerAgent] = useState("");
  const [mounted, setMounted] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeReports = Object.entries(task?.reportSections ?? {}).filter(([, content]) => Boolean(content));

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setActiveTaskId(taskId);
    return () => setActiveTaskId("");
  }, [setActiveTaskId, taskId]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!task || activeTopTab !== "chart") return;
    let cancelled = false;
    let timeoutId: number | undefined;
    setChartLoading(false);
    setChartError("");
    setChartData([]);

    timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      setChartLoading(true);
      getRuntimeAdapter()
        .loadOhlcvChartData(task.ticker, task.analysisDate, settings)
        .then((bars) => {
          if (!cancelled) setChartData(bars);
        })
        .catch((error) => {
          if (!cancelled) setChartError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (!cancelled) setChartLoading(false);
        });
    }, 500);

    return () => {
      cancelled = true;
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [activeTopTab, task?.ticker, task?.analysisDate, settings]);

  useEffect(() => {
    if (!reportDrawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [reportDrawerOpen]);

  if (!hydrated) {
    return (
      <section className="flex min-h-[30rem] items-center justify-center rounded-xl border border-zinc-900 bg-black p-8 text-center">
        <div>
          <Loader2 className="mx-auto size-10 animate-spin text-zinc-500" />
          <h2 className="mt-4 text-xl font-semibold text-white">正在加载任务…</h2>
          <p className="mt-2 text-sm text-zinc-500">正在从本地数据库恢复任务详情。</p>
        </div>
      </section>
    );
  }

  if (!task) {
    return (
      <section className="flex min-h-[30rem] items-center justify-center rounded-xl border border-zinc-900 bg-black p-8 text-center">
        <div>
          <FileText className="mx-auto size-10 text-zinc-600" />
          <h2 className="mt-4 text-xl font-semibold text-white">{t("taskMissing")}</h2>
          <p className="mt-2 text-sm text-zinc-500">{t("taskMissingHint")}</p>
          <Link href="/" className="vercel-button mt-5">{t("backToList")}</Link>
        </div>
      </section>
    );
  }

  const visibleTeams = agentTeams
    .map((team) => ({ ...team, agents: team.agents.filter((agent) => agent in task.agentStatuses) }))
    .filter((team) => team.agents.length > 0);
  const topTabs = settings.systemLanguage === "en"
    ? [{ key: "overview", label: "Overview" }, { key: "chart", label: "Candles" }]
    : [{ key: "overview", label: "任务概览" }, { key: "chart", label: "K 线图" }];
  const openAgentDrawer = (agent: string) => {
    setDrawerAgent(agent);
    setReportDrawerOpen(true);
  };

  const reportDrawer = reportDrawerOpen && drawerAgent && mounted
    ? (
      <AgentProcessDrawer
        task={task}
        agent={drawerAgent}
        activeReports={activeReports}
        language={settings.systemLanguage}
        onSelectAgent={setDrawerAgent}
        onClose={() => setReportDrawerOpen(false)}
      />
    )
    : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-zinc-900 bg-black p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-3xl font-semibold text-white">{task.ticker}</h2>
              <StatusPill status={task.status} />
              {task.status === "queued" && <span className="text-xs text-amber-200">{t("queuePosition", { position: getQueuePosition(task.id) ?? 1 })}</span>}
            </div>
            {task.instrumentName && <div className="mt-2 text-lg font-medium text-zinc-300">{task.instrumentName}</div>}
            <p className="mt-2 text-sm text-zinc-500">
              {task.analysisDate} · {assetTypeLabel(task.assetType, settings.systemLanguage)} · {depthLabel(task.researchDepth, settings.systemLanguage)} · {task.analysts.join(", ")} · {t("createdAt")} {formatDateTime(task.createdAt)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {task.status === "running" ? (
              <button type="button" onClick={() => stopRunningTask()} className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-transparent px-3 py-2 text-sm text-red-300 transition hover:border-zinc-600 hover:bg-red-950/40">
                <Square className="size-4" /> {t("stopTask")}
              </button>
            ) : task.status === "queued" ? (
              <button type="button" onClick={() => cancelQueuedTask(task.id)} className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-transparent px-3 py-2 text-sm text-amber-200 transition hover:border-zinc-600 hover:bg-amber-950/30">
                <X className="size-4" /> {t("cancelQueue")}
              </button>
            ) : (
              <button type="button" onClick={() => queueTask(task.id)} className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-transparent px-3 py-2 text-sm text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-900">
                <Play className="size-4" /> {t("addToQueue")}
              </button>
            )}
            <div className="relative" ref={menuRef}>
              <button type="button" onClick={() => setMenuOpen(!menuOpen)} className="inline-flex items-center justify-center rounded-md border border-zinc-800 bg-transparent p-2 text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-900">
                <MoreHorizontal className="size-5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-50 mt-1 w-44 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 py-1 shadow-xl">
                  <button type="button" onClick={() => { deleteTask(task.id); setMenuOpen(false); router.push("/"); }} disabled={task.status === "running"} className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-300 transition hover:bg-red-950/40 disabled:cursor-not-allowed disabled:opacity-40">
                    <Trash2 className="size-4" /> {t("deleteTask")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="mt-5 border-t border-zinc-900 pt-5">
          <SegmentedControl items={topTabs} value={activeTopTab} onChange={setActiveTopTab} />
          {activeTopTab === "overview" ? (
            <div className="mt-5 space-y-5">
              <div className="grid gap-3 sm:grid-cols-4">
                <MetricCard icon={<Activity className="size-5" />} label={t("llm")} value={task.stats.llmCalls.toString()} description={t("metricLlmDescription")} />
                <MetricCard icon={<BarChart3 className="size-5" />} label={t("tools")} value={task.stats.toolCalls.toString()} description={t("metricToolsDescription")} />
                <MetricCard icon={<BrainCircuit className="size-5" />} label={t("tokens")} value={`${compactNumber(task.stats.tokensIn)}↑ ${compactNumber(task.stats.tokensOut)}↓`} description={t("metricTokensDescription")} />
                <MetricCard icon={<Loader2 className={clsx("size-5", task.status === "running" && "animate-spin")} />} label={t("elapsed")} value={formatDuration(task.stats.elapsedSeconds)} description={t("metricElapsedDescription")} />
              </div>
              <DecisionSummaryCard
                decision={task.decision}
                error={task.error}
                language={settings.systemLanguage}
                hasDetails={Boolean(task.reportSections.final_trade_decision?.trim())}
                onOpen={() => openAgentDrawer("Portfolio Manager")}
              />
            </div>
          ) : (
            <div className="mt-5">
              {chartLoading ? (
                <div className="flex h-[360px] items-center justify-center rounded-lg border border-zinc-900 bg-zinc-950 text-sm text-zinc-500">
                  <Loader2 className="mr-2 size-4 animate-spin" /> 正在加载 K 线数据…
                </div>
              ) : chartError ? (
                <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4 text-sm leading-6 text-amber-200">
                  暂时无法加载 K 线图：{chartError}
                </div>
              ) : chartData.length === 0 ? (
                <div className="rounded-lg border border-zinc-900 bg-zinc-950/50 p-4 text-sm text-zinc-500">
                  暂无可展示的 K 线数据。
                </div>
              ) : (
                <CandlestickChart data={chartData} />
              )}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-6">
        <Panel title={t("agentProgressReports")} sticky>
          {visibleTeams.length === 0 && activeReports.length === 0 ? <p className="text-sm text-zinc-500">{t("workflowEmpty")}</p> : (
            <div className="space-y-5">
              <div className="grid gap-4 lg:grid-cols-2">
                {visibleTeams.map((team) => (
                  <AgentTeamCard
                    key={team.team}
                    team={team.team}
                    agents={team.agents}
                    statuses={task.agentStatuses}
                    activeReports={activeReports.map(([key]) => key)}
                    activeAgent={drawerAgent}
                    language={settings.systemLanguage}
                    onSelectAgent={openAgentDrawer}
                  />
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel title={t("eventStream")} sticky>
          <EventStream key={task.id} logs={task.logs} language={settings.systemLanguage} />
        </Panel>
      </section>

      {reportDrawer}
    </div>
  );
}
