import type { AppliedPrefixAnchor, AttachReply, AttachRequest, CurrentAttachment } from "../attachment-types";
import type { FrozenPacket, ProjectionRequest, ReadRequest, RecoveryApi, RecoveryPhase, StopRequest } from "../types";
import { detached, sameHead } from "@/features/desktop-task-store/lib/protocol";
import type { CanonicalParent, ConsumerBridge } from "./consumer";
import { exactRun, finished, freezePacket, gateReady, readAttachmentReply, readPage, readWake, requireWire, sameBinding, sameOrigin } from "./protocol";
import { reduceJournalPage, type RunReduction } from "./reducer";
import { OutcomeRequest, RecoveryPendingError, waitForAcknowledgement } from "./transport";

/** A new watch intent captures exact observed native identity before any await. */
export function captureAttachment(request: Omit<AttachRequest, "requestId" | "recoveryProtocolVersion">): FrozenPacket<AttachRequest> {
  return freezePacket({ ...detached(request), recoveryProtocolVersion: 1, requestId: crypto.randomUUID() });
}
class AttachmentRequest {
  private execution?: Promise<AttachReply>;
  private known?: AttachReply;
  constructor(readonly packet: FrozenPacket<AttachRequest>, private api: RecoveryApi, private relevant: () => boolean) {}
  private accept(value: unknown, query: boolean) {
    const reply = readAttachmentReply(value, this.packet.request, query);
    if (this.known?.receipt) { requireWire(reply.receipt === null || reply.receipt.digest === this.known.receipt.digest); requireWire(reply.rejection === null); }
    if (this.known?.rejection) requireWire(reply.receipt === null && (reply.rejection === null || reply.rejection.code === this.known.rejection.code));
    if (reply.receipt || reply.rejection) this.known = reply;
    return reply.receipt || reply.rejection || !this.known ? reply : { ...this.known, current: reply.current, attachment: reply.attachment };
  }
  async execute() {
    this.execution ??= Promise.resolve().then(async () => { requireWire(this.relevant()); return this.accept(await this.api.invoke("attach_analysis_recovery", { requestJson: this.packet.requestJson }), false); });
    void this.execution.catch(() => undefined);
    try { return await waitForAcknowledgement(this.execution); } catch { return this.query(); }
  }
  async query() { return this.accept(await waitForAcknowledgement(this.api.invoke("query_analysis_attachment", { requestJson: this.packet.requestJson })), true); }
}

