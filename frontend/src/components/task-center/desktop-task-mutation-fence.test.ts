import { createHash, webcrypto } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCenterProvider, useTaskCenter } from "./context";
import { createEmptyTask, defaultGlobalSettings, defaultTaskDraft } from "@/lib/analysis";
import { FICTIONAL_DEMO_TASK_ID } from "@/features/report-export/fixtures/fictional-demo";
import * as runtime from "@/lib/runtime";
import type { AnalysisEvent, AnalysisTask } from "@/lib/types";
import { transportFixture } from "@/features/analysis-recovery/test-support/transport-fixture";
import { runtime as recoveryRuntime } from "@/features/analysis-recovery/test-support/fixtures";
import type { AdmissionRequest, RecoveryCurrent } from "@/features/analysis-recovery/types";
import { recoveryMessages } from "@/features/analysis-recovery/lib/protocol";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: ipc.listen }));
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve: (value?: T) => resolve(value as T), reject };
}
type Head = { taskId: string; generation: string; revision: string; state: "never_seen" | "live" | "tombstone" };
type Request = { protocolVersion: number; requestId: string; collection: { collectionId: string; epoch: string };
  operation: string; expectedHead?: Head; task?: AnalysisTask; tasks?: AnalysisTask[]; expectedHeads?: Head[] };
type Receipt = { protocolVersion: 1; requestId: string; digest: string; operation: string;
  collection: { collectionId: string; epoch: string }; heads: Head[]; sqlCommitted: true };
// Fictional successful-CAS/transport model, not SQLite or complete native-wire
// proof. Old tokenless writes model the base API. Digest is fake server receipt
// metadata, not a claim about Rust's sorted JSON encoding or durable binder.
function ownedStore(initial: AnalysisTask[], legacyAllowed = false) {
  let epoch = "1";
  const rows = new Map(initial.map((task) => [task.id, structuredClone(task)]));
  const heads = new Map(initial.map((task) => [task.id, { taskId: task.id, generation: "1", revision: "1", state: "live" } as Head]));
  const receipts = new Map<string, { packet: string; receipt: Receipt }>();
  const collection = () => ({ collectionId: "a".repeat(64), epoch });
  const current = () => ({ collection: collection(), heads: structuredClone([...heads.values()]) });
  function head(id: string): Head { return heads.get(id) ?? { taskId: id, generation: "0", revision: "0", state: "never_seen" }; }
  function apply(request: Request) {
    const packet = JSON.stringify(request), previous = receipts.get(request.requestId);
    if (previous) {
      if (previous.packet !== packet) throw { code: "storage_conflict", message: "Owned request reuse mismatch" };
      return { scope: "sql", receipt: previous.receipt, rejection: null, current: current() };
    }
    if (JSON.stringify(request.collection) !== JSON.stringify(collection())) throw { code: "storage_conflict", message: "Owned stale collection" };
    const affected: Head[] = [];
    if (request.operation === "clear") { epoch = String(BigInt(epoch) + BigInt(1)); rows.clear(); heads.clear(); }
    else if (request.operation === "import") {
      if (!legacyAllowed || heads.size || request.tasks?.length !== request.expectedHeads?.length) throw { code: "storage_conflict", message: "Owned closed import" };
      request.tasks!.forEach((task) => { const next: Head = { taskId: task.id, generation: "1", revision: "1", state: "live" }; rows.set(task.id, structuredClone(task)); heads.set(task.id, next); affected.push(next); });
    }
    else {
      const expected = request.expectedHead!;
      if (!expected || JSON.stringify(expected) !== JSON.stringify(head(expected.taskId))) throw { code: "storage_conflict", message: "Owned stale task head" };
      if ((request.operation === "create" && expected.state !== "never_seen")
        || (request.operation === "recreate" && expected.state !== "tombstone")
        || (request.operation === "update" && expected.state !== "live")) throw { code: "storage_conflict", message: "Owned operation state mismatch" };
      const generation = request.operation === "recreate" ? String(BigInt(expected.generation) + BigInt(1)) : expected.state === "never_seen" ? "1" : expected.generation;
      const revision = request.operation === "create" || request.operation === "recreate" || expected.state === "never_seen" ? "1" : String(BigInt(expected.revision) + BigInt(1));
      const next: Head = { taskId: expected.taskId, generation, revision, state: request.operation === "delete" ? "tombstone" : "live" };
      if (request.operation === "delete") rows.delete(expected.taskId);
      else rows.set(expected.taskId, structuredClone(request.task!));
      heads.set(expected.taskId, next); affected.push(next);
    }
    const receipt: Receipt = { protocolVersion: 1, requestId: request.requestId,
      digest: createHash("sha256").update(packet).digest("hex"), operation: request.operation,
      collection: collection(), heads: structuredClone(affected), sqlCommitted: true };
    receipts.set(request.requestId, { packet, receipt });
    legacyAllowed = false;
    return { scope: "sql", receipt, rejection: null, current: current() };
  }
  function query(request: Request) {
    const record = receipts.get(request?.requestId);
    if (record && record.packet !== JSON.stringify(request)) throw { code: "storage_conflict", message: "Owned original packet mismatch" };
    return { scope: "sql", receipt: record?.receipt ?? null, rejection: null, current: current() };
  }
  return { rows, heads, current, apply, query,
    snapshot: () => ({ settings: { ...defaultGlobalSettings(), systemLanguage: "en" as const, backendUrl: "https://owned.invalid/v1" },
      tasks: structuredClone([...rows.values()]), storage: { ...current(), legacyTaskImportAllowed: legacyAllowed } }),
    legacySave: (task: AnalysisTask) => { rows.set(task.id, structuredClone(task)); },
    legacyDelete: (id: string) => { rows.delete(id); heads.set(id, { taskId: id, generation: "1", revision: "2", state: "tombstone" }); },
    legacyClear: () => { epoch = String(BigInt(epoch) + BigInt(1)); rows.clear(); heads.clear(); },
  };
}

