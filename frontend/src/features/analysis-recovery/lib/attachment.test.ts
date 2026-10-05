import { describe, expect, it, vi } from "vitest";
import { AttachedRunConsumer } from "./attachment";
import { readAttachmentReply, readAttachRequest, recoveryMessages } from "./protocol";
import { attachmentFixture } from "../test-support/attachment-fixture";
import { deferred } from "../test-support/transport-fixture";
import { RecoveryPendingError } from "./transport";

describe("same-runtime attachment with fictional transport", () => {
  it("uses acknowledged canonical prefix without reserve/start/accepted replay", async () => {
    const f = await attachmentFixture(), publish = vi.fn(() => true);
    const c = new AttachedRunConsumer(f.packet, async () => f.api, { relevant: () => true, publish, changed: () => undefined });
    await c.run(); expect(c.phase).toBe("ready"); expect(f.task().reportVersions).toHaveLength(1);
    expect(f.calls.some((call) => ["reserve_analysis", "start_analysis"].includes(call.command))).toBe(false);
    const projection = f.calls.filter((call) => call.command === "commit_analysis_projection").map((call) => JSON.parse(call.args.requestJson));
    expect(projection[0].expectedAppliedSeq).toBe("1"); expect(projection.every((p) => p.expectedAppliedSeq !== "0")).toBe(true);
  });
  it("initializes sticky critical truth from an already applied prefix and preserves earlier canonical history", async () => {
    const f = await attachmentFixture({ events: [{ type: "progress" }, { type: "completed", reportSections: { market_report: "later safe" } }] });
    f.rows[1] = { ...f.rows[1], kind: "publication_unavailable", payload: { sourceType: "progress", channels: [{ channel: "decision", reason: "unsafe_content" }], outcome: "analysis_failed", code: "analysis_publication_unavailable", safeAnalysis: { type: "progress" } } };
    f.canonical({ ...f.task(), status: "error", error: recoveryMessages.analysis_publication_unavailable }, "2");
    const c = new AttachedRunConsumer(f.packet, async () => f.api, { relevant: () => true, publish: () => true, changed: () => undefined });
    await c.run(); expect(f.task().status).toBe("error"); expect(f.task().reportVersions).toHaveLength(0);
    expect(f.calls.filter((call) => call.command === "read_analysis_journal").every((call) => JSON.parse(call.args.requestJson).afterSeq !== "0")).toBe(true);
  });
  it("queries the original immutable attachment packet after lost ACK", async () => {
    const f = await attachmentFixture(), invoke = f.api.invoke;
    f.api.invoke = async (command, args) => { const value = await invoke(command, args); if (command === "attach_analysis_recovery") throw new Error("Owned lost ACK"); return value; };
    const c = new AttachedRunConsumer(f.packet, async () => f.api, { relevant: () => true, publish: () => true, changed: () => undefined });
    await c.run(); expect(f.calls.filter((call) => call.command === "attach_analysis_recovery")).toHaveLength(1);
    expect(f.calls.filter((call) => call.command === "query_analysis_attachment").every((call) => call.args.requestJson === f.packet.requestJson)).toBe(true);
  });
  it("consumes only an already sealed finite result after an advisory listener refusal", async () => {
    const f = await attachmentFixture({ listenerFailure: true });
    const c = new AttachedRunConsumer(f.packet, async () => f.api, { relevant: () => true, publish: () => true, changed: () => undefined });
    await c.run(); expect(c.phase).toBe("ready"); expect(f.task().reportVersions).toHaveLength(1);
    expect(f.calls.some((call) => ["reserve_analysis", "start_analysis", "stop_analysis"].includes(call.command))).toBe(false);
  });
  it("cannot treat a listener refusal with an unsealed owner as cleanup or result completion", async () => {
    const f = await attachmentFixture({ listenerFailure: true }), invoke = f.api.invoke;
    f.api.invoke = async (command, args) => {
      const reply = await invoke(command, args);
      if (!command.includes("attachment") && command !== "attach_analysis_recovery") return reply;
      const value = reply as ReturnType<typeof f.reply>;
      if (value.current.state !== "coherent" || !value.current.journal) throw new Error("Owned cut missing");
      return { ...value, current: { ...value.current, journal: { ...value.current.journal, sealedThroughSeq: null, cleanupState: "pending", resultState: "unsealed", workerOutcome: null } } };
    };
    const c = new AttachedRunConsumer(f.packet, async () => f.api, { relevant: () => true, publish: () => true, changed: () => undefined });
    await expect(c.run()).rejects.toBeInstanceOf(RecoveryPendingError); expect(c.phase).not.toBe("ready");
    expect(f.calls.some((call) => call.command === "commit_analysis_projection")).toBe(false);
  });
  it("disposes a late listener ACK and cannot publish into a new frontend lifetime", async () => {
    const f = await attachmentFixture(), listening = deferred<void>(), ack = deferred<() => void>(), off = vi.fn(), publish = vi.fn(() => true);
    f.api.listen = () => { listening.resolve(); return ack.promise; };
    const c = new AttachedRunConsumer(f.packet, async () => f.api, { relevant: () => true, publish, changed: () => undefined });
    const run = c.run(); await listening.promise; c.dispose(); const count = publish.mock.calls.length; ack.resolve(off);
    await expect(run).rejects.toBeInstanceOf(RecoveryPendingError); expect(off).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledTimes(count);
    expect(f.calls.some((call) => call.command === "stop_analysis")).toBe(false);
  });
  it("keeps a volatile SQL-unavailable exact witness Stop-capable without project authority", async () => {
    const f = await attachmentFixture(), invoke = f.api.invoke;
    f.api.invoke = async (command, args) => {
      const value = await invoke(command, args);
      if (!command.includes("attachment") && command !== "attach_analysis_recovery") return value;
      const r = value as ReturnType<typeof f.reply>, owner = r.current.runtime.owner!;
      return { ...r, current: { state: "unavailable", error: { code: "analysis_storage_unavailable", message: recoveryMessages.analysis_storage_unavailable }, runtime: r.current.runtime }, attachment: { kind: "volatile", witness: { origin: owner.origin, journalId: owner.journalId, binding: owner.binding, admissionRequestId: owner.admissionRequestId, admissionDigest: owner.admissionDigest, headerDigest: null, owner, reason: "storage_unavailable" }, control: { state: "unavailable", controlRevision: owner.controlRevision, error: { code: "analysis_storage_unavailable", message: recoveryMessages.analysis_storage_unavailable } } } };
    };
    const c = new AttachedRunConsumer(f.packet, async () => f.api, { relevant: () => true, publish: () => true, changed: () => undefined });
    await expect(c.run()).rejects.toBeDefined(); await c.stop();
    expect(f.calls.filter((call) => call.command === "stop_analysis")).toHaveLength(1);
    expect(f.calls.some((call) => ["commit_analysis_projection", "reserve_analysis", "start_analysis"].includes(call.command))).toBe(false);
  });
  it("uses the latest accepted known failure revision instead of the cached original attachment cut for explicit retry", async () => {
    const f = await attachmentFixture({ cleanupFailure: true });
    const c = new AttachedRunConsumer(f.packet, async () => f.api, { relevant: () => true, publish: () => true, changed: () => undefined });
    await expect(c.stop()).rejects.toBeInstanceOf(RecoveryPendingError);
    expect(c.attachment?.control).toMatchObject({ state: "known", controlRevision: "1", receipt: { outcome: "cleanup_incomplete" } });
    await c.stop(true);
    const stops = f.calls.filter((call) => call.command === "stop_analysis").map((call) => JSON.parse(call.args.requestJson));
    expect(stops).toHaveLength(2); expect(stops[1]).toMatchObject({ mode: "retry_cleanup", expectedControlRevision: "1", origin: f.header.origin, journalId: f.header.journalId });
    expect(stops[1].requestId).not.toBe(stops[0].requestId);
    expect(f.calls.filter((call) => call.command === "attach_analysis_recovery")).toHaveLength(1);
  });
});

