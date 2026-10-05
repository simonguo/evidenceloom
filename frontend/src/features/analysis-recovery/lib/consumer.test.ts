import { describe, expect, it, vi } from "vitest";
import { SameSessionConsumer } from "./consumer";
import { RecoveryAdmissionRejectedError, RecoveryPendingError } from "./transport";
import { recoveryMessages } from "./protocol";
import { envelope } from "../test-support/fixtures";
import { deferred, transportFixture } from "../test-support/transport-fixture";
import type { RecoveryCurrent, RecoveryPhase } from "../types";
import { reduceJournalPage } from "./reducer";

function consumer(fixture: ReturnType<typeof transportFixture>) {
  const publications: RecoveryCurrent[] = [], phases: RecoveryPhase[] = [];
  const session = new SameSessionConsumer(fixture.captured, async () => fixture.api, { relevant: () => true, publish: (current) => { publications.push(current); return true; }, changed: (phase) => phases.push(phase) });
  return { session, publications, phases };
}

describe("same-session journal consumer with fictional transport", () => {
  it("acknowledges subscription and reset projection before one start, then commits each server page", async () => {
    const f = transportFixture({ pageSize: 1, events: [{ type: "report", reportSections: { market_report: "partial" } }, { type: "completed", reportSections: { market_report: "complete" } }] }), c = consumer(f);
    let listened = false; f.api.listen = async () => { listened = true; return () => undefined; };
    f.setHook((command) => { if (command === "start_analysis") expect(listened).toBe(true); });
    await c.session.run();
    const commands = f.calls.map((call) => call.command), start = commands.indexOf("start_analysis");
    expect(commands.slice(0, start)).toContain("commit_analysis_projection"); expect(commands.filter((name) => name === "start_analysis")).toHaveLength(1);
    const packets = f.calls.filter((call) => call.command === "commit_analysis_projection").map((call) => JSON.parse(call.args.requestJson));
    expect(packets.map((packet) => [packet.expectedAppliedSeq, packet.throughSeq])).toEqual([["0", "1"], ["1", "2"], ["2", "3"], ["3", "4"]]);
    expect(c.session.phase).toBe("ready"); expect(f.task().reportVersions).toHaveLength(1); expect(f.task().status).toBe("completed");
  });
  it("queries the immutable lost start ACK without resupplying execution input or spawning twice", async () => {
    const f = transportFixture(), c = consumer(f); let failed = false;
    f.setHook((command) => { if (command === "start_analysis" && !failed) { failed = true; throw new Error("owned ACK lost after acceptance"); } });
    await c.session.run();
    const start = f.calls.find((call) => call.command === "start_analysis")!, query = f.calls.find((call) => call.command === "query_analysis_start")!;
    expect(query.args.requestJson).toBe(start.args.requestJson); expect(query.args.executionInputJson).toBeUndefined(); expect(f.calls.filter((call) => call.command === "start_analysis")).toHaveLength(1); expect(c.session.phase).toBe("ready");
  });
  it("retains a prestart listener failure until the truthful not-started sealed cursor is saved", async () => {
    const f = transportFixture({ listenerFailure: true }), c = consumer(f);
    await expect(c.session.run()).rejects.toBeInstanceOf(RecoveryPendingError);
    expect(f.calls.some((call) => call.command === "start_analysis")).toBe(false); expect(f.calls.filter((call) => call.command === "stop_analysis")).toHaveLength(1); expect(c.session.phase).toBe("result_pending");
    await c.session.retryResult(); expect(c.session.phase).toBe("ready"); expect(f.task().status).toBe("stopped"); expect(f.calls.some((call) => call.command === "start_analysis")).toBe(false);
  });
  it("shares the exact in-flight stop across an abort and a stop button", async () => {
    const f = transportFixture(), c = consumer(f), barrier = deferred<void>(); f.setStopBarrier(barrier.promise);
    const first = c.session.stop(), second = c.session.stop(); expect(second).toBe(first);
    // Synchronize on the actual command, not a fixed number of microtasks.
    await new Promise<void>((resolve) => f.setHook((command) => { if (command === "query_analysis_reservation") resolve(); }));
    barrier.resolve(); await Promise.all([first, second]);
    expect(f.calls.filter((call) => call.command === "stop_analysis")).toHaveLength(1); expect(f.calls.some((call) => call.command === "query_analysis_control")).toBe(false);
    await c.session.retryResult(); expect(c.session.phase).toBe("ready");
  });
  it("releases only a known non-admitted rejection with no witness and actual native ready gates", async () => {
    const f = transportFixture({ rejectedAdmission: true }), c = consumer(f);
    await expect(c.session.run()).rejects.toBeInstanceOf(RecoveryAdmissionRejectedError); expect(c.session.phase).toBe("ready"); expect(f.calls.some((call) => call.command === "start_analysis")).toBe(false);
    const uncertain = transportFixture({ rejectedAdmission: true }), pending = consumer(uncertain);
    uncertain.setHook((command) => { if (command === "query_analysis_reservation") throw new Error("owned query unavailable"); });
    await expect(pending.session.run()).rejects.toBeInstanceOf(RecoveryPendingError); expect(pending.session.phase).toBe("result_pending");
  });
  it("recaptures a new canonical parent after a pending original projection query confirms conflict", async () => {
    const f = transportFixture(), c = consumer(f); let overtook = false, queryUnavailable = false;
    f.setHook((command) => {
      if (command === "read_analysis_journal" && !overtook) { overtook = true; f.canonical({ ...f.task(), instrumentName: "Confirmed concurrent name" }); }
      if (command === "query_analysis_projection" && !queryUnavailable) { queryUnavailable = true; throw new Error("owned first conflict query unavailable"); }
    });
    await expect(c.session.run()).rejects.toBeInstanceOf(RecoveryPendingError);
    const original = f.calls.find((call) => call.command === "commit_analysis_projection")!;
    await c.session.retryResult();
    const commands = f.calls.filter((call) => call.command === "commit_analysis_projection");
    expect(commands[1].args.requestJson).not.toBe(original.args.requestJson); expect(JSON.parse(commands[1].args.requestJson).expectedHead.revision).toBe("2"); expect(f.task().reportVersions[0].task.instrumentName).toBe("Confirmed concurrent name"); expect(c.session.phase).toBe("ready");
  });
  it("reads an acknowledged winning critical prefix for metadata without projecting its body twice", async () => {
    const f = transportFixture({ pageSize: 1, events: [{ type: "progress" }, { type: "progress" }, { type: "completed", reportSections: { market_report: "later safe" } }] }), c = consumer(f); let won = false;
    f.setHook(async (command, request) => {
      if (command === "start_analysis") f.rows[2] = envelope(f.header, 3, "publication_unavailable", { sourceType: "completed", channels: [{ channel: "decision", reason: "unsafe_content" }], outcome: "analysis_failed", code: "analysis_publication_unavailable", safeAnalysis: { type: "completed" } });
      if (command === "commit_analysis_projection" && request.throughSeq === "2" && !won) {
        won = true; const reduced = await reduceJournalPage(f.task(), f.header, [f.rows[2]]); f.canonical(reduced.task, "3"); throw new Error("owned ACK lost after another projector won");
      }
    });
    await c.session.run();
    expect(f.calls.filter((call) => call.command === "commit_analysis_projection").map((call) => JSON.parse(call.args.requestJson).throughSeq)).not.toContain("3");
    expect(f.calls.filter((call) => call.command === "read_analysis_journal").some((call) => { const packet = JSON.parse(call.args.requestJson); return packet.afterSeq === "2" && packet.throughSeq === "3"; })).toBe(true);
    expect(f.task().reportVersions).toHaveLength(0); expect(f.task().error).toBe(recoveryMessages.analysis_publication_unavailable); expect(c.session.phase).toBe("ready");
  });
  it("bounds a never-returning listener, stops the exact reservation and disposes a late registration", async () => {
    vi.useFakeTimers(); const f = transportFixture(), c = consumer(f), registration = deferred<() => void>(), listening = deferred<void>(), unlisten = vi.fn();
    f.api.listen = () => { listening.resolve(); return registration.promise; };
    try {
      const result = c.session.run(); const rejected = expect(result).rejects.toBeInstanceOf(RecoveryPendingError);
      await listening.promise; await vi.advanceTimersByTimeAsync(5000); await rejected;
      expect(c.session.phase).toBe("result_pending"); expect(f.calls.filter((call) => call.command === "stop_analysis")).toHaveLength(1); expect(f.calls.some((call) => call.command === "start_analysis")).toBe(false);
      await c.session.retryResult(); expect(c.session.phase).toBe("ready");
      registration.resolve(unlisten); await registration.promise; await Promise.resolve();
      expect(unlisten).toHaveBeenCalledTimes(1); expect(f.calls.some((call) => call.command === "start_analysis")).toBe(false);
    } finally { c.session.dispose(); vi.useRealTimers(); }
  });
  it("keeps an unknown delayed admission blocked and queries the original packet after its late ACK", async () => {
    vi.useFakeTimers(); const f = transportFixture(), c = consumer(f), acknowledged = deferred<unknown>(), invoked = deferred<void>(), invoke = f.api.invoke;
    let originalReply: unknown, confirmed = false;
    f.api.invoke = async (command, args) => {
      const reply = await invoke(command, args);
      if (command === "reserve_analysis") { originalReply = reply; invoked.resolve(); return acknowledged.promise; }
      if (command === "query_analysis_reservation" && !confirmed) return { ...(reply as Record<string, unknown>), receipt: null, rejection: null };
      return reply;
    };
    try {
      const result = c.session.run(); const rejected = expect(result).rejects.toBeInstanceOf(RecoveryPendingError);
      await invoked.promise; await vi.advanceTimersByTimeAsync(5000); await rejected;
      expect(c.session.phase).toBe("result_pending"); expect(f.calls.some((call) => call.command === "start_analysis")).toBe(false);
      confirmed = true; acknowledged.resolve(originalReply); await acknowledged.promise;
      await c.session.retryResult(); expect(c.session.phase).toBe("ready");
      const original = f.calls.find((call) => call.command === "reserve_analysis")!;
      expect(f.calls.filter((call) => call.command === "reserve_analysis")).toHaveLength(1);
      expect(f.calls.filter((call) => call.command === "query_analysis_reservation").every((call) => call.args.requestJson === original.args.requestJson)).toBe(true);
      expect(f.calls.filter((call) => call.command === "start_analysis")).toHaveLength(1);
    } finally { c.session.dispose(); vi.useRealTimers(); }
  });
  it("bounds an unknown stop ACK without retiring or issuing another control packet", async () => {
    vi.useFakeTimers(); const f = transportFixture(), c = consumer(f), barrier = deferred<void>(), stopping = deferred<void>(); f.setStopBarrier(barrier.promise);
    const invoke = f.api.invoke;
    f.api.invoke = (command, args) => { if (command === "stop_analysis") stopping.resolve(); return invoke(command, args); };
    try {
      const result = c.session.stop(); const rejected = expect(result).rejects.toBeInstanceOf(RecoveryPendingError);
      await stopping.promise; await vi.advanceTimersByTimeAsync(5000); await rejected;
      expect(c.session.phase).toBe("unknown"); expect(f.calls.filter((call) => call.command === "stop_analysis")).toHaveLength(1);
      const retry = c.session.stop(true); await expect(retry).rejects.toBeInstanceOf(RecoveryPendingError);
      expect(f.calls.filter((call) => call.command === "stop_analysis")).toHaveLength(1);
      barrier.resolve(); await vi.advanceTimersByTimeAsync(0);
      await c.session.stop(true); await c.session.retryResult(); expect(c.session.phase).toBe("ready");
      expect(f.calls.filter((call) => call.command === "stop_analysis")).toHaveLength(1);
    } finally { barrier.resolve(); c.session.dispose(); vi.useRealTimers(); }
  });
  it.each(["delete", "clear"])("retires an exact fully projected external %s discard without reading or writing the purged body", async (operation) => {
    const f = transportFixture(); let firstQuery = true;
    f.setHook((command, request) => { if (command === "commit_analysis_projection" && request.throughSeq === "3") throw new Error("owned lost final ACK"); if (command === "query_analysis_projection" && firstQuery) { firstQuery = false; throw new Error("owned unavailable query"); } });
    const retired = vi.fn(async () => true), session = new SameSessionConsumer(f.captured, async () => f.api, { relevant: () => true, publish: () => true, retire: retired, changed: () => undefined });
    await expect(session.run()).rejects.toBeInstanceOf(RecoveryPendingError);
    const prior = f.current(); if (prior.state !== "coherent" || !prior.journal || !prior.head) throw new Error();
    const head = { ...prior.head, state: "tombstone" as const, revision: "4" }, storage = operation === "clear" ? { collection: { ...prior.storage.collection, epoch: "1" }, heads: [] } : { ...prior.storage, heads: [head] };
    const current: RecoveryCurrent = { ...prior, task: null, head: operation === "clear" ? null : head, storage, journal: { ...prior.journal, bodyState: "purged", resultState: "discarded", historyState: "discarded" } };
    const invoke = f.api.invoke; f.api.invoke = async (command, args) => { const reply = await invoke(command, args); return reply && typeof reply === "object" && "current" in reply ? { ...reply, current } : reply; };
    const before = f.calls.length; await session.retryResult(); expect(session.phase).toBe("ready"); expect(retired).toHaveBeenCalledExactlyOnceWith(current); expect(f.calls.slice(before).map((call) => call.command)).toEqual(["query_analysis_reservation"]);
  });
  it.each(["cleanup_unknown", "projection_pending", "body_available", "native_gate_unknown", "history_interrupted", "wrong_journal_generation", "unavailable_current"])("does not retire an external discard with %s", async (uncertainty) => {
    const f = transportFixture(); let firstQuery = true;
    f.setHook((command, request) => { if (command === "commit_analysis_projection" && request.throughSeq === "3") throw new Error("owned lost final ACK"); if (command === "query_analysis_projection" && firstQuery) { firstQuery = false; throw new Error("owned unavailable query"); } });
    const retired = vi.fn(async () => true);
    const ordinary = new SameSessionConsumer(f.captured, async () => f.api, { relevant: () => true, publish: () => true, retire: retired, changed: () => undefined });
    await expect(ordinary.run()).rejects.toBeInstanceOf(RecoveryPendingError);
    const prior = f.current(); if (prior.state !== "coherent" || !prior.journal || !prior.head) throw new Error();
    const tombstone = { ...prior.head, state: "tombstone" as const, revision: "4" };
    const current: RecoveryCurrent = uncertainty === "unavailable_current" ? { state: "unavailable", error: { code: "analysis_storage_unavailable", message: recoveryMessages.analysis_storage_unavailable }, runtime: prior.runtime } : { ...prior, task: null, head: tombstone, storage: { ...prior.storage, heads: [tombstone] }, journal: { ...prior.journal, binding: uncertainty === "wrong_journal_generation" ? { ...prior.journal.binding, generation: "2" } : prior.journal.binding, bodyState: uncertainty === "body_available" ? "available" : "purged", resultState: uncertainty === "projection_pending" ? "pending" : "discarded", historyState: uncertainty === "history_interrupted" ? "interrupted" : "discarded", cleanupState: uncertainty === "cleanup_unknown" ? "unknown" : "confirmed" }, runtime: uncertainty === "native_gate_unknown" ? { ...prior.runtime, journalGate: "unknown" } : prior.runtime };
    const invoke = f.api.invoke; f.api.invoke = async (command, args) => { const reply = await invoke(command, args); return reply && typeof reply === "object" && "current" in reply ? { ...reply, current } : reply; };
    await expect(ordinary.retryResult()).rejects.toThrow(); expect(retired).not.toHaveBeenCalled(); expect(ordinary.phase).toBe("result_pending"); ordinary.dispose();
  });
});