describe("desktop task mutation boundaries through the actual provider", () => {
  let root: Root, element: HTMLDivElement, center: ReturnType<typeof useTaskCenter>;
  let store: ReturnType<typeof ownedStore>, failBootstrap: boolean, loseDeleteAck: boolean, loseDeleteBeforeCommit: boolean, loseSaveBeforeCommit: boolean, loseImportBeforeCommit: boolean, sqlOnlyClear: boolean, allowScriptedRun: boolean, pendingScriptedWorker: boolean;
  let queryGate: ReturnType<typeof deferred<ReturnType<ReturnType<typeof ownedStore>["query"]>>> | undefined;
  let listener: ((event: { payload: AnalysisEvent }) => void) | undefined;
  let saveGate: ReturnType<typeof deferred> | undefined, saveEntered: ReturnType<typeof deferred>;
  let recovery: ReturnType<typeof transportFixture> | undefined;
  const actions: Promise<unknown>[] = [];
  function Consumer() { center = useTaskCenter(); return createElement("p", { "data-notice": true }, center.notice); }
  function commands(command: string) { return ipc.invoke.mock.calls.filter(([name]) => name === command); }
  async function mount() {
    await act(async () => root.render(createElement(TaskCenterProvider, null, createElement(Consumer))));
    await vi.waitFor(async () => { await act(async () => {}); expect(center.hydrated).toBe(true); });
  }
  beforeEach(() => {
    store = ownedStore([]); recovery = undefined; failBootstrap = false; loseDeleteAck = false; loseDeleteBeforeCommit = false; loseSaveBeforeCommit = false; loseImportBeforeCommit = false; sqlOnlyClear = false; allowScriptedRun = false; pendingScriptedWorker = false; listener = undefined; queryGate = undefined;
    saveGate = undefined; saveEntered = deferred(); actions.length = 0;
    vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: { invoke: (name: string, args?: Record<string, unknown>) => ipc.invoke(name, args) }, configurable: true });
    ipc.listen.mockReset().mockImplementation(async (_channel, handler) => { listener = handler; return vi.fn(); });
    ipc.invoke.mockReset().mockImplementation(async (command, args) => {
      if (command === "load_analysis_recovery") return { recoveryProtocolVersion: 1, storage: store.snapshot().storage, tasks: [...store.rows.values()], journals: [], clearBlockers: [], runtime: recoveryRuntime(), coherent: true };
      if (command === "reserve_analysis" && allowScriptedRun) {
        const request = JSON.parse(args.requestJson) as AdmissionRequest, task = store.rows.get(request.expectedHead.taskId)!;
        recovery = transportFixture({ captured: { packet: { request, requestJson: args.requestJson }, task, executionInputJson: "" },
          ...(pendingScriptedWorker ? { workerPending: true, events: [{ type: "progress" as const, message: "Fictional pending original worker", messageType: "info" as const }] } : {}) });
      }
      if (recovery && typeof args?.requestJson === "string") {
        const reply = await recovery.api.invoke(command, args);
        const current = (reply as { current?: RecoveryCurrent }).current;
        if (current?.state === "coherent" && current.task && current.head) { store.rows.set(current.task.id, structuredClone(current.task)); store.heads.set(current.head.taskId, structuredClone(current.head)); }
        return reply;
      }
      if (command === "load_desktop_data") { if (failBootstrap) throw new Error("Owned bootstrap unavailable"); return store.snapshot(); }
      if (command === "save_desktop_task") {
        saveEntered.resolve(); const captured = structuredClone(args); if (saveGate) await saveGate.promise;
        if (loseSaveBeforeCommit) throw new Error("Owned save acknowledgement unavailable");
        if (captured.request) return store.apply(captured.request);
        store.legacySave(captured.task); return;
      }
      if (command === "delete_desktop_task") {
        if (loseDeleteBeforeCommit) throw new Error("Owned transport unavailable before fictional worker completion");
        const reply = args.request ? store.apply(args.request) : store.legacyDelete(args.taskId);
        if (loseDeleteAck) throw new Error("Owned commit acknowledgement lost");
        return reply;
      }
      if (command === "query_desktop_task_mutation") return queryGate ? queryGate.promise : store.query(args.request);
      if (command === "import_legacy_desktop_tasks") { if (loseImportBeforeCommit) throw new Error("Owned import acknowledgement unavailable"); return store.apply(args.request); }
      if (command === "clear_desktop_data") {
        if (args?.request) { const reply = store.apply(args.request); return sqlOnlyClear ? reply : { ...reply, scope: "desktop_clear" }; }
        store.legacyClear(); return { scope: "sql", receipt: null, rejection: null, current: store.current() };
      }
      if (command === "reserve_analysis") throw { code: "analysis_conflict", message: recoveryMessages.analysis_conflict };
      if (command === "query_analysis_reservation") return { recoveryProtocolVersion: 1, scope: "analysis_admission", receipt: null, rejection: { code: "analysis_conflict", message: recoveryMessages.analysis_conflict }, matchedReservation: null, current: { state: "coherent", storage: store.current(), task: null, head: null, journal: null, runtime: recoveryRuntime() } };
      throw new Error(`Unexpected owned command ${command}`);
    });
    vi.spyOn(runtime, "getRuntimeAdapter").mockReturnValue({ ...runtime.tauriRuntimeAdapter,
      getRuntimeInfo: async () => ({ kind: "tauri", label: "Owned mutation transport fixture" }),
      loadDesktopData: async () => { if (failBootstrap) throw new Error("Owned bootstrap unavailable"); return store.snapshot(); },
    });
    element = document.createElement("div"); document.body.appendChild(element); root = createRoot(element);
  });
  afterEach(async () => {
    saveGate?.resolve();
    await act(async () => { await Promise.allSettled(actions); });
    await act(async () => root.unmount()); element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("blocks task writes and dispatch after failed desktop bootstrap even with queued legacy rows", async () => {
    const task = { ...createEmptyTask(defaultTaskDraft(), "owned-unconfirmed-legacy"), status: "queued", queueOrder: 1 };
    localStorage.setItem("evidenceloom.analysisTasks.v1", JSON.stringify([task])); failBootstrap = true;
    await mount(); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(commands("reserve_analysis")).toHaveLength(0); expect(commands("save_desktop_task")).toHaveLength(0);
    expect(center.notice).not.toBe("");
  });
  it("does not dispatch or announce confirmed creation before the initial SQL acknowledgement", async () => {
    await mount(); saveGate = deferred(); let resultObserved = false;
    await act(async () => { const action = center.createAndQueueTask({ ...defaultTaskDraft(), ticker: "FICT", instrumentName: "Owned fixture", analysisDate: "2026-08-01" }); actions.push(action); void action.then(() => { resultObserved = true; }); });
    await saveEntered.promise; await act(async () => {});
    expect.soft(resultObserved).toBe(false); expect.soft(commands("reserve_analysis")).toHaveLength(0);
    expect.soft(center.notice).not.toContain("Created analysis task");
    await act(async () => saveGate?.resolve()); await actions[0];
  });
  it("does not let a delayed initial demo save resurrect a task deleted before that save settles", async () => {
    await mount(); saveGate = deferred();
    await act(async () => { actions.push(Promise.resolve(center.createDemoTask())); });
    await saveEntered.promise;
    await act(async () => { actions.push(center.deleteTask(FICTIONAL_DEMO_TASK_ID)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); saveGate?.resolve(); });
    await act(async () => { await Promise.all(actions); });
    expect(store.rows.has(FICTIONAL_DEMO_TASK_ID)).toBe(false);
    expect(store.heads.get(FICTIONAL_DEMO_TASK_ID)?.state).toBe("tombstone");
  });
  it("queries the exact original delete packet after an acknowledgement is lost", async () => {
    const task = createEmptyTask(defaultTaskDraft(), "owned-lost-delete"); store = ownedStore([task]); loseDeleteAck = true; await mount();
    let result!: boolean;
    await act(async () => { result = await center.deleteTask(task.id); });
    const original = commands("delete_desktop_task")[0]?.[1]?.request;
    expect(original).toMatchObject({ protocolVersion: 1, operation: "delete", expectedHead: { taskId: task.id, generation: "1", revision: "1" } });
    expect(commands("query_desktop_task_mutation")).toEqual([["query_desktop_task_mutation", { request: original }]]);
    expect(result).toBe(true); expect(center.tasks.some((row) => row.id === task.id)).toBe(false);
  });
  it("does not promote a historical SQL clear reply into settings or whole-clear success", async () => {
    store = ownedStore([createEmptyTask(defaultTaskDraft(), "owned-clear-reply")]); sqlOnlyClear = true; await mount();
    const settingsBefore = JSON.stringify(center.settings); let result!: boolean;
    await act(async () => { result = await center.clearAllLocalData(); });
    expect(result).toBe(false); expect(JSON.stringify(center.settings)).toBe(settingsBefore);
    expect(center.notice).not.toBe("Local data cleared.");
  });
  it("does not import legacy tasks into an empty authority whose import marker is closed", async () => {
    const legacy = createEmptyTask(defaultTaskDraft(), "owned-old-legacy"); localStorage.setItem("evidenceloom.analysisTasks.v1", JSON.stringify([legacy]));
    await mount(); expect(center.tasks).toHaveLength(0); expect(commands("import_legacy_desktop_tasks")).toHaveLength(0);
    expect(localStorage.getItem("evidenceloom.analysisTasks.v1")).toBe(JSON.stringify([legacy]));
  });
  it("keeps an unknown delete blocked and exposes actual original-request confirmation retry", async () => {
    const task = createEmptyTask(defaultTaskDraft(), "owned-unknown-delete"); store = ownedStore([task]); loseDeleteBeforeCommit = true; await mount();
    let deleted!: boolean; await act(async () => { deleted = await center.deleteTask(task.id); }); expect(deleted).toBe(false); expect(center.tasks).toHaveLength(1); expect(center.storageState).toBe("unknown");
    const original = commands("delete_desktop_task")[0][1].request;
    // Fictional late worker commit uses the same admitted packet; no real SQL.
    store.apply(original); const retry = [...element.querySelectorAll("button")].find((button) => button.textContent === "Retry task storage confirmation"); expect(retry).toBeDefined();
    await act(async () => retry!.click()); await vi.waitFor(async () => { await act(async () => {}); expect(center.tasks).toHaveLength(0); });
    expect(commands("delete_desktop_task")).toHaveLength(1); expect(commands("query_desktop_task_mutation").map(([, args]) => args.request)).toEqual([original, original]); expect(center.storageState).toBe("ready");
  });
  it("ignores the original actual adapter listener after clear and same-ID recreation", async () => {
    const task = { ...createEmptyTask({ ...defaultTaskDraft(), ticker: "FICT", instrumentName: "Owned fixture", analysisDate: "2026-08-01" }, FICTIONAL_DEMO_TASK_ID), status: "queued" as const, queueOrder: 1 };
    store = ownedStore([task]); allowScriptedRun = true; await mount();
    await vi.waitFor(async () => { await act(async () => {}); expect(center.tasks[0]?.status).toBe("completed"); expect(center.runningTask).toBeNull(); expect(center.storageState === undefined || center.storageState === "ready").toBe(true); });
    const oldListener = listener; expect(oldListener).toBeDefined(); expect(commands("reserve_analysis")).toHaveLength(1); expect(commands("start_analysis")).toHaveLength(1);
    await act(async () => { expect(await center.clearAllLocalData()).toBe(true); });
    await act(async () => { expect(await center.createDemoTask()).toBeDefined(); });
    const before = JSON.stringify(center.tasks), nativeBefore = JSON.stringify(store.rows.get(FICTIONAL_DEMO_TASK_ID)), writes = commands("save_desktop_task").length;
    await act(async () => oldListener?.({ payload: { type: "progress", message: "owned stale original-run event" } }));
    expect(JSON.stringify(center.tasks)).toBe(before); expect(JSON.stringify(store.rows.get(FICTIONAL_DEMO_TASK_ID))).toBe(nativeBefore); expect(commands("save_desktop_task")).toHaveLength(writes);
  });
  it("keeps a second demo open pending on the same original create acknowledgement", async () => {
    await mount(); saveGate = deferred(); let first!: Promise<AnalysisTask | undefined>, second!: Promise<AnalysisTask | undefined>, observed = false;
    await act(async () => { first = Promise.resolve(center.createDemoTask()); actions.push(first); }); await saveEntered.promise;
    await act(async () => { second = Promise.resolve(center.createDemoTask()); actions.push(second); void second.then(() => { observed = true; }); });
    expect(observed).toBe(false); expect(commands("save_desktop_task")).toHaveLength(1);
    await act(async () => { saveGate?.resolve(); await Promise.all([first, second]); }); expect(await first).toBeDefined(); expect(await second).toBeDefined();
  });
  it("does not return an optimistic existing demo whose original create is unknown", async () => {
    await mount(); loseSaveBeforeCommit = true;
    await act(async () => { expect(await center.createDemoTask()).toBeUndefined(); });
    await act(async () => { expect(await center.createDemoTask()).toBeUndefined(); }); expect(commands("save_desktop_task")).toHaveLength(1); expect(center.storageState).toBe("unknown");
  });
  it("resumes unknown legacy bootstrap import by querying its original packet", async () => {
    const legacy = createEmptyTask(defaultTaskDraft(), "owned-bootstrap-import"); localStorage.setItem("evidenceloom.analysisTasks.v1", JSON.stringify([legacy])); store = ownedStore([], true); loseImportBeforeCommit = true;
    await mount(); expect(center.storageState).not.toBe("ready"); expect(commands("import_legacy_desktop_tasks")).toHaveLength(1); const original = commands("import_legacy_desktop_tasks")[0][1].request; expect(original).toMatchObject({ operation: "import", protocolVersion: 1 }); store.apply(original);
    await act(async () => element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    await vi.waitFor(async () => { await act(async () => {}); expect(center.storageState).toBe("ready"); });
    expect(center.tasks[0].id).toBe(legacy.id); expect(commands("import_legacy_desktop_tasks")).toHaveLength(1); expect(commands("query_desktop_task_mutation").map(([, args]) => args.request)).toEqual([original, original]);
  });
  it("resumes an unknown captured history repair without creating a replacement write", async () => {
    const raw = createEmptyTask(defaultTaskDraft(), "owned-bootstrap-repair"); raw.reportSections.final_trade_decision = "Final rating: BUY"; store = ownedStore([raw]); loseSaveBeforeCommit = true;
    await mount(); expect(center.storageState).not.toBe("ready"); const original = commands("save_desktop_task")[0][1].request; expect(original).toMatchObject({ operation: "update", protocolVersion: 1 }); store.apply(original);
    await act(async () => element.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    await vi.waitFor(async () => { await act(async () => {}); expect(center.storageState).toBe("ready"); });
    expect(center.tasks[0].origin).toBe("analysis"); expect(commands("save_desktop_task")).toHaveLength(1); expect(commands("query_desktop_task_mutation").map(([, args]) => args.request)).toEqual([original, original]);
  });
  it("retires an old unknown intent after complete clear and isolates its late query from a fresh same-ID task", async () => {
    await mount(); loseSaveBeforeCommit = true; await act(async () => { expect(await center.createDemoTask()).toBeUndefined(); }); const original = commands("save_desktop_task")[0][1].request;
    const oldCut = store.query(original); queryGate = deferred(); let oldQuery!: Promise<void>;
    await act(async () => { oldQuery = center.retryTaskStorage(); actions.push(oldQuery); }); loseSaveBeforeCommit = false;
    await act(async () => { expect(await center.clearAllLocalData()).toBe(true); expect(await center.createDemoTask()).toBeDefined(); });
    const before = JSON.stringify(center.tasks), noticeBefore = center.notice; expect(center.storageState).toBe("ready");
    await act(async () => { queryGate?.resolve(oldCut); await oldQuery; });
    expect(center.storageState).toBe("ready"); expect(JSON.stringify(center.tasks)).toBe(before); expect(center.notice).toBe(noticeBefore); expect(store.current().collection.epoch).toBe("2");
  });

  it("persists a queued successor through the actual provider while the original native owner blocks admission, then dispatches in order after settlement", async () => {
    allowScriptedRun = true; pendingScriptedWorker = true; await mount();
    await vi.waitFor(() => expect(center.storageState).toBe("ready"));
    const draft = { ...defaultTaskDraft(), ticker: "FICT", instrumentName: "Owned queued fixture", analysisDate: "2026-08-01" };
    let first!: Awaited<ReturnType<typeof center.createAndQueueTask>>;
    await act(async () => { first = await center.createAndQueueTask(draft); });
    expect(first.errors).toEqual([]); const a = first.task; if (!a) throw new Error("Expected the confirmed original task.");
    await vi.waitFor(async () => { await act(async () => {}); expect(center.getTask(a.id)?.status).toBe("running"); expect(commands("start_analysis")).toHaveLength(1); });
    const original = recovery; if (!original) throw new Error("Expected the actual provider's original recovery session.");
    const originalOwner = original.current().runtime.owner; expect(originalOwner?.origin.taskId).toBe(a.id);
    expect(original.current().runtime.runtimeGate).toBe("occupied");
    const stopGate = deferred(); original.setStopBarrier(stopGate.promise);
    try {
      let second!: Awaited<ReturnType<typeof center.createAndQueueTask>>;
      await act(async () => { second = await center.createAndQueueTask(draft); });
      expect(second.errors).toEqual([]); const successor = second.task; if (!successor) throw new Error("Expected the confirmed successor task.");
      await vi.waitFor(async () => { await act(async () => {}); expect(store.rows.get(successor.id)?.status).toBe("queued"); expect(center.getTask(successor.id)?.status).toBe("queued"); });
      expect(store.rows.get(a.id)?.status).toBe("running");
      expect(commands("save_desktop_task").filter(([, args]) => args.request?.expectedHead?.taskId === successor.id).map(([, args]) => args.request.operation)).toEqual(["create", "update"]);
      expect(commands("reserve_analysis")).toHaveLength(1); expect(commands("start_analysis")).toHaveLength(1);
      expect(recovery).toBe(original); expect(original.current().runtime.owner).toMatchObject({ origin: originalOwner?.origin, journalId: originalOwner?.journalId });
      await act(async () => center.stopRunningTask());
      await act(async () => {});
      expect(center.getTask(successor.id)?.status).toBe("queued"); expect(commands("reserve_analysis")).toHaveLength(1); expect(commands("start_analysis")).toHaveLength(1);
      pendingScriptedWorker = false; await act(async () => stopGate.resolve());
      await vi.waitFor(async () => { await act(async () => {}); expect(center.getTask(a.id)?.status).toBe("stopped"); expect(center.getTask(successor.id)?.status).toBe("completed"); expect(center.runningTask).toBeNull(); }, { timeout: 2500 });
      expect(commands("reserve_analysis").map(([, args]) => JSON.parse(args.requestJson).expectedHead.taskId)).toEqual([a.id, successor.id]);
      expect(commands("start_analysis").map(([, args]) => JSON.parse(args.requestJson).origin.taskId)).toEqual([a.id, successor.id]);
      const settled = original.current(); expect(settled.runtime.runtimeGate).toBe("vacant");
      if (settled.state !== "coherent") throw new Error("Expected the original settled current.");
      expect(settled.journal?.appliedSeq).toBe(settled.journal?.sealedThroughSeq); expect(settled.journal?.cleanupState).toBe("confirmed");
    } finally {
      pendingScriptedWorker = false; stopGate.resolve();
      if (center.runningTask?.id === a.id) await act(async () => center.stopRunningTask());
    }
  });
  it.each(["unavailable", "unknown"] as const)("still refuses a queued write when task storage is %s even with a valid analysis task", async (state) => {
    const draft = { ...defaultTaskDraft(), ticker: "FICT", instrumentName: "Owned blocked queue", analysisDate: "2026-08-01" };
    let task = createEmptyTask(draft, "owned-storage-gated-queue");
    if (state === "unavailable") { store = ownedStore([task]); failBootstrap = true; await mount(); }
    else {
      await mount(); loseSaveBeforeCommit = true;
      await act(async () => { const result = await center.createAndQueueTask(draft); expect(result.errors.length).toBeGreaterThan(0); });
      expect(center.storageState).toBe("unknown"); task = center.tasks[0]; expect(task.origin).toBe("analysis"); expect(task.status).toBe("idle");
    }
    const writes = commands("save_desktop_task").length;
    await act(async () => { expect(center.queueTask(task.id, task)).toBe(false); });
    expect(commands("save_desktop_task")).toHaveLength(writes); expect(commands("reserve_analysis")).toHaveLength(0); expect(commands("start_analysis")).toHaveLength(0);
    expect(task.status).toBe("idle");
  });
});
