import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyTask, defaultTaskDraft } from "@/lib/analysis";
import type { AnalysisTask } from "@/lib/types";
import type { StorageReply, TaskHead, TaskMutationRequest } from "../types";
import { DesktopTaskMutations } from "./mutations";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve: (value?: T) => resolve(value as T) }; }
const collection = { collectionId: "owned-collection", epoch: "1" };
const makeTask = (id: string) => createEmptyTask(defaultTaskDraft(), id);
const live = (id: string, revision = "1"): TaskHead => ({ taskId: id, generation: "1", revision, state: "live" });
// Successful transition oracle only. It neither uses SQLite nor claims to model
// native canonical digest, transaction durability, or OS clear effects.
function ack(request: TaskMutationRequest, heads?: TaskHead[], scope: "sql" | "desktop_clear" = "sql"): StorageReply {
  const currentCollection = { ...request.collection, epoch: request.operation === "clear" ? String(BigInt(request.collection.epoch) + BigInt(1)) : request.collection.epoch };
  const expected = request.operation === "clear" ? [] : request.operation === "import" ? request.expectedHeads : [request.expectedHead];
  const affected: TaskHead[] = expected.map((head) => ({ taskId: head.taskId, generation: head.state === "never_seen" ? "1" : request.operation === "recreate" ? String(BigInt(head.generation) + BigInt(1)) : head.generation,
    revision: head.state === "never_seen" || request.operation === "recreate" ? "1" : String(BigInt(head.revision) + BigInt(1)), state: request.operation === "delete" ? "tombstone" : "live" }));
  return { scope, receipt: { protocolVersion: 1, requestId: request.requestId, operation: request.operation, digest: "a".repeat(64), collection: currentCollection, heads: affected, sqlCommitted: true }, rejection: null, current: { collection: currentCollection, heads: heads ?? affected } };
}
function unknown(request: TaskMutationRequest): StorageReply { return { scope: "sql", receipt: null, rejection: null, current: { collection: request.collection, heads: [] } }; }
function setup(tasks: AnalysisTask[] = [], heads = tasks.map((task) => live(task.id)), importAllowed = false) {
  const execute = vi.fn(async (request: TaskMutationRequest, before: () => void) => { before(); return ack(request); });
  const query = vi.fn(async (request: TaskMutationRequest) => unknown(request));
  const store = new DesktopTaskMutations({ execute, query }); store.initialize({ collection, heads, legacyTaskImportAllowed: importAllowed }, tasks); store.seal();
  return { store, execute, query };
}
beforeEach(() => vi.stubGlobal("crypto", webcrypto)); afterEach(() => vi.unstubAllGlobals());

