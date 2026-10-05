import type { AnalysisForm, AnalysisTask, RunContext } from "@/lib/types";
import { stripSecretFields } from "@/features/persistence/local-storage";
import { taskSnapshot } from "@/features/report-export/lib/versioning";
import { detached, sameCollection, sameHead } from "@/features/desktop-task-store/lib/protocol";
import type { TaskHead, CollectionToken } from "@/features/desktop-task-store/types";
import { requestedSettingKeys } from "../types";
import type { AdmissionReply, AdmissionRequest, FrozenPacket, JournalHeader, MatchedReservation, OutcomeReply, ProjectionRequest, ReadRequest, RecoveryApi, RecoveryCurrent, RecoveryPhase, RecoverySnapshot, RunBinding, RunIdentity, RuntimeObservation, StartRequest, StopRequest } from "../types";
import { exactRun, finished, freezePacket, gateReady, readCurrent, readPage, readRuntime, readSnapshot, readWake, requireWire, sameBinding, sameOrigin } from "./protocol";
import { initialReduction, journalProgress, reduceJournalPage, type RunReduction } from "./reducer";
import { OutcomeRequest, RecoveryAdmissionRejectedError, RecoveryPendingError, waitForAcknowledgement } from "./transport";

export type CapturedAdmission = Readonly<{ packet: FrozenPacket<AdmissionRequest>; executionInputJson: string; task: AnalysisTask }>;
export type CanonicalParent = Readonly<{ task: AnalysisTask; head: TaskHead; collection: CollectionToken; appliedSeq: string }>;
export type ConsumerBridge = { relevant: () => boolean; publish: (current: RecoveryCurrent) => boolean; retire?: (current: RecoveryCurrent) => Promise<boolean>; changed: (phase: RecoveryPhase, runtime?: RuntimeObservation) => void };
export function captureAdmission(task: AnalysisTask, form: AnalysisForm, runContext: RunContext, collection: CollectionToken, head: TaskHead, runtimeEpoch: string): CapturedAdmission {
  // Everything including transient execution input is detached before any import/IPC await.
  const capturedTask = detached(task), capturedForm = detached(form), context = detached(runContext);
  const input = { ticker: capturedForm.ticker, analysisDate: capturedForm.analysisDate, assetType: capturedForm.assetType, researchDepth: capturedForm.researchDepth, analysts: capturedForm.analysts, outputLanguage: capturedForm.outputLanguage };
  const requestedSettings = Object.fromEntries(requestedSettingKeys.map((key) => [key, capturedForm[key]])) as AdmissionRequest["context"]["requestedSettings"];
  const packet = freezePacket<AdmissionRequest>({ recoveryProtocolVersion: 1, requestId: crypto.randomUUID(), runtimeEpoch, collection: detached(collection), expectedHead: detached(head), context: { originalTaskSnapshot: taskSnapshot(capturedTask), input, requestedSettings, originalRunContext: context } });
  const executionInputJson = JSON.stringify(stripSecretFields(capturedForm));
  requireWire(new TextEncoder().encode(executionInputJson).length <= 524288);
  return Object.freeze({ packet, executionInputJson, task: capturedTask });
}
export async function loadRecovery(api: RecoveryApi): Promise<RecoverySnapshot> { const packet = freezePacket({ recoveryProtocolVersion: 1 as const }); return readSnapshot(await waitForAcknowledgement(api.invoke("load_analysis_recovery", { requestJson: packet.requestJson }))); }