/** Attached consumers never reserve/start or retain/reconstruct private execution input. */
export class AttachedRunConsumer {
  private request?: AttachmentRequest;
  private current?: AttachReply;
  private api?: RecoveryApi;
  private parent?: CanonicalParent;
  private prefix?: AppliedPrefixAnchor;
  private projection?: OutcomeRequest<ProjectionRequest>;
  private control?: OutcomeRequest<StopRequest>;
  private unlisten?: () => void;
  private registration?: Promise<void>;
  private disposed = false;
  private woke?: () => void;
  private attempt?: Promise<void>;
  private stopAttempt?: Promise<void>;
  phase: RecoveryPhase = "checking";
  constructor(readonly captured: FrozenPacket<AttachRequest>, private getApi: () => Promise<RecoveryApi>, private bridge: ConsumerBridge) {}
  private eligible = () => !this.disposed && this.bridge.relevant();
  private change(phase: RecoveryPhase) { this.phase = phase; if (this.eligible()) this.bridge.changed(phase, this.current?.current.runtime); }
  private async connect() { this.api ??= await waitForAcknowledgement(this.getApi()); this.request ??= new AttachmentRequest(this.captured, this.api, this.eligible); requireWire(this.eligible()); }
  private observe(reply: AttachReply) {
    if (!this.eligible()) throw new RecoveryPendingError();
    if (this.current && BigInt(reply.current.runtime.observationRevision) < BigInt(this.current.current.runtime.observationRevision)) return;
    if (reply.current.state === "coherent" && this.parent && reply.attachment?.kind === "durable" && (BigInt(reply.current.head!.revision) < BigInt(this.parent.head.revision) || BigInt(reply.attachment.prefix.appliedSeq) < BigInt(this.parent.appliedSeq))) return;
    this.current = reply; this.bridge.changed(this.phase, reply.current.runtime);
    const attachment = reply.attachment, current = reply.current;
    if (attachment?.kind === "durable" && current.state === "coherent" && current.task && current.head) {
      if (!this.bridge.publish(current)) throw new RecoveryPendingError();
      this.parent = { task: detached(current.task), head: detached(current.head), collection: detached(current.storage.collection), appliedSeq: attachment.prefix.appliedSeq };
      this.prefix = detached(attachment.prefix);
    }
  }
  private async refresh(query = true) {
    const reply = query ? await this.request!.query() : await this.request!.execute();
    this.observe(reply);
    // Reusing the original ACK must not replace a later accepted canonical/control cut.
    const accepted = this.current!;
    if (!accepted.receipt || accepted.rejection) throw new RecoveryPendingError("admission");
    return accepted;
  }
  private async register() {
    if (!this.registration) {
      const { origin, journalId } = this.captured.request;
      this.registration = this.api!.listen(`analysis-journal:${origin.runtimeEpoch}:${origin.runId}`, ({ payload }) => {
        if (!this.eligible()) return;
        try { const wake = readWake(typeof payload === "string" ? JSON.parse(payload) : payload); if (wake.journalId === journalId && sameOrigin(wake.origin, origin)) this.woke?.(); }
        catch { this.change("unknown"); this.woke?.(); }
      }).then((unlisten) => { if (!this.eligible() || this.phase === "ready") unlisten(); else this.unlisten = unlisten; });
      void this.registration.catch(() => undefined);
    }
    await waitForAcknowledgement(this.registration);
  }
  private done(reply: AttachReply) {
    return reply.attachment?.kind === "durable" && reply.attachment.authority === "retired" && reply.current.state === "coherent" && reply.current.journal !== null && finished(reply.current.journal) && gateReady(reply.current.runtime);
  }
  private async projectCut() {
    // An unknown page remains an exact original packet until native confirms its history.
    if (this.projection) {
      const reply = await this.projection.query();
      if (!reply.receipt && reply.rejection?.code !== "analysis_conflict") throw new RecoveryPendingError();
      this.projection = undefined; await this.refresh();
    }
    let cut: string | null = null;
    while (this.eligible()) {
      const attachment = this.current?.attachment;
      if (attachment?.kind !== "durable" || attachment.authority !== "live" || !this.parent || !this.prefix) throw new RecoveryPendingError();
      const parent = detached(this.parent), prefix = detached(this.prefix), header = detached(attachment.header);
      if (cut !== null && BigInt(parent.appliedSeq) >= BigInt(cut)) return;
      const read: ReadRequest = { recoveryProtocolVersion: 1, origin: header.origin, journalId: header.journalId, binding: header.binding, afterSeq: parent.appliedSeq, throughSeq: cut, limit: 64 };
      const page = readPage(await waitForAcknowledgement(this.api!.invoke("read_analysis_journal", { requestJson: freezePacket(read).requestJson })), read);
      requireWire(page.header.headerDigest === header.headerDigest); cut ??= page.throughSeq;
      if (!page.rows.length) return;
      const progress: RunReduction = { terminalObserved: prefix.safeTerminalThroughApplied, criticalFailure: prefix.criticalFailure };
      const reduced = await reduceJournalPage(parent.task, header, detached(page.rows), progress);
      requireWire(this.eligible() && page.rangeProof);
      const packet = freezePacket<ProjectionRequest>({ recoveryProtocolVersion: 1, requestId: crypto.randomUUID(), origin: header.origin, journalId: header.journalId, binding: header.binding, expectedHead: parent.head, expectedAppliedSeq: parent.appliedSeq, throughSeq: page.lastSeq, rangeDigest: page.rangeProof.digest, projection: { task: reduced.task } });
      this.projection = new OutcomeRequest(packet, "analysis_projection_sql", "commit_analysis_projection", "query_analysis_projection", this.api!, this.eligible);
      const reply = await this.projection.execute();
      if (!reply.receipt && reply.rejection?.code !== "analysis_conflict") throw new RecoveryPendingError();
      this.projection = undefined;
      await this.refresh(); // Read the actual winning canonical body + applied prefix, never replay acknowledged rows.
      if (reply.rejection && sameHead(this.parent!.head, parent.head)) throw new RecoveryPendingError();
      if (this.done(this.current!)) return;
      if (!page.hasMore && !reply.rejection) return;
    }
    throw new RecoveryPendingError();
  }
  private async drive(retry: boolean) {
    await this.connect(); let reply = await this.refresh(retry);
    if (this.done(reply)) { this.change("ready"); return; }
    // Listener errors leave exact Stop usable; no worker/start wait is invented.
    try { await this.register(); }
    catch (cause) {
      reply = await this.refresh();
      if (reply.attachment?.kind !== "durable" || reply.current.state !== "coherent" || reply.current.journal?.sealedThroughSeq === null || !reply.current.journal) throw new RecoveryPendingError("result", { cause });
      // The immutable sealed cut is finite; a failed advisory listener cannot hide it.
    }
    reply = await this.refresh();
    while (this.eligible()) {
      if (this.done(reply)) { this.unlisten?.(); this.unlisten = undefined; this.change("ready"); return; }
      if (reply.attachment?.kind !== "durable" || reply.attachment.authority !== "live") throw new RecoveryPendingError();
      this.change(reply.attachment.control.state === "pending" ? "stopping" : "running");
      await this.projectCut(); reply = await this.refresh();
      if (this.done(reply)) continue;
      if (reply.attachment?.control.state === "known" && reply.attachment.control.receipt.outcome === "cleanup_incomplete") { this.change("cleanup_failed"); throw new RecoveryPendingError("cleanup"); }
      await new Promise<void>((resolve) => { const timer = setTimeout(() => { this.woke = undefined; resolve(); }, 1000); this.woke = () => { clearTimeout(timer); this.woke = undefined; resolve(); }; });
      reply = await this.refresh();
    }
    throw new RecoveryPendingError();
  }
  run(retry = false): Promise<void> {
    this.attempt ??= this.drive(retry).catch((cause) => { if (this.phase !== "cleanup_failed" && this.phase !== "ready") this.change("result_pending"); throw cause; }).finally(() => { this.attempt = undefined; });
    return this.attempt;
  }
  retryResult() { return this.run(true); }
  stop(retry = false): Promise<void> {
    if (this.stopAttempt) return this.stopAttempt;
    this.stopAttempt = (async () => {
      await this.connect();
      let reply: AttachReply;
      try { reply = await this.refresh(false); }
      catch (cause) {
        // Runtime-only original witness can still Stop while the one attachment ACK is unknown.
        // This never grants projection or adopts another owner.
        if (!this.current) throw cause;
        reply = this.current;
      }
      const attachment = reply.attachment;
      if (this.done(reply)) { this.change("ready"); return; }
      const owner = reply.current.runtime.owner, original = this.captured.request;
      requireWire(!(attachment?.kind === "durable" && attachment.authority === "retired") && exactRun(owner, original.origin, original.journalId) && owner?.admissionRequestId === original.admissionRequestId && owner.admissionDigest === original.admissionDigest && sameBinding(owner.binding, original.binding));
      if (this.control && (!this.control.outcome || !this.control.outcome.receipt && !this.control.outcome.rejection)) {
        const control = await this.control.query(); if (!control.receipt || "outcome" in control.receipt && control.receipt.outcome !== "cleanup_confirmed") throw new RecoveryPendingError("cleanup"); return;
      }
      const view = attachment?.control;
      if (view?.state === "known" && view.receipt.outcome === "cleanup_confirmed") return;
      if (retry) requireWire(view?.state === "known" && view.receipt.outcome === "cleanup_incomplete");
      const packet = freezePacket<StopRequest>({ recoveryProtocolVersion: 1, requestId: crypto.randomUUID(), origin: original.origin, journalId: original.journalId, mode: retry ? "retry_cleanup" : "stop", expectedControlRevision: retry && view?.state === "known" ? view.controlRevision : null });
      this.control = new OutcomeRequest(packet, "analysis_control", "stop_analysis", "query_analysis_control", this.api!, this.eligible);
      this.change("stopping"); const control = await this.control.execute();
      try { await this.refresh(); } catch { /* Unknown attachment remains a result blocker after exact Stop. */ }
      this.woke?.();
      if (!control.receipt || "outcome" in control.receipt && control.receipt.outcome !== "cleanup_confirmed") { this.change("cleanup_failed"); throw new RecoveryPendingError("cleanup"); }
    })().catch((cause) => { if (this.phase !== "cleanup_failed") this.change("unknown"); throw cause; }).finally(() => { this.stopAttempt = undefined; });
    return this.stopAttempt;
  }
  dispose() { this.disposed = true; this.unlisten?.(); this.unlisten = undefined; this.woke?.(); }
  get knownRejected() { return !!this.current?.rejection && this.current.receipt === null; }
  get attachment(): CurrentAttachment | null { return this.current?.attachment ?? null; }
  get origin() { return this.captured.request.origin; }
}
