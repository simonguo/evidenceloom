import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { task as fixtureTask } from "@/features/analysis-recovery/test-support/fixtures";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import { taskDetailHref } from "../utils";
import { taskDisplayStatus, type TaskDisplayStatus } from "../queue/task-display-status";
import { ResearchWorkspaceHeader } from "./ResearchWorkspaceHeader";
import { ResearchTaskTable } from "./ResearchTaskTable";
import { workspaceOpenLabel, workspaceSummary } from "./research-workspace";

const taskCenter = vi.hoisted(() => ({
  language: "en" as "zh" | "en",
  tasks: [] as AnalysisTask[],
  status: null as ((task: AnalysisTask) => TaskDisplayStatus) | null,
}));
vi.mock("../context", () => ({ useTaskCenter: () => ({
  settings: { systemLanguage: taskCenter.language },
  getTask: (id: string) => taskCenter.tasks.find(task => task.id === id),
  getTaskDisplayStatus: (task: AnalysisTask) => taskCenter.status?.(task) ?? task.status,
}) }));
const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002"];
function task(id = ids[0]): AnalysisTask { return { ...fixtureTask(), id, ticker: "FICTION", analysts: ["market", "social"] }; }
function savedVersion(owner: AnalysisTask): ReportVersion {
  return { id: `report:${"a".repeat(64)}:3`, runId: "20000000-0000-4000-8000-000000000001", versionNumber: 1,
    createdAt: owner.updatedAt, legacy: false,
    task: { ticker: owner.ticker, instrumentName: owner.instrumentName, analysisDate: owner.analysisDate, assetType: owner.assetType, researchDepth: owner.researchDepth, analysts: owner.analysts, outputLanguage: owner.outputLanguage },
    run: null, decision: "", stats: owner.stats, reportSections: { market_report: "Owned fictional unit report." }, evaluationReviews: [] };
}
let container: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); taskCenter.language = "en"; taskCenter.tasks = []; taskCenter.status = null; container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("uses upstream starting and confirmation states for compact counters", () => {
  const pending = { ...task(), status: "completed" as const };
  const cleanup = { ...task(ids[1]), status: "error" as const };
  const stopping = { ...task("stopping"), status: "running" as const };
  const starting = { ...task("starting"), status: "completed" as const };
  const finished = { ...task("finished"), status: "completed" as const };
  const queued = { ...task("queued"), status: "queued" as const };
  const failed = { ...task("failed"), status: "error" as const };
  const execution = { resultPendingTask: pending, cleanupFailedTask: cleanup, runningTask: stopping, startingTask: starting, stopping: false };
  const status = (item: AnalysisTask) => taskDisplayStatus(item, execution);
  expect([status(pending), status(cleanup), status(starting)]).toEqual(["result_pending", "cleanup_failed", "starting"]);
  expect(workspaceSummary([pending, cleanup, stopping, starting, finished, queued, failed], status)).toEqual({ total: 7, completed: 1, running: 1, queued: 1, failed: 1 });
  expect(workspaceSummary([stopping], item => taskDisplayStatus(item, { ...execution, stopping: true }))).toEqual({ total: 1, completed: 0, running: 0, queued: 0, failed: 0 });
});

it("requires an actual saved version and honors upstream pending states before naming a saved report", () => {
  const completed = { ...task(), status: "completed" as const };
  expect(workspaceOpenLabel(completed, "completed")).toBe("workspaceOpenResearch");
  const saved = { ...completed, reportVersions: [savedVersion(completed)] };
  expect(workspaceOpenLabel(saved, "completed")).toBe("workspaceOpenSavedReport");
  for (const pending of ["result_pending", "cleanup_failed", "stopping"] as const) expect(workspaceOpenLabel(saved, pending)).toBe("workspaceOpenResearch");
  expect(workspaceOpenLabel(saved, "starting")).toBe("workspaceViewProgress");
  expect(workspaceOpenLabel({ ...completed, status: "queued" }, "queued")).toBe("workspaceViewProgress");
});

