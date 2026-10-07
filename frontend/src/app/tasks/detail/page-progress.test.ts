import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";
import { createEmptyTask, defaultGlobalSettings, defaultTaskDraft } from "@/lib/analysis";
import type { TaskDisplayStatus } from "@/components/task-center/queue/task-display-status";

const control = vi.hoisted(() => ({ center: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams({ id: "owned-progress" }) }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/components/task-center/context", () => ({ useTaskCenter: control.center }));
vi.mock("@/features/report-export", () => ({ ReportVersionsPanel: () => null }));
vi.mock("@/features/source-identity/components/IdentityInspector", () => ({ IdentityInspector: () => null }));
vi.mock("@/features/research-readiness/components/ReadinessInspector", () => ({ ReadinessInspector: () => null }));
vi.mock("@/features/memory/components/MemoryInspector", () => ({ MemoryInspector: () => null }));
vi.mock("@/features/output-quality/components/OutputQualityPanel", () => ({ OutputQualityPanel: () => null }));
vi.mock("@/features/evidence/components/EvidenceInspector", () => ({ EvidenceInspector: () => null }));

describe("task detail shows confirmed agent activity", () => {
  let container: HTMLDivElement, root: Root, displayStatus: TaskDisplayStatus;
  const task = {
    ...createEmptyTask({ ...defaultTaskDraft(), ticker: "FICT", instrumentName: "Fictional progress fixture", analysisDate: "2026-08-01" }, "owned-progress"),
    status: "stopped" as const,
    agentStatuses: { "News Analyst": "in_progress" as const, "Fundamentals Analyst": "completed" as const },
    reportSections: { fundamentals_report: "Confirmed fictional report" },
    logs: [{ id: "owned-progress-log", type: "message", message: "Previously confirmed fictional news progress", timestamp: "12:00:00", agent: "News Analyst" }],
  };
  const newsCard = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("新闻分析师"))!;
  async function render() { await act(async () => root.render(createElement(Page))); }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); displayStatus = "result_pending";
    control.center.mockReturnValue({ getTask: () => task, getTaskIdentity: () => task.id, getTaskDisplayStatus: () => displayStatus, settings: { ...defaultGlobalSettings(), systemLanguage: "zh" },
      hydrated: true, queueTask: vi.fn(), cancelQueuedTask: vi.fn(), getQueuePosition: vi.fn(), stopRunningTask: vi.fn(),
      setActiveTaskId: vi.fn(), saveEvaluationReviews: vi.fn(), saveNumericReviews: vi.fn() });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

  it("marks a stale working snapshot as sync pending and keeps its saved process available", async () => {
    await render();
    expect(container.textContent).toContain("待确认结果"); expect(container.textContent).toContain("以下为上次确认的状态");
    expect(newsCard().textContent).toContain("待同步"); expect(newsCard().textContent).not.toContain("工作中");
    expect(newsCard().classList.contains("agent-card-working")).toBe(false);
    expect(container.textContent).toContain("已交付");
    await act(async () => newsCard().click());
    expect(document.body.textContent).toContain("上次确认的进度");
    expect(document.body.textContent).not.toContain("实时事件");
    expect(task.agentStatuses["News Analyst"]).toBe("in_progress");
  });

  it("shows working only while native execution is running even when SQL normalizes the stored task to stopped", async () => {
    displayStatus = "running"; await render();
    expect(newsCard().textContent).toContain("工作中"); expect(newsCard().classList.contains("agent-card-working")).toBe(true);
    expect(container.textContent).not.toContain("以下为上次确认的状态");
    displayStatus = "stopped"; await render();
    expect(newsCard().textContent).toContain("已中断"); expect(newsCard().classList.contains("agent-card-working")).toBe(false);
  });
});
