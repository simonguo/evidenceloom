import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, transportFixture } from "../test-support/transport-fixture";
import { OutcomeRequest, RecoveryPendingError, waitForAcknowledgement } from "./transport";
import type { AdmissionReply, RecoveryApi } from "../types";

describe("immutable recovery outcome requests", () => {
  afterEach(() => vi.useRealTimers());
  it("queries the exact original admission after lost ACK rather than issuing another reserve", async () => {
    const f = transportFixture(), calls: { command: string; requestJson: string }[] = []; let lost = true;
    const api: RecoveryApi = { ...f.api, invoke: async (command, args) => { calls.push({ command, requestJson: args.requestJson }); const reply = await f.api.invoke(command, args); if (command === "reserve_analysis" && lost) { lost = false; throw new Error("owned lost ACK"); } return reply; } };
    const request = new OutcomeRequest(f.captured.packet, "analysis_admission", "reserve_analysis", "query_analysis_reservation", api); const reply = await request.execute();
    expect(reply.receipt).not.toBeNull(); expect(calls).toEqual([{ command: "reserve_analysis", requestJson: f.captured.packet.requestJson }, { command: "query_analysis_reservation", requestJson: f.captured.packet.requestJson }]);
  });
  it("preserves immutable known receipt when an older query returns null", async () => {
    const f = transportFixture(); let older = false;
    const api = { ...f.api, invoke: async (command: string, args: Parameters<RecoveryApi["invoke"]>[1]) => { const reply = await f.api.invoke(command, args) as AdmissionReply; return older && command === "query_analysis_reservation" ? { ...reply, receipt: null, matchedReservation: null } : reply; } };
    const request = new OutcomeRequest(f.captured.packet, "analysis_admission", "reserve_analysis", "query_analysis_reservation", api), committed = await request.execute(); older = true;
    expect((await request.query()).receipt).toEqual(committed.receipt); expect(request.outcome?.receipt).toEqual(committed.receipt);
  });
  it("rejects mismatched later receipt without erasing the already confirmed original result", async () => {
    const f = transportFixture(); let malformed = false;
    const api = { ...f.api, invoke: async (command: string, args: Parameters<RecoveryApi["invoke"]>[1]) => { const reply = await f.api.invoke(command, args) as AdmissionReply; return malformed && reply.receipt ? { ...reply, receipt: { ...reply.receipt, digest: "e".repeat(64) } } : reply; } };
    const request = new OutcomeRequest(f.captured.packet, "analysis_admission", "reserve_analysis", "query_analysis_reservation", api), committed = await request.execute(); malformed = true;
    await expect(request.query()).rejects.toBeInstanceOf(RecoveryPendingError); expect(request.outcome?.receipt).toEqual(committed.receipt);
  });
  it("bounds only the UI wait and reuses the same unresolved original request", async () => {
    vi.useFakeTimers(); const f = transportFixture(), pending = deferred<unknown>(), commands: string[] = [];
    const api = { ...f.api, invoke: async (command: string, args: Parameters<RecoveryApi["invoke"]>[1]) => { commands.push(command); if (command === "reserve_analysis") return pending.promise; const reply = await f.api.invoke(command, args) as AdmissionReply; return { ...reply, receipt: null, rejection: null, matchedReservation: null }; } };
    const request = new OutcomeRequest(f.captured.packet, "analysis_admission", "reserve_analysis", "query_analysis_reservation", api), result = request.execute(); await vi.advanceTimersByTimeAsync(5001);
    expect((await result).receipt).toBeNull(); await request.query(); expect(commands).toEqual(["reserve_analysis", "query_analysis_reservation", "query_analysis_reservation"]);
    pending.resolve(await f.api.invoke("reserve_analysis", { requestJson: f.captured.packet.requestJson })); await Promise.resolve(); await Promise.resolve();
    expect((await request.query()).receipt).not.toBeNull(); expect(commands.filter((name) => name === "reserve_analysis")).toHaveLength(1);
  });
  it("retains durable known rejection while distinguishing an unavailable direct transport", async () => {
    const f = transportFixture({ rejectedAdmission: true }); const request = new OutcomeRequest(f.captured.packet, "analysis_admission", "reserve_analysis", "query_analysis_reservation", f.api);
    expect((await request.execute()).rejection?.code).toBe("analysis_conflict"); expect(request.outcome?.rejection).toEqual((await request.query()).rejection);
    const pending = deferred<void>(), observed = waitForAcknowledgement(pending.promise, 1); await expect(observed).rejects.toBeInstanceOf(RecoveryPendingError); pending.resolve();
  });
});