it("retains one real UUID row and its click, Enter, Space and prefetch navigation", async () => {
  const first = task(), second = { ...task(ids[1]), analysisDate: "2025-01-02" };
  const open = vi.fn(), prefetch = vi.fn();
  taskCenter.tasks = [first, second];
  await act(async () => root.render(createElement(ResearchTaskTable, { tasks: taskCenter.tasks, language: "en", status: item => item.status, getQueuePosition: () => null, onOpen: open, onPrefetch: prefetch })));
  const rows = [...container.querySelectorAll<HTMLTableRowElement>('tr[role="link"][tabindex="0"][data-task-id]')];
  expect(rows.map(row => row.dataset.taskId)).toEqual(ids);
  expect(container.querySelectorAll(`tr[data-task-id="${ids[0]}"]`)).toHaveLength(1);
  await act(async () => { rows[0].focus(); rows[0].click(); rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
  expect(prefetch).toHaveBeenCalledWith(taskDetailHref(first.id));
  expect(open.mock.calls).toEqual([[taskDetailHref(first.id)], [taskDetailHref(first.id)], [taskDetailHref(second.id)]]);
  expect(rows[1].getAttribute("aria-label")).toContain("2025-01-02");
});

it("shows real research dates and translated scopes without turning completion into a saved report", async () => {
  const completed = { ...task(), status: "completed" as const }, saved = { ...task(ids[1]), status: "completed" as const };
  saved.reportVersions = [savedVersion(saved)];
  taskCenter.tasks = [completed, saved];
  const props = { tasks: taskCenter.tasks, status: (item: AnalysisTask) => item.status, getQueuePosition: () => null, onOpen: vi.fn(), onPrefetch: vi.fn() };
  await act(async () => root.render(createElement(ResearchTaskTable, { ...props, language: "en" })));
  const rows = [...container.querySelectorAll('tr[data-task-id]')];
  expect(rows[0].textContent).toContain("Research date: 2025-01-01"); expect(rows[0].textContent).toContain("Market · Sentiment");
  expect(rows[0].textContent).toContain("View task"); expect(rows[0].textContent).not.toContain("Review research and reports"); expect(rows[1].textContent).toContain("Review research and reports");
  taskCenter.language = "zh";
  await act(async () => root.render(createElement(ResearchTaskTable, { ...props, language: "zh" })));
  expect(container.textContent).toContain("研究日期: 2025-01-01"); expect(container.textContent).toContain("市场 · 情绪"); expect(container.textContent).toContain("查看研究与报告");
});

it("preserves the upstream StatusPill task lookup and native display override", async () => {
  const retained = { ...task(), status: "completed" as const, reportVersions: [savedVersion(task())] };
  taskCenter.tasks = [retained];
  for (const display of ["starting", "stopping", "result_pending", "cleanup_failed", "queued"] as const) {
    taskCenter.status = () => display;
    await act(async () => root.render(createElement(ResearchTaskTable, { tasks: taskCenter.tasks, language: "en", status: taskCenter.status!, getQueuePosition: () => 2, onOpen: vi.fn(), onPrefetch: vi.fn() })));
    const row = container.querySelector(`tr[data-task-id="${retained.id}"]`)!;
    const expected = { starting: "Starting", stopping: "Stopping", result_pending: "Result pending", cleanup_failed: "Cleanup pending", queued: "Queued" } as const;
    expect(row.textContent).toContain(expected[display]);
    expect(row.getAttribute("aria-label")).toContain(`status ${expected[display]}`);
    expect(workspaceSummary(taskCenter.tasks, taskCenter.status!)).toEqual({ total: 1, completed: 0, running: 0, queued: display === "queued" ? 1 : 0, failed: 0 });
    if (display === "queued") expect(row.textContent).toContain("Position 2");
    else expect(row.textContent).not.toContain("Review research and reports");
  }
});

it("does not invent a queue position when the current queue has no position for a retained task", async () => {
  const retained = { ...task(), status: "queued" as const };
  taskCenter.tasks = [retained];
  await act(async () => root.render(createElement(ResearchTaskTable, { tasks: taskCenter.tasks, language: "en", status: item => item.status, getQueuePosition: () => null, onOpen: vi.fn(), onPrefetch: vi.fn() })));
  expect(container.textContent).toContain("Queued");
  expect(container.textContent).not.toContain("Position");
});

it("gives the workspace one explicit start route and five compact semantic counts in both languages", async () => {
  const summary = { total: 4, completed: 2, running: 1, queued: 1, failed: 0 };
  for (const language of ["en", "zh"] as const) {
    await act(async () => root.render(createElement(ResearchWorkspaceHeader, { language, summary })));
    expect(container.querySelector('a[href="/tasks/new"]')?.textContent).toContain(language === "en" ? "Start research" : "开始研究");
    expect(container.querySelector("h1")?.textContent).toBe(language === "en" ? "Research workspace" : "投研工作台");
    expect([...container.querySelectorAll("dl dd")].map(element => element.textContent)).toEqual(["4", "2", "1", "1", "0"]);
  }
});