describe("strict parsed-object attachment boundary", () => {
  it("validates exact shared nullable fields and rejects unknown fields/future literals", async () => {
    const f = await attachmentFixture(), reply = f.reply(); expect(readAttachmentReply(reply, f.packet.request)).toEqual(reply);
    expect(() => readAttachRequest({ ...f.packet.request, sqlCommitted: true })).toThrow();
    expect(() => readAttachmentReply({ ...reply, receipt: { ...reply.receipt, mayStart: true } }, f.packet.request)).toThrow();
    expect(() => readAttachmentReply({ ...reply, attachment: { ...reply.attachment, prefix: { ...(reply.attachment?.kind === "durable" ? reply.attachment.prefix : {}), terminalObserved: false } } }, f.packet.request)).toThrow();
  });
  it("separates an empty safe terminal prefix from completion qualification and retained versions", async () => {
    const f = await attachmentFixture(), reply = f.reply(); if (reply.attachment?.kind !== "durable") throw new Error("Owned durable cut missing");
    const value = { ...reply, attachment: { ...reply.attachment, prefix: { ...reply.attachment.prefix, safeTerminalThroughApplied: true, projectionCompleted: false } } };
    expect(readAttachmentReply(value, f.packet.request).attachment).toEqual(value.attachment);
  });
  it("rejects a known old cleanup receipt presented as the latest coherent control cut", async () => {
    const f = await attachmentFixture();
    await f.api.invoke("stop_analysis", { requestJson: JSON.stringify({ recoveryProtocolVersion: 1, requestId: "owned-stop", origin: f.header.origin, journalId: f.header.journalId, mode: "stop", expectedControlRevision: null }) });
    const reply = f.reply(); if (reply.current.state !== "coherent" || !reply.current.journal) throw new Error("Owned cut missing");
    const current = reply.current;
    expect(readAttachmentReply(reply, f.packet.request)).toEqual(reply);
    expect(() => readAttachmentReply({ ...reply, current: { ...current, journal: { ...current.journal, controlRevision: "2", cleanupState: "failed" } } }, f.packet.request)).toThrow();
  });
  it("keeps known SQL cleanup failure retryable despite physically confirmed native cleanup", async () => {
    const f = await attachmentFixture();
    await f.api.invoke("stop_analysis", { requestJson: JSON.stringify({ recoveryProtocolVersion: 1, requestId: "owned-stop", origin: f.header.origin, journalId: f.header.journalId, mode: "stop", expectedControlRevision: null }) });
    const reply = f.reply(); if (reply.current.state !== "coherent" || !reply.current.journal || reply.attachment?.kind !== "durable" || reply.attachment.control.state !== "known") throw new Error("Owned cut missing");
    const control = { ...reply.attachment.control, receipt: { ...reply.attachment.control.receipt, outcome: "cleanup_incomplete" as const } };
    const current = { ...reply.current, journal: { ...reply.current.journal, cleanupState: "failed" as const } };
    expect(current.runtime.owner?.cleanupState).toBe("confirmed");
    const value = { ...reply, current, attachment: { ...reply.attachment, control } };
    expect(readAttachmentReply(value, f.packet.request)).toEqual(value);
  });
  it("binds a volatile known control to the available matching SQL revision without inventing SQL authority", async () => {
    const f = await attachmentFixture();
    await f.api.invoke("stop_analysis", { requestJson: JSON.stringify({ recoveryProtocolVersion: 1, requestId: "owned-stop", origin: f.header.origin, journalId: f.header.journalId, mode: "stop", expectedControlRevision: null }) });
    const reply = f.reply(); if (reply.current.state !== "coherent" || !reply.current.journal || reply.attachment?.kind !== "durable" || !reply.current.runtime.owner) throw new Error("Owned cut missing");
    const current = reply.current, owner = current.runtime.owner!;
    const value = { ...reply, attachment: { kind: "volatile", witness: { origin: owner.origin, journalId: owner.journalId, binding: owner.binding, admissionRequestId: owner.admissionRequestId, admissionDigest: owner.admissionDigest, headerDigest: null, owner, reason: "binding_mismatch" }, control: reply.attachment.control } };
    expect(readAttachmentReply(value, f.packet.request)).toEqual(value);
    expect(() => readAttachmentReply({ ...value, current: { ...current, journal: { ...current.journal, controlRevision: "2" } } }, f.packet.request)).toThrow();
    expect(readAttachmentReply({ ...value, current: { state: "unavailable", error: { code: "analysis_storage_unavailable", message: recoveryMessages.analysis_storage_unavailable }, runtime: current.runtime } }, f.packet.request).current.state).toBe("unavailable");
  });
});
