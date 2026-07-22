"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Activity, ArrowLeft, Clock3, Home, Plus, Settings, type LucideIcon } from "lucide-react";
import { createTranslator } from "@/lib/i18n";
import { isTauriRuntime } from "@/lib/runtime";
import type { AgentStatus, AnalysisTask, SystemLanguage } from "@/lib/types";
import { DesktopTitleBar } from "./components/DesktopTitleBar";
import { BrandMark } from "./components/BrandMark";
import { useTaskCenter } from "./context";
import { agentLabel, pageTitle, taskDetailHref } from "./utils";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { notice, setNotice, runningTask, queuedTasks, getQueuePosition, activeTaskId, settings, hydrated, sortedTasks } = useTaskCenter();
  const [titlebarOverlay, setTitlebarOverlay] = useState(false);
  const t = createTranslator(settings.systemLanguage);
  const isNewTaskPage = pathname === "/tasks/new";
  const isTaskDetailPage = pathname === "/tasks/detail";
  const isSettingsPage = pathname === "/settings";
  const showBackButton = isNewTaskPage || isTaskDetailPage;
  const needsConfig = hydrated && !settings.apiKey && !settings.providerConfigured && !isSettingsPage;
  const recentInstruments = deriveRecentInstruments(sortedTasks).slice(0, 5);
  const runningAgent = runningTask ? findRunningAgent(runningTask.agentStatuses, settings.systemLanguage) : "";
  const workspaceItems = [
    { href: "/", label: t("tasks"), icon: Home },
    { href: "/tasks/new", label: t("newTask"), icon: Plus },
  ];
  const systemItems = [
    { href: "/settings", label: t("settings"), icon: Settings },
  ];
  const mobileNavItems = [...workspaceItems, { href: "/settings", label: t("settings"), icon: Settings }];

  useEffect(() => {
    setTitlebarOverlay(isTauriRuntime());
  }, []);

  return (
    <div className={clsx("min-h-screen bg-black text-zinc-100", titlebarOverlay && "pt-8")}>
      <DesktopTitleBar enabled={titlebarOverlay} />

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-zinc-900 bg-black lg:block">
        <div className="flex h-full flex-col">
          <Link href="/" className={clsx("block border-b border-zinc-900 px-5 pb-5", titlebarOverlay ? "pt-14" : "pt-5")}>
            <div className="flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950">
                <BrandMark className="size-5" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white">Evidence Loom</div>
                <div className="text-xs text-zinc-500">{t("taskCenter")}</div>
              </div>
            </div>
          </Link>
          <nav className="flex-1 overflow-y-auto px-3 py-4">
            <SidebarSection label={t("workspace")}>
              {workspaceItems.map((item) => <SidebarNavItem key={item.href} item={item} pathname={pathname} />)}
            </SidebarSection>

            {recentInstruments.length > 0 && (
              <SidebarSection label={t("recentInstruments")}>
                <div className="space-y-1">
                  {recentInstruments.map((task) => (
                    <SidebarRecentTaskItem
                      key={task.ticker}
                      task={task}
                      active={task.id === activeTaskId}
                      queuePosition={getQueuePosition(task.id)}
                      language={settings.systemLanguage}
                    />
                  ))}
                </div>
              </SidebarSection>
            )}

            <SidebarSection label={t("system")}>
              {systemItems.map((item) => <SidebarNavItem key={item.href} item={item} pathname={pathname} />)}
            </SidebarSection>
          </nav>
          <div className="border-t border-zinc-900 px-4 py-4">
            {runningTask ? (
              <Link href={taskDetailHref(runningTask.id)} className="block rounded-lg border border-zinc-900 bg-zinc-950/60 p-3 transition hover:border-zinc-700 hover:bg-zinc-950">
                <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
                  <Activity className="size-3.5 animate-pulse text-emerald-300" />
                  <span>{t("running")} {runningTask.ticker}</span>
                </div>
                <div className="mt-1 truncate text-xs text-zinc-500">{runningAgent || t("taskRunning")}</div>
                {queuedTasks.length > 0 && <div className="mt-1 text-xs text-amber-200">{t("queuedCount", { count: queuedTasks.length })}</div>}
                <div className="mt-3 text-xs text-zinc-400">{t("open")}</div>
              </Link>
            ) : queuedTasks.length > 0 ? (
              <Link href={taskDetailHref(queuedTasks[0].id)} className="block rounded-lg border border-zinc-900 bg-zinc-950/60 p-3 transition hover:border-zinc-700 hover:bg-zinc-950">
                <div className="flex items-center gap-2 text-xs font-medium text-amber-200">
                  <Clock3 className="size-3.5" />
                  <span>{t("taskQueue")}</span>
                </div>
                <div className="mt-1 text-xs text-zinc-500">{t("queuedCount", { count: queuedTasks.length })}</div>
              </Link>
            ) : (
              <div className="rounded-lg border border-zinc-900 bg-zinc-950/40 p-3">
                <div className="text-xs font-medium text-zinc-300">{t("localWorkspace")}</div>
                <div className="mt-1 text-xs text-zinc-500">{t("noRunningTask")}</div>
              </div>
            )}
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className={clsx("sticky z-20 border-b border-zinc-900 bg-black/85 backdrop-blur-xl", titlebarOverlay ? "top-8" : "top-0")}>
          <div className="flex min-h-16 items-center justify-between gap-4 px-4 py-3 lg:px-8">
            <div className="flex items-center gap-3">
              {showBackButton && (
                <Link href="/" className="inline-flex size-8 items-center justify-center rounded-md border border-zinc-800 text-zinc-400 transition hover:border-zinc-600 hover:text-zinc-100" aria-label={t("backToList")}>
                  <ArrowLeft className="size-4" />
                </Link>
              )}
              <div>
                <div className="text-sm font-medium text-white">{pageTitle(pathname, settings.systemLanguage)}</div>
                <div className="text-xs text-zinc-500">{t("localWorkspace")}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {runningTask && <Link href={taskDetailHref(runningTask.id)} className="hidden rounded-full border border-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-600 md:inline-flex">{t("running")} {runningTask.ticker}</Link>}
              {queuedTasks.length > 0 && <Link href="/" className="hidden rounded-full border border-amber-900/70 px-3 py-1.5 text-xs text-amber-200 hover:border-amber-700 md:inline-flex">{t("queuedCount", { count: queuedTasks.length })}</Link>}
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto border-t border-zinc-900 px-4 py-2 lg:hidden">
            {mobileNavItems.map((item) => {
              const Icon = item.icon;
              const active = isActiveNavItem(item.href, pathname);
              return <Link key={item.href} href={item.href} className={clsx("inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm", active ? "bg-zinc-900 text-white" : "text-zinc-400")}><Icon className="size-4" />{item.label}</Link>;
            })}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
          {needsConfig && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-amber-800/60 bg-amber-950/40 px-4 py-3 text-sm text-amber-200">
              <span>{t("configReminder")}</span>
              <Link href="/settings" className="shrink-0 rounded-md border border-amber-700/60 px-3 py-1 text-xs text-amber-100 hover:border-amber-500 hover:text-white">{t("settings")}</Link>
            </div>
          )}
          {notice && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3 text-sm text-zinc-200">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice("")} className="text-zinc-500 hover:text-white">{t("dismiss")}</button>
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 px-3 text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-600">{label}</div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function SidebarNavItem({ item, pathname }: { item: { href: string; label: string; icon: LucideIcon }; pathname: string }) {
  const Icon = item.icon;
  const active = isActiveNavItem(item.href, pathname);
  return (
    <Link key={item.href} href={item.href} className={clsx("group flex items-center gap-3 rounded-md px-3 py-2 text-sm transition", active ? "bg-zinc-900 text-white" : "text-zinc-400 hover:bg-zinc-950 hover:text-zinc-100")}>
      <Icon className="size-4" />
      <span className="flex-1">{item.label}</span>
    </Link>
  );
}