/** One live frontend execution. It does not reconstruct a run on reload. */
export class SameSessionConsumer {
  private admission?: OutcomeRequest<AdmissionRequest>;
  private start?: OutcomeRequest<StartRequest>;
  private control?: OutcomeRequest<StopRequest>;
  private projection?: OutcomeRequest<ProjectionRequest>;
  private header?: JournalHeader;
  private witness?: MatchedReservation;
  private current?: RecoveryCurrent;
  private parent: CanonicalParent;
  private progress: RunReduction = initialReduction;
  private progressSeq = "0";
  private pendingProgress?: RunReduction;
  private unlisten?: () => void;
  private registration?: Promise<() => void>;
  private cancelled = false;
  private disposed = false;
  private blocked = false;
  private woke?: () => void;
  private activeAttempt?: Promise<void>;
  private stopping?: Promise<void>;
  private api?: RecoveryApi;
  private connecting?: Promise<RecoveryApi>;
  phase: RecoveryPhase = "reserving";
  constructor(readonly captured: CapturedAdmission, private getApi: () => Promise<RecoveryApi>, private bridge: ConsumerBridge) {
    this.parent = { task: captured.task, collection: captured.packet.request.collection, head: captured.packet.request.expectedHead, appliedSeq: "0" };
  }
  private change(phase: RecoveryPhase, runtime?: RuntimeObservation) { this.phase = phase; this.bridge.changed(phase, runtime); }
  private eligible() { return !this.disposed && this.bridge.relevant(); }
  private async connect() {
    if (this.api) return this.api;
    this.connecting ??= this.getApi();
    try { this.api = await this.connecting; return this.api; }
    finally { this.connecting = undefined; }
  }
  private observe(current: RecoveryCurrent) {
    current = readCurrent(current);
    const prior = this.current;
    if (prior && prior.runtime.runtimeEpoch === current.runtime.runtimeEpoch && BigInt(prior.runtime.observationRevision) > BigInt(current.runtime.observationRevision)) return;
    this.current = current;
    if (current.state === "coherent" && this.header && current.journal && sameOrigin(current.journal.origin, this.header.origin) && current.journal.journalId === this.header.journalId && sameBinding(current.journal.binding, this.header.binding)) {
      if (current.task && current.head && current.head.state === "live" && current.head.generation === this.header.binding.generation && sameCollection(current.storage.collection, this.header.binding.collection)) {
        if (BigInt(current.journal.appliedSeq) >= BigInt(this.parent.appliedSeq) && BigInt(current.head.revision) >= BigInt(this.parent.head.revision) && this.eligible() && this.bridge.publish(current)) this.parent = { task: detached(current.task), head: detached(current.head), collection: detached(current.storage.collection), appliedSeq: current.journal.appliedSeq };
      }
    }
    this.bridge.changed(this.phase, current.runtime);
  }
  private known(reply: OutcomeReply) { this.observe(reply.current); if (reply.rejection) throw new RecoveryPendingError(); if (!reply.receipt) throw new RecoveryPendingError(); }
  private async retireDiscarded() {
    const current = this.current, witness = this.witness;
    if (!witness || current?.state !== "coherent" || !current.journal || !this.bridge.retire || !this.eligible()) return false;
    const journal = current.journal;
    if (journal.journalId !== witness.journalId || !sameOrigin(journal.origin, witness.origin) || !sameBinding(journal.binding, witness.binding) || journal.bodyState !== "purged" || journal.resultState !== "discarded" || journal.historyState !== "discarded" || journal.cleanupState !== "confirmed" || !gateReady(current.runtime)) return false;
    if (!await this.bridge.retire(current)) throw new RecoveryPendingError();
    this.unlisten?.(); this.unlisten = undefined; this.change("ready", current.runtime); return true;
  }
  private async confirmStart(reply: OutcomeReply) {
    this.observe(reply.current);
    if (reply.rejection) { await this.stop(); return; }
    this.known(reply);
  }
  private async queryCurrent() {
    const api = this.api!;
    const runtime = readRuntime(await waitForAcknowledgement(api.invoke("query_analysis_runtime", { requestJson: freezePacket({ recoveryProtocolVersion: 1 as const }).requestJson })));
    this.bridge.changed(this.phase, runtime);
    if (this.current) this.current = { ...this.current, runtime };
    return runtime;
  }
  private async register() {
    const api = this.api!, header = this.header!;
    if (!this.registration) {
      this.registration = api.listen(`analysis-journal:${header.origin.runtimeEpoch}:${header.origin.runId}`, ({ payload }) => {
        if (!this.eligible() || this.phase === "ready") return;
        try { const wake = readWake(typeof payload === "string" ? JSON.parse(payload) : payload); if (wake.journalId === header.journalId && sameOrigin(wake.origin, header.origin)) this.woke?.(); }
        catch { this.blocked = true; this.woke?.(); }
      }).then((unlisten) => { this.unlisten = unlisten; if (this.disposed || this.cancelled || this.phase === "ready") { unlisten(); this.unlisten = undefined; } return unlisten; });
      void this.registration.catch(() => undefined);
    }
    await waitForAcknowledgement(this.registration);
  }
  private async resolveAdmission(query = false) {
    const api = this.api!;
    this.admission ??= new OutcomeRequest(this.captured.packet, "analysis_admission", "reserve_analysis", "query_analysis_reservation", api, () => this.eligible());
    const reply = (query ? await this.admission.query() : await this.admission.execute()) as AdmissionReply;
    this.observe(reply.current); if (reply.matchedReservation) { requireWire(!this.witness || this.witness.digest === reply.matchedReservation.digest && this.witness.journalId === reply.matchedReservation.journalId && sameOrigin(this.witness.origin, reply.matchedReservation.origin)); this.witness = reply.matchedReservation; }
    if (reply.receipt) {
      const receipt = reply.receipt;
      this.witness = { requestId: receipt.requestId, digest: receipt.digest, origin: receipt.origin, journalId: receipt.journalId, binding: receipt.binding, headerDigest: receipt.headerDigest };
    }
    if (!reply.receipt) {
      if (reply.rejection && !reply.matchedReservation && !this.witness && gateReady(reply.current.runtime)) {
        this.change("ready", reply.current.runtime);
        throw new RecoveryAdmissionRejectedError(reply.rejection.code);
      }
      throw new RecoveryPendingError("admission");
    }
  }
  private async read(afterSeq: string, throughSeq: string | null) {
    const witness = this.witness!;
    const request: ReadRequest = { recoveryProtocolVersion: 1, journalId: witness.journalId, origin: witness.origin, binding: witness.binding, afterSeq, throughSeq, limit: 64 };
    const packet = freezePacket(request);
    const page = readPage(await waitForAcknowledgement(this.api!.invoke("read_analysis_journal", { requestJson: packet.requestJson })), request);
    requireWire(page.header.admissionRequestId === this.captured.packet.request.requestId && page.header.admissionDigest === witness.digest && (witness.headerDigest === null || page.header.headerDigest === witness.headerDigest));
    this.header = page.header;
    return page;
  }
  private async projectCut(through: string | null = null) {
    if (this.projection) {
      const reply = await this.projection.query();
      this.observe(reply.current); if (await this.retireDiscarded()) return this.current?.state === "coherent" ? this.current.journal : undefined;
      if (reply.rejection?.code === "analysis_conflict" && reply.current.state === "coherent") {
        const originalHead = this.projection.packet.request.expectedHead;
        this.observe(reply.current); this.projection = undefined; this.pendingProgress = undefined;
        if (sameHead(this.parent.head, originalHead)) throw new RecoveryPendingError();
      } else {
        this.known(reply);
        requireWire(BigInt(this.parent.appliedSeq) >= BigInt(this.projection.packet.request.throughSeq));
        if (this.pendingProgress) { this.progress = this.pendingProgress; this.progressSeq = this.projection.packet.request.throughSeq; }
        this.projection = undefined; this.pendingProgress = undefined;
      }
    }
    let cut = through;
    while (this.eligible()) {
      if (await this.retireDiscarded()) return this.current?.state === "coherent" ? this.current.journal : undefined;
      // A competing winning projection may advance farther than our acknowledged page.
      // Read those exact original rows for sticky/terminal facts, without reapplying task data.
      const confirmedPrefix = this.parent.appliedSeq;
      while (BigInt(this.progressSeq) < BigInt(confirmedPrefix)) {
        const prefix = await this.read(this.progressSeq, confirmedPrefix);
        requireWire(prefix.rows.length > 0);
        this.progress = journalProgress(prefix.rows, this.progress); this.progressSeq = prefix.lastSeq;
      }
      const page = await this.read(this.parent.appliedSeq, cut); cut ??= page.throughSeq;
      if (!page.rows.length) return page.summary;
      // Freeze the declared canonical parent and page before any verifier await.
      const parent = detached(this.parent), rows = detached(page.rows), header = detached(page.header), progress = detached(this.progress);
      requireWire(page.rangeProof && page.rangeProof.fromSeq === parent.appliedSeq);
      const reduced = await reduceJournalPage(parent.task, header, rows, progress);
      if (!this.eligible()) throw new RecoveryPendingError();
      const request: ProjectionRequest = { recoveryProtocolVersion: 1, requestId: crypto.randomUUID(), journalId: header.journalId, origin: header.origin, binding: header.binding, expectedHead: parent.head, expectedAppliedSeq: parent.appliedSeq, throughSeq: page.lastSeq, rangeDigest: page.rangeProof.digest, projection: { task: reduced.task } };
      this.projection = new OutcomeRequest(freezePacket(request), "analysis_projection_sql", "commit_analysis_projection", "query_analysis_projection", this.api!, () => this.eligible());
      this.pendingProgress = reduced.progress;
      const reply = await this.projection.execute();
      this.observe(reply.current); if (await this.retireDiscarded()) return this.current?.state === "coherent" ? this.current.journal : undefined;
      if (reply.rejection?.code === "analysis_conflict" && reply.current.state === "coherent") {
        this.observe(reply.current);
        this.projection = undefined; this.pendingProgress = undefined;
        // A NEW canonical parent/range is captured on the next iteration, not an old body restamp.
        if (sameHead(this.parent.head, parent.head)) throw new RecoveryPendingError();
        continue;
      }
      this.known(reply); requireWire(BigInt(this.parent.appliedSeq) >= BigInt(page.lastSeq));
      this.progress = reduced.progress; this.progressSeq = page.lastSeq; this.projection = undefined; this.pendingProgress = undefined;
      if (!page.hasMore) return this.current?.state === "coherent" ? this.current.journal ?? page.summary : page.summary;
    }
    throw new RecoveryPendingError();
  }
  private async controlOwner(retry: boolean) {
    if (!this.witness) { try { await this.resolveAdmission(true); } catch (cause) { if (!this.witness) throw cause; } }
    const witness = this.witness!;
    const priorReceipt = this.control?.outcome?.receipt;
    if (this.control && (!retry || !priorReceipt && !this.control.outcome?.rejection || priorReceipt && "outcome" in priorReceipt && priorReceipt.outcome === "cleanup_confirmed")) {
      const reply = await this.control.query(); this.observe(reply.current);
      if (!reply.receipt || "outcome" in reply.receipt && reply.receipt.outcome === "cleanup_incomplete") throw new RecoveryPendingError("cleanup"); return;
    }
    const owner = this.current?.runtime.owner;
    const journal = this.current?.state === "coherent" ? this.current.journal : undefined;
    const matchingOwner = exactRun(owner ?? null, witness.origin, witness.journalId) ? owner : undefined;
    const matchingJournal = journal && journal.journalId === witness.journalId && sameOrigin(journal.origin, witness.origin) ? journal : undefined;
    if (retry && this.control?.outcome?.rejection && (matchingOwner?.cleanupState === "confirmed" || matchingJournal?.cleanupState === "confirmed")) return;
    const revision = matchingOwner?.controlRevision ?? matchingJournal?.controlRevision;
    if (retry) requireWire(revision !== undefined);
    const request: StopRequest = { recoveryProtocolVersion: 1, requestId: crypto.randomUUID(), origin: witness.origin, journalId: witness.journalId, mode: retry ? "retry_cleanup" : "stop", expectedControlRevision: retry ? revision! : null };
    this.control = new OutcomeRequest(freezePacket(request), "analysis_control", "stop_analysis", "query_analysis_control", this.api!, () => !this.disposed);
    const reply = await this.control.execute(); this.observe(reply.current);
    if (!reply.receipt || "outcome" in reply.receipt && reply.receipt.outcome === "cleanup_incomplete") { this.change("cleanup_failed", reply.current.runtime); throw new RecoveryPendingError("cleanup"); }
  }
  stop(retry = false): Promise<void> {
    this.cancelled = true; this.woke?.();
    if (this.stopping) return this.stopping;
    this.change("stopping");
    this.stopping = (async () => {
      await this.connect();
      try { await this.controlOwner(retry); }
      catch (cause) {
        const receipt = this.control?.outcome?.receipt;
        if (this.phase !== "ready") this.change(receipt && "outcome" in receipt && receipt.outcome === "cleanup_incomplete" ? "cleanup_failed" : "unknown"); throw cause;
      }
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async drive(retry: boolean) {
    await this.connect(); requireWire(this.eligible());
    await this.resolveAdmission(retry);
    if (await this.retireDiscarded()) return;
    if (!this.header) { const page = await this.read("0", "1"); this.header = page.header; }
    if (this.cancelled) await this.stop();
    else {
      try { await this.register(); } catch (cause) { await this.stop(); this.change("result_pending"); throw new RecoveryPendingError("result", { cause }); }
      if (!this.cancelled) {
        if (BigInt(this.parent.appliedSeq) < BigInt(1) || this.projection?.packet.request.throughSeq === "1") await this.projectCut("1");
        requireWire(BigInt(this.parent.appliedSeq) >= BigInt(1));
        if (!this.start) {
          const header = this.header!, request: StartRequest = { recoveryProtocolVersion: 1, requestId: crypto.randomUUID(), origin: header.origin, journalId: header.journalId, binding: header.binding, headerDigest: header.headerDigest };
          this.start = new OutcomeRequest(freezePacket(request), "analysis_start", "start_analysis", "query_analysis_start", this.api!, () => this.eligible() && !this.cancelled);
          await this.confirmStart(await this.start.execute(this.captured.executionInputJson));
        } else await this.confirmStart(await this.start.query());
      }
    }
    while (this.eligible()) {
      this.change(this.cancelled ? "stopping" : "running");
      const summary = await this.projectCut();
      if (this.phase === "ready") return;
      if (this.blocked) throw new RecoveryPendingError();
      const runtime = await this.queryCurrent();
      if (summary && finished(summary) && gateReady(runtime)) { this.unlisten?.(); this.unlisten = undefined; this.change("ready", runtime); return; }
      if (runtime.owner && this.witness && !exactRun(runtime.owner, this.witness.origin, this.witness.journalId)) throw new RecoveryPendingError();
      if (summary?.cleanupState === "failed") { this.change("cleanup_failed", runtime); throw new RecoveryPendingError("cleanup"); }
      if (summary?.sealedThroughSeq !== null && summary?.appliedSeq !== summary?.sealedThroughSeq) this.change("result_pending", runtime);
      await new Promise<void>((resolve) => { const timer = setTimeout(() => { this.woke = undefined; resolve(); }, 1000); this.woke = () => { clearTimeout(timer); this.woke = undefined; resolve(); }; });
    }
    throw new RecoveryPendingError();
  }
  run(retry = false): Promise<void> {
    if (this.activeAttempt) return this.activeAttempt;
    this.activeAttempt = this.drive(retry).catch((cause) => { if (this.phase !== "cleanup_failed" && this.phase !== "ready") this.change("result_pending"); throw cause; }).finally(() => { this.activeAttempt = undefined; }); return this.activeAttempt;
  }
  retryResult() { return this.run(true); }
  dispose() { this.disposed = true; this.woke?.(); this.unlisten?.(); this.unlisten = undefined; }
  get runtime() { return this.current?.runtime; }
  get binding(): RunBinding | undefined { return this.witness?.binding; }
  get origin(): RunIdentity | undefined { return this.witness?.origin; }
}
