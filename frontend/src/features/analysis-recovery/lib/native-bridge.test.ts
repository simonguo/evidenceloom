import { webcrypto } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TaskCenterProvider, useTaskCenter } from "@/components/task-center/context";
import { tauriRuntimeAdapter } from "@/lib/runtime";
import * as runtime from "@/lib/runtime";
import { defaultGlobalSettings } from "@/lib/analysis";
import { nativeCommandBridge } from "../test-support/native-command-bridge";
import { finished, gateReady, readCurrent, recoveryMessages } from "./protocol";

const executable = process.env.EVIDENCELOOM_RECOVERY_BRIDGE_EXE;
it.skipIf(!executable).each(["safe", "safe_float", "empty", "critical_then_safe", "no_terminal", "malformed"])("two queued %s runs use actual native worker/journal/SQLite through the production Provider and consumer", async (mode) => {
  const artifactRoot = process.env.EVIDENCELOOM_RECOVERY_BRIDGE_ARTIFACTS, artifacts = artifactRoot ? join(artifactRoot, mode) : undefined;
  if (artifacts) await mkdir(artifacts);
  const bridge = await nativeCommandBridge(executable!, artifacts, process.env.EVIDENCELOOM_RECOVERY_RUSTC_DIRECTORY);
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  const adapter = { ...tauriRuntimeAdapter, getRuntimeInfo: async () => ({ kind: "tauri" as const, label: "Actual production-module owned worker bridge" }), getAnalysisRecoveryApi: async () => bridge.api,
    loadDesktopData: async () => ({ ...await bridge.invoke("load_desktop_data") as Awaited<ReturnType<typeof tauriRuntimeAdapter.loadDesktopData>>, settings: { ...defaultGlobalSettings(), systemLanguage: "en" as const } }),
    saveDesktopTask: async (request: Parameters<typeof tauriRuntimeAdapter.saveDesktopTask>[0], guard?: () => void) => { guard?.(); return bridge.invoke("save_desktop_task", { request }); },
    queryDesktopTaskMutation: async (request: Parameters<typeof tauriRuntimeAdapter.queryDesktopTaskMutation>[0]) => bridge.invoke("query_desktop_task_mutation", { request }),
  };
  const spy = vi.spyOn(runtime, "getRuntimeAdapter").mockReturnValue(adapter);
  const element = document.createElement("div"); document.body.appendChild(element); const root = createRoot(element);
  let center: ReturnType<typeof useTaskCenter> | undefined;
  function Consumer() { center = useTaskCenter(); return createElement("p", null, center.notice); }
  try {
    await bridge.invoke("fixture_queue_tasks"); await bridge.invoke("fixture_mode", { mode });
    await act(async () => root.render(createElement(TaskCenterProvider, null, createElement(Consumer))));
    const deadline = Date.now() + 20000;
    const status = mode === "safe" || mode === "safe_float" ? "completed" : "error";
    while (Date.now() < deadline && (!center || center.tasks.length !== 2 || center.tasks.some((task) => task.status !== status) || center.runningTask !== null)) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    }
    if (!center || center.tasks.length !== 2 || center.tasks.some((task) => task.status !== status) || center.runningTask !== null) {
      // Fixed metadata only; original request bodies and saved research remain in owned artifacts.
      const id = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : null;
      const code = (value: unknown) => typeof value === "string" && Object.hasOwn(recoveryMessages, value) ? value : "unknown";
      const rows = bridge.replies.slice(-12).map((row) => {
        const result = row.ok && typeof row.ok === "object" ? row.ok as Record<string, unknown> : undefined;
        const receipt = result?.receipt && typeof result.receipt === "object" ? result.receipt as Record<string, unknown> : undefined;
        let current: ReturnType<typeof readCurrent> | undefined;
        try { if (result?.current) current = readCurrent(result.current); } catch { /* Invalid wire is classified without its content. */ }
        const journal = current?.state === "coherent" ? current.journal : null;
        const error = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : undefined;
        return { id: id(row.id), errorCode: error ? code(error.code) : null,
          receipt: receipt ? { requestId: id(receipt.requestId), throughSeq: id(receipt.throughSeq), controlRevision: id(receipt.controlRevision), outcome: id(receipt.outcome) } : null,
          current: current ? { state: current.state, errorCode: current.state === "unavailable" ? code(current.error.code) : null,
            runtime: { initialization: current.runtime.initialization, observationRevision: current.runtime.observationRevision, runtimeGate: current.runtime.runtimeGate, journalGate: current.runtime.journalGate, owner: current.runtime.owner ? { taskId: id(current.runtime.owner.origin.taskId), runId: id(current.runtime.owner.origin.runId), journalId: id(current.runtime.owner.journalId), phase: current.runtime.owner.phase, cleanupState: current.runtime.owner.cleanupState } : null },
            journal: journal ? { journalId: id(journal.journalId), latestSeq: journal.latestSeq, appliedSeq: journal.appliedSeq, sealedThroughSeq: journal.sealedThroughSeq, controlRevision: journal.controlRevision, cleanupState: journal.cleanupState, resultState: journal.resultState, historyState: journal.historyState } : null } : null };
      });
      const diagnostic = JSON.stringify({ mode, running: center?.runningTask ? { id: id(center.runningTask.id), status: center.runningTask.status } : null, tasks: center?.tasks.slice(0, 2).map((task) => ({ id: id(task.id), status: task.status })), replies: rows });
      console.error("OWNED_RECOVERY_FINAL_DIAGNOSTIC", diagnostic.length <= 16384 ? diagnostic : "bounded metadata unavailable");
    }
    expect(center?.tasks).toHaveLength(2); expect(center!.tasks.every((task) => task.status === status)).toBe(true); expect(center!.runningTask).toBeNull();
    const requests = bridge.requests.map((line) => JSON.parse(line) as { id: string; command: string; args: { requestJson?: string } });
    expect(requests.filter((request) => request.command === "start_analysis")).toHaveLength(2); expect(requests.filter((request) => request.command === "commit_analysis_projection").length).toBeGreaterThanOrEqual(4);
    // V1 bootstrap may normalize queue ordering before admission. Run events/reset/finally must use journal projection exclusively.
    expect(requests.slice(requests.findIndex((request) => request.command === "reserve_analysis")).filter((request) => request.command === "save_desktop_task")).toHaveLength(0);
    expect(center!.tasks.map((task) => task.reportVersions.length)).toEqual(status === "completed" ? [1, 1] : [0, 0]);
    if (mode === "safe_float") { for (const task of center!.tasks) { expect(task.stats.elapsedSeconds).toBe(1); expect(task.stats.llmCalls).toBe(0); expect(task.stats.toolCalls).toBe(0); expect(task.reportVersions[0].stats).toEqual(task.stats); } expect(bridge.raw.join("")).toContain('"elapsedSeconds":1.0'); expect(bridge.raw.join("")).toContain('"toolCalls":-0.0'); }
    const expectedError = mode === "empty" ? recoveryMessages.analysis_empty_result : mode === "critical_then_safe" ? recoveryMessages.analysis_publication_unavailable : mode === "no_terminal" ? recoveryMessages.analysis_missing_terminal : undefined;
    if (expectedError) expect(center!.tasks.every((task) => task.error === expectedError)).toBe(true);
    if (mode === "critical_then_safe") expect(center!.tasks.every((task) => task.reportSections.market_report === "Later fictional safe report.")).toBe(true);
    const reservations = requests.filter((request) => request.command === "reserve_analysis"), admitted = reservations.map((request) => JSON.parse(request.args.requestJson!).requestId); expect(new Set(admitted).size).toBe(2);
    const secondAdmission = requests.indexOf(reservations[1]);
    // This is the actual native gate reply before B, not a JavaScript reconstruction of the native gate.
    expect(requests.slice(0, secondAdmission).filter((request) => request.command === "commit_analysis_projection").some((request) => {
      const reply = bridge.replies.find((row) => row.id === request.id)?.ok as { current?: unknown } | undefined;
      if (!reply?.current) return false; const current = readCurrent(reply.current);
      return current.state === "coherent" && current.journal !== null && finished(current.journal) && gateReady(current.runtime);
    })).toBe(true);
  } finally { await act(async () => root.unmount()); element.remove(); spy.mockRestore(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); expect(await bridge.close()).toBe(0); }
}, 30000);