function SidebarRecentTaskItem({ task, active, queuePosition, language }: { task: AnalysisTask; active: boolean; queuePosition: number | null; language: SystemLanguage }) {
  const t = createTranslator(language);
  const running = task.status === "running";
  const queued = task.status === "queued";

  return (
    <Link
      href={taskDetailHref(task.id)}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "group relative flex min-h-[3.75rem] items-center gap-3 rounded-md border px-3 py-2 transition",
        active
          ? "border-zinc-800 bg-zinc-900/70 text-white shadow-[inset_2px_0_0_rgba(255,255,255,0.9)]"
          : "border-transparent text-zinc-400 hover:border-zinc-900 hover:bg-zinc-950 hover:text-zinc-100",
      )}
    >
      <span className="relative flex size-2 shrink-0 items-center justify-center">
        {running && <span className="absolute size-3.5 animate-ping rounded-full bg-sky-400/35" />}
        <span className={clsx("relative size-1.5 rounded-full", statusDotClass(task.status))} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={clsx("block truncate text-sm font-medium", active && "text-white")}>{task.ticker}</span>
        {task.instrumentName && (
          <span className={clsx("mt-0.5 block truncate text-xs", active ? "text-zinc-300" : "text-zinc-500 group-hover:text-zinc-400")}>
            {task.instrumentName}
          </span>
        )}
      </span>
      {running && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10px] font-medium text-sky-200">
          <Activity className="size-3 animate-pulse" />
          {t("running")}
        </span>
      )}
      {queued && queuePosition && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-medium text-amber-200">
          {t("queuePosition", { position: queuePosition })}
        </span>
      )}
    </Link>
  );
}

function isActiveNavItem(href: string, pathname: string) {
  if (href === "/") return pathname === "/";
  if (href === "/tasks/new") return pathname === "/tasks/new";
  return pathname.startsWith(href);
}

function deriveRecentInstruments(tasks: AnalysisTask[]) {
  const seen = new Set<string>();
  const result: AnalysisTask[] = [];
  for (const task of tasks) {
    if (seen.has(task.ticker)) continue;
    seen.add(task.ticker);
    result.push(task);
  }
  return result;
}

function findRunningAgent(statuses: Record<string, AgentStatus>, language: SystemLanguage) {
  const entry = Object.entries(statuses).find(([, status]) => status === "in_progress");
  return entry ? agentLabel(entry[0], language) : "";
}

function statusDotClass(status: AnalysisTask["status"]) {
  if (status === "running") return "bg-sky-300 shadow-[0_0_14px_rgba(125,211,252,0.8)]";
  if (status === "queued") return "bg-amber-300";
  if (status === "completed") return "bg-emerald-500";
  if (status === "error") return "bg-rose-400";
  if (status === "stopped") return "bg-zinc-500";
  return "bg-zinc-600";
}