describe("operation-local native task causal intents with fictional transport", () => {
  it("fails closed before bootstrap and after disposal", () => { const empty = new DesktopTaskMutations({ execute: vi.fn(), query: vi.fn() }); expect(() => empty.prepareCreate(makeTask("a"))).toThrow(); const { store } = setup(); store.dispose(); expect(() => store.prepareCreate(makeTask("a"))).toThrow(); });
  it("freezes body at intent capture, before any asynchronous transport", async () => {
    const { store, execute } = setup(), task = makeTask("a"), action = store.prepareCreate(task); task.ticker = "CHANGED";
    await store.commit(action); expect(execute.mock.calls[0][0].operation).toBe("create"); expect(JSON.stringify(execute.mock.calls[0][0])).not.toContain("CHANGED");
  });
  it("chains an exact create receipt into a child update without refreshing the token", async () => {
    const { store, execute } = setup(), task = makeTask("a"), create = store.prepareCreate(task), child = store.prepareUpdate(create, (original) => ({ ...original, instrumentName: "owned child" }));
    expect((await store.commit(child)).kind).toBe("committed");
    const request = execute.mock.calls[1][0]; expect(request.operation).toBe("update"); if (request.operation !== "update") throw new Error(); expect(request.expectedHead).toEqual(live("a")); expect(request.task.instrumentName).toBe("owned child");
  });
  it("does not attach an independent stale review to the current local tail", () => {
    const task = makeTask("a"), { store } = setup([task]), original = store.capture(task); store.prepareUpdate(original, (body) => ({ ...body, ticker: "FIRST" }));
    expect(() => store.prepareUpdate(original, (body) => ({ ...body, ticker: "STALE" }))).toThrow();
  });
  it("deletes an unsent initial create using its captured never-seen token", async () => {
    const { store, execute } = setup(), task = makeTask("a"), create = store.prepareCreate(task), remove = store.prepareDelete(task);
    await store.commit(remove); expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0][0].operation).toBe("delete"); expect(() => store.commit(create)).toThrow();
  });
  it("never treats a sent unknown create as absent or stamps a descendant with a latest head", async () => {
    const { store, execute, query } = setup(); execute.mockImplementation(async (_request, before) => { before(); throw new Error("lost ack"); });
    const task = makeTask("a"), create = store.prepareCreate(task); expect((await store.commit(create)).kind).toBe("unknown");
    const remove = store.prepareDelete(task); expect((await store.commit(remove)).kind).toBe("unknown"); expect(execute).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0]).toBe(execute.mock.calls[0][0]);
  });
  it("uses a repaired original parent outcome for child admission instead of its old cached promise", async () => {
    const { store, execute, query } = setup(); execute.mockImplementationOnce(async (_request, before) => { before(); throw new Error("lost ack"); });
    const task = makeTask("a"), create = store.prepareCreate(task), child = store.prepareUpdate(create, (body) => ({ ...body, instrumentName: "child" }));
    expect((await store.commit(create)).kind).toBe("unknown"); query.mockImplementation(async (request) => ack(request)); expect((await store.retry(create)).kind).toBe("committed");
    expect((await store.commit(child)).kind).toBe("committed"); expect(await store.awaitAdmission(child)).toBe(true); expect(execute.mock.calls[1][0].operation).toBe("update");
  });
  it("resumes an unsent exact child after its original unknown predecessor is confirmed", async () => {
    const { store, execute, query } = setup(); execute.mockImplementationOnce(async (_request, before) => { before(); throw new Error("lost ack"); });
    const task = makeTask("a"), create = store.prepareCreate(task), child = store.prepareUpdate(create, (body) => ({ ...body, instrumentName: "child" }));
    expect((await store.commit(child)).kind).toBe("unknown"); query.mockImplementation(async (request) => ack(request)); await store.retry(create);
    expect((await store.retry(child)).kind).toBe("committed"); expect(await store.awaitAdmission(child)).toBe(true); expect(execute).toHaveBeenCalledTimes(2);
  });
  it("composes an independently captured exact predecessor into the original run without losing its body", async () => {
    const task = makeTask("a"), { store, execute } = setup([task]), original = store.capture(task), run = store.captureRun(original);
    const review = store.prepareUpdate(original, (body) => ({ ...body, instrumentName: "owned historical review projection" }));
    const event = store.prepareRunUpdate(run, (body) => ({ ...body, status: "completed" }));
    await store.commit(event); expect(execute).toHaveBeenCalledTimes(2); const packet = execute.mock.calls[1][0];
    if (packet.operation !== "update") throw new Error(); expect(packet.expectedHead.revision).toBe("2"); expect(packet.task.instrumentName).toBe("owned historical review projection"); expect(packet.task.status).toBe("completed"); expect(await store.awaitAdmission(event)).toBe(true);
    expect(() => store.prepareUpdate(original, (body) => body)).toThrow(); expect(await store.awaitAdmission(review)).toBe(false);
  });
  it("preserves known original SQL commitment when an older concurrent query returns null", async () => {
    const { store, execute, query } = setup(); execute.mockImplementationOnce(async (_request, before) => { before(); throw new Error("lost ack"); });
    const create = store.prepareCreate(makeTask("a")); await store.commit(create); const late = deferred<StorageReply>(); query.mockImplementationOnce(() => late.promise).mockImplementationOnce(async (request) => ack(request));
    const oldQuery = store.retry(create); expect((await store.retry(create)).kind).toBe("committed"); late.resolve(unknown(execute.mock.calls[0][0])); expect((await oldQuery).kind).toBe("committed"); expect(await store.awaitAdmission(create)).toBe(true);
  });
  it("distinguishes durable SQL rejection from a direct unavailable error", async () => {
    const { store, execute, query } = setup(); execute.mockImplementation(async (_request, before) => { before(); throw { code: "storage_unavailable", message: "owned" }; });
    query.mockImplementation(async (request) => ({ ...unknown(request), rejection: { code: "storage_unavailable", message: "durable rejected original" } }));
    expect((await store.commit(store.prepareCreate(makeTask("a")))).kind).toBe("rejected"); expect(execute).toHaveBeenCalledTimes(1);
  });
  it("stops at the actual before-invoke boundary when disposed during transport preparation", async () => {
    const { store, execute } = setup(); const entered = deferred<void>(), release = deferred<void>(); let invoked = false;
    execute.mockImplementation(async (request, before) => { entered.resolve(); await release.promise; before(); invoked = true; return ack(request); });
    const work = store.commit(store.prepareCreate(makeTask("a"))); await entered.promise; store.dispose(); release.resolve(); expect((await work).kind).toBe("rejected"); expect(invoked).toBe(false);
  });
  it("retains newer complete heads when globally valid cuts acknowledge in reverse order", async () => {
    const a = makeTask("a"), b = makeTask("b"), { store, execute } = setup([a, b]); const delayedA = deferred<StorageReply>();
    execute.mockImplementation(async (request, before) => { before(); return request.operation !== "clear" && request.operation !== "import" && request.expectedHead.taskId === "a" ? delayedA.promise : ack(request, [live("a", "2"), live("b", "2")]); });
    const first = store.prepareUpdate(store.capture(a), (body) => ({ ...body, ticker: "A2" })), second = store.prepareUpdate(store.capture(b), (body) => ({ ...body, ticker: "B2" }));
    const firstWork = store.commit(first); await store.commit(second); delayedA.resolve(ack(execute.mock.calls[0][0], [live("a", "2"), live("b")])); expect((await firstWork).kind).toBe("committed");
    const next = store.prepareUpdate(second, (body) => ({ ...body, ticker: "B3" })); await store.commit(next); const packet = execute.mock.calls[2][0]; if (packet.operation !== "update") throw new Error(); expect(packet.expectedHead.revision).toBe("2");
  });
  it("rejects equal-generation/revision state disagreement", async () => {
    const task = makeTask("a"), { store, execute } = setup([task]); execute.mockImplementation(async (request, before) => { before(); return ack(request, [{ ...live("a"), state: "tombstone" }]); });
    expect((await store.commit(store.prepareUpdate(store.capture(task), (body) => body))).kind).toBe("unknown");
  });
  it("retains a later tombstone omitted by an earlier complete cut and explicitly recreates its generation", async () => {
    const a = makeTask("a"), { store, execute } = setup([a]), delayed = deferred<StorageReply>(), entered = deferred<void>();
    execute.mockImplementation(async (request, before) => {
      before(); if (request.operation !== "clear" && request.operation !== "import" && request.expectedHead.taskId === "a") { entered.resolve(); return delayed.promise; }
      const own = ack(request); return { ...own, current: { collection, heads: [live("a", "2"), ...own.receipt!.heads] } };
    });
    const first = store.prepareUpdate(store.capture(a), (body) => ({ ...body, ticker: "A2" })), work = store.commit(first); await entered.promise;
    const b = makeTask("b"); await store.commit(store.prepareCreate(b)); await store.commit(store.prepareDelete(b));
    delayed.resolve(ack(execute.mock.calls[0][0], [live("a", "2")])); expect((await work).kind).toBe("committed");
    await store.commit(store.prepareCreate(makeTask("b"))); const packet = execute.mock.calls[3][0]; expect(packet.operation).toBe("recreate");
    if (packet.operation !== "recreate") throw new Error(); expect(packet.expectedHead).toEqual({ ...live("b", "2"), state: "tombstone" });
  });
  it("makes an old run owner inert after clear and same-ID creation", async () => {
    const task = makeTask("a"), { store, execute } = setup([task]), run = store.captureRun(store.capture(task)); execute.mockImplementation(async (request, before) => { before(); return ack(request, undefined, request.operation === "clear" ? "desktop_clear" : "sql"); });
    await store.commit(store.prepareClear()); await store.commit(store.prepareCreate(makeTask("a"))); const count = execute.mock.calls.length;
    expect(() => store.prepareRunUpdate(run, (body) => ({ ...body, ticker: "OLD EVENT" }))).toThrow(); expect(execute).toHaveBeenCalledTimes(count);
  });
  it("does not let a SQL-only clear receipt authorize broad success or another OS clear", async () => {
    const { store, execute } = setup(); const clear = store.prepareClear(); const result = await store.commit(clear); expect(store.publishable(clear, result)).toBe(false); expect(store.ready).toBe(false);
    const again = store.prepareClear(); await store.confirm(again); expect(execute).toHaveBeenCalledTimes(1); expect(() => store.prepareCreate(makeTask("a"))).toThrow();
  });
  it("permits a fresh explicit clear after known no-OS rejection", async () => {
    const { store, execute } = setup(); execute.mockImplementationOnce(async () => { throw { code: "storage_owned", message: "owned refusal" }; });
    expect((await store.commit(store.prepareClear())).kind).toBe("rejected"); expect(store.ready).toBe(true); await store.commit(store.prepareClear()); expect(execute).toHaveBeenCalledTimes(2); expect(execute.mock.calls[0][0].requestId).not.toBe(execute.mock.calls[1][0].requestId);
  });
  it("does not let an old rejected clear query release a newer pending clear", async () => {
    const { store, execute, query } = setup(); execute.mockImplementationOnce(async () => { throw { code: "storage_owned", message: "owned refusal" }; }); const old = store.prepareClear(); await store.commit(old);
    const pending = deferred<StorageReply>(); execute.mockImplementationOnce(async (_request, before) => { before(); return pending.promise; }); const current = store.prepareClear(), work = store.commit(current);
    query.mockImplementation(async (request) => ({ ...unknown(request), rejection: { code: "storage_owned", message: "owned refusal" } })); await store.retry(old); expect(store.ready).toBe(false); expect(() => store.prepareCreate(makeTask("a"))).toThrow();
    pending.resolve(ack(execute.mock.calls[1][0], [], "desktop_clear")); expect(store.publishable(current, await work)).toBe(true);
  });
  it("keeps partial clear uncertain and never repeats its OS command", async () => {
    const { store, execute } = setup(); execute.mockImplementation(async (_request, before) => { before(); throw { code: "storage_partial_clear", message: "owned partial" }; });
    const action = store.prepareClear(); expect((await store.commit(action)).kind).toBe("unknown"); await store.confirm(store.prepareClear()); expect(execute).toHaveBeenCalledTimes(1); expect(store.ready).toBe(false);
  });
  it("retains original query-only confirmation after a durable partial-clear rejection", async () => {
    const { store, execute, query } = setup(); execute.mockImplementation(async (_request, before) => { before(); throw { code: "storage_partial_clear", message: "owned partial" }; });
    query.mockImplementation(async (request) => ({ ...unknown(request), rejection: { code: "storage_partial_clear", message: "durable task SQL rejection; OS uncertain" } }));
    const action = store.prepareClear(); expect((await store.commit(action)).kind).toBe("rejected"); expect(store.needsConfirmation(action)).toBe(true); await store.confirm(store.prepareClear()); expect(query).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledTimes(1); expect(store.ready).toBe(false);
  });
  it("retires old unknown SQL work after complete clear and ignores a late original query", async () => {
    const task = makeTask("a"), { store, execute, query } = setup([task]); execute.mockImplementationOnce(async (_request, before) => { before(); throw new Error("owned lost ack"); });
    const original = store.prepareUpdate(store.capture(task), (body) => ({ ...body, ticker: "OLD" })); await store.commit(original); const late = deferred<StorageReply>(); query.mockImplementationOnce(() => late.promise);
    const oldQuery = store.retry(original); execute.mockImplementation(async (request, before) => { before(); return ack(request, undefined, request.operation === "clear" ? "desktop_clear" : "sql"); });
    const clear = store.prepareClear(); expect(store.publishable(clear, await store.commit(clear))).toBe(true); expect(store.ready).toBe(true);
    const fresh = store.prepareCreate(makeTask("a")); await store.commit(fresh); late.resolve(unknown(execute.mock.calls[0][0])); await oldQuery;
    expect(store.ready).toBe(true); expect(store.needsConfirmation(original)).toBe(false); expect(await store.awaitAdmission(fresh)).toBe(true); expect(execute.mock.calls.map(([request]) => request.operation)).toEqual(["update", "clear", "create"]);
  });
  it("preserves an already verified immutable SQL receipt when a contradictory digest arrives", async () => {
    const { store, query } = setup(), action = store.prepareCreate(makeTask("a")); const committed = await store.commit(action); expect(committed.kind).toBe("committed");
    query.mockImplementation(async (request) => { const reply = ack(request); return { ...reply, receipt: { ...reply.receipt!, digest: "b".repeat(64) } }; });
    const later = await store.retry(action); expect(later.kind).toBe("committed"); if (later.kind !== "committed") throw new Error(); expect(later.reply.receipt?.digest).toBe("a".repeat(64)); expect(later.publishable).toBe(false);
  });
  it("preserves direct broad-ACK history without promoting a later SQL query into a new broad success", async () => {
    const { store, execute, query } = setup(); execute.mockImplementation(async (request, before) => { before(); return ack(request, [], "desktop_clear"); });
    const clear = store.prepareClear(); expect(store.publishable(clear, await store.commit(clear))).toBe(true); query.mockImplementation(async (request) => ack(request, [], "sql"));
    const result = await store.retry(clear); expect(result.kind).toBe("committed"); if (result.kind !== "committed") throw new Error(); expect(result.reply.scope).toBe("desktop_clear"); expect(store.publishable(clear, result)).toBe(false); expect(execute).toHaveBeenCalledTimes(1);
  });
  it("invalidates only the retired recovery incarnation and accepts a canonical same-ID recreation", () => {
    const old = makeTask("a"), other = makeTask("b"), { store } = setup([old, other]), action = store.capture(old), replacement = makeTask("a");
    const newer = { ...live("a"), generation: "2" };
    expect(store.retireRecovery(action, { collection, heads: [newer, live("b")] })).toBe(true); expect(store.recoveryRelevant(action)).toBe(false); expect(store.identity(other)).toBeDefined();
    store.initialize({ collection, heads: [newer, live("b")], legacyTaskImportAllowed: false }, [replacement, other]); store.seal(); expect(store.recoveryParent(store.capture(replacement)).head.generation).toBe("2"); expect(() => store.prepareUpdate(action, (body) => body)).toThrow();
  });
  it("refuses retirement while the same live generation remains or broad clear is unresolved", () => {
    const old = makeTask("a"), { store } = setup([old]), action = store.capture(old);
    expect(store.retireRecovery(action, { collection, heads: [live("a", "2")] })).toBe(false); expect(store.recoveryRelevant(action)).toBe(true);
    store.prepareClear(); expect(store.retireRecovery(action, { collection: { ...collection, epoch: "2" }, heads: [] })).toBe(false);
  });
});
