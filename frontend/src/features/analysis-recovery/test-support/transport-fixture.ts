import type { AnalysisEvent, AnalysisTask } from "@/lib/types";
import type { AdmissionReceipt, AdmissionReply, JournalHeader, OutcomeReply, ProjectionRequest, ReadRequest, RecoveryApi, RecoveryCurrent, StartRequest, StopRequest } from "../types";
import type { CapturedAdmission } from "../lib/consumer";
import { recoveryMessages } from "../lib/protocol";
import { captured, envelope, header, runtime, summary } from "./fixtures";

export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** A narrow fictional transport for frontend ordering tests, not native CAS/digest proof. */
let fixtureNumber = 0;
export function transportFixture(options: { captured?: CapturedAdmission; taskId?: string; events?: AnalysisEvent[]; pageSize?: number; listenerFailure?: boolean; cleanupFailure?: boolean; rejectedAdmission?: boolean; workerPending?: boolean } = {}) {
  const admission = options.captured ?? captured(options.taskId ?? `owned-run-${++fixtureNumber}`), base = header();
  const h: JournalHeader = { ...base, origin: { ...base.origin, runtimeEpoch: admission.packet.request.runtimeEpoch, taskId: admission.task.id }, binding: { collection: admission.packet.request.collection, generation: admission.packet.request.expectedHead.generation, taskId: admission.task.id }, reservedHead: admission.packet.request.expectedHead, admissionRequestId: admission.packet.request.requestId, context: admission.packet.request.context };
  let task = admission.task, head = { ...h.reservedHead }, applied = "0", started = false, cleaned = false, sealed: string | null = null, revision = 0;
  let workerOutcome: "succeeded" | "cancelled" | "not_started" | null = null;
  const rows = [envelope(h, 1, "accepted", { resetVersion: 1 })];
  const outcomes = new Map<string, OutcomeReply | AdmissionReply>();
  const calls: { command: string; args: { requestJson: string; executionInputJson?: string } }[] = [];
  let stopBarrier: Promise<void> | undefined;
  let hook: ((command: string, request: Record<string, unknown>) => void | Promise<void>) | undefined;
  const observe = () => {
    const ready = options.rejectedAdmission || cleaned && sealed === applied;
    const r = { ...runtime(!!ready), runtimeEpoch: h.origin.runtimeEpoch, observationRevision: String(++revision) };
    if (!ready) { r.runtimeGate = "occupied"; r.journalGate = "blocked"; r.owner = { origin: h.origin, binding: h.binding, journalId: h.journalId, admissionRequestId: h.admissionRequestId, admissionDigest: h.admissionDigest, phase: cleaned ? "result_pending" : started && options.cleanupFailure ? "cleanup_failed" : started ? "running" : "reserved", controlRevision: cleaned || started && options.cleanupFailure ? "1" : "0", cleanupState: cleaned ? "confirmed" : started && options.cleanupFailure ? "failed" : "pending" }; }
    return r;
  };
  const journal = () => ({ ...summary(h, String(rows.length), applied), sealedThroughSeq: sealed, cleanupState: cleaned ? "confirmed" as const : started && options.cleanupFailure ? "failed" as const : "pending" as const, workerOutcome, resultState: sealed ? applied === sealed ? "projected" as const : "pending" as const : "unsealed" as const });
  const current = (): RecoveryCurrent => ({ state: "coherent", storage: { collection: h.binding.collection, heads: [head] }, task, head, journal: options.rejectedAdmission ? null : journal(), runtime: observe() });
  const receipt = (): AdmissionReceipt => ({ recoveryProtocolVersion: 1, requestId: h.admissionRequestId, digest: h.admissionDigest, origin: h.origin, journalId: h.journalId, binding: h.binding, headerDigest: h.headerDigest, acceptedSeq: "1", sqlCommitted: true });
  function outcome(scope: OutcomeReply["scope"], request: { requestId: string }, fields: Record<string, unknown>): OutcomeReply {
    return { recoveryProtocolVersion: 1, scope, receipt: { recoveryProtocolVersion: 1, requestId: request.requestId, digest: "d".repeat(64), origin: h.origin, journalId: h.journalId, sqlCommitted: true, ...fields } as OutcomeReply["receipt"], rejection: null, current: current() };
  }
  const api: RecoveryApi = {
    async listen() { if (options.listenerFailure) throw new Error("owned listener refusal"); return () => undefined; },
    async invoke(command, args) {
      calls.push({ command, args }); const request = JSON.parse(args.requestJson) as Record<string, unknown>;
      if (command === "query_analysis_runtime") return observe();
      if (command === "reserve_analysis" || command === "query_analysis_reservation") {
        const reply: AdmissionReply = { recoveryProtocolVersion: 1, scope: "analysis_admission", receipt: options.rejectedAdmission ? null : receipt(), rejection: options.rejectedAdmission ? { code: "analysis_conflict", message: recoveryMessages.analysis_conflict } : null, current: current(), matchedReservation: options.rejectedAdmission ? null : { requestId: h.admissionRequestId, digest: h.admissionDigest, origin: h.origin, journalId: h.journalId, binding: h.binding, headerDigest: h.headerDigest } };
        if (command === "reserve_analysis" && options.rejectedAdmission) throw reply.rejection;
        await hook?.(command, request); return reply;
      }
      if (command === "read_analysis_journal") {
        await hook?.(command, request);
        const read = request as unknown as ReadRequest, through = read.throughSeq ?? String(rows.length), from = Number(read.afterSeq), last = Math.min(Number(through), from + Math.min(read.limit, options.pageSize ?? 2));
        return { recoveryProtocolVersion: 1, header: h, summary: journal(), afterSeq: read.afterSeq, throughSeq: through, lastSeq: String(last), hasMore: last < Number(through), rows: rows.slice(from, last), rangeProof: last === from ? null : { fromSeq: read.afterSeq, throughSeq: String(last), digest: "f".repeat(64) } };
      }
      if (command.startsWith("query_analysis_")) {
        const prior = outcomes.get(String(request.requestId));
        await hook?.(command, request);
        return prior ? { ...prior, current: current() } : { recoveryProtocolVersion: 1, scope: command === "query_analysis_projection" ? "analysis_projection_sql" : command === "query_analysis_control" ? "analysis_control" : "analysis_start", receipt: null, rejection: null, current: current() };
      }
      let reply: OutcomeReply;
      if (command === "commit_analysis_projection") {
        const p = request as unknown as ProjectionRequest;
        if (p.expectedHead.revision !== head.revision || p.expectedAppliedSeq !== applied) {
          reply = { recoveryProtocolVersion: 1, scope: "analysis_projection_sql", receipt: null, rejection: { code: "analysis_conflict", message: recoveryMessages.analysis_conflict }, current: current() }; outcomes.set(p.requestId, reply); throw reply.rejection;
        }
        task = { ...p.projection.task };
        applied = p.throughSeq; head = { ...head, revision: String(BigInt(head.revision) + BigInt(1)) };
        reply = outcome("analysis_projection_sql", p, { binding: h.binding, fromSeq: p.expectedAppliedSeq, throughSeq: p.throughSeq, rangeDigest: p.rangeDigest, head });
      } else if (command === "start_analysis") {
        const s = request as unknown as StartRequest;
        started = true;
        for (const event of options.events ?? [{ type: "completed", reportSections: { market_report: "Fictional report" } }]) rows.push(envelope(h, rows.length + 1, "analysis", { event }));
        if (!options.workerPending) {
          workerOutcome = "succeeded"; rows.push(envelope(h, rows.length + 1, "worker_outcome", { outcome: workerOutcome, code: null })); sealed = String(rows.length); cleaned = !options.cleanupFailure;
        }
        reply = outcome("analysis_start", s, { binding: h.binding, accepted: true });
      } else if (command === "stop_analysis") {
        const s = request as unknown as StopRequest; await stopBarrier;
        if (!sealed) { workerOutcome = started ? "cancelled" : "not_started"; rows.push(envelope(h, rows.length + 1, "worker_outcome", { outcome: workerOutcome, code: null })); sealed = String(rows.length); }
        cleaned = !options.cleanupFailure || s.mode === "retry_cleanup";
        reply = outcome("analysis_control", s, { controlRevision: s.mode === "retry_cleanup" ? "2" : "1", outcome: cleaned ? "cleanup_confirmed" : "cleanup_incomplete" });
      } else throw new Error(`Unsupported owned fixture command: ${command}`);
      outcomes.set(String(request.requestId), reply); await hook?.(command, request); return reply;
    },
  };
  return { api, captured: admission as CapturedAdmission, header: h, rows, calls, current, task: () => task, setStopBarrier: (barrier: Promise<void>) => { stopBarrier = barrier; }, setHook: (value: typeof hook) => { hook = value; }, canonical: (value: AnalysisTask, cursor = applied) => { task = value; applied = cursor; head = { ...head, revision: String(BigInt(head.revision) + BigInt(1)) }; } };
}
