import type { AppliedPrefixAnchor, AttachReply, AttachRequest, ControlReconciliation } from "../attachment-types";
import type { ControlReceipt } from "../types";
import { journalProgress, reduceJournalPage } from "../lib/reducer";
import { captureAttachment } from "../lib/attachment";
import { recoveryMessages } from "../lib/protocol";
import { transportFixture } from "./transport-fixture";

/** Fictional ordering fixture only; it is not native digest, SQL or attachment proof. */
export async function attachmentFixture(options: Parameters<typeof transportFixture>[0] = {}) {
  const f = transportFixture(options), h = f.header;
  const reset = await reduceJournalPage(f.task(), h, [f.rows[0]]);
  f.canonical(reset.task, "1");
  await f.api.invoke("start_analysis", { requestJson: JSON.stringify({ recoveryProtocolVersion: 1, requestId: "owned-original-start", origin: h.origin, binding: h.binding, journalId: h.journalId, headerDigest: h.headerDigest }) });
  const original = f.api.invoke, outcomes = new Map<string, AttachReply>();
  let control: ControlReceipt | undefined;
  function reply(request: AttachRequest): AttachReply {
    const cut = f.current(); if (cut.state !== "coherent" || !cut.journal || !cut.head) throw new Error("Owned fixture lacks canonical cut");
    const current = { ...cut, head: cut.head, journal: { ...cut.journal, controlRevision: control?.controlRevision ?? cut.journal.controlRevision } };
    const prefixRows = f.rows.slice(0, Number(current.journal.appliedSeq)), progress = journalProgress(prefixRows);
    const prefix: AppliedPrefixAnchor = { recoveryProtocolVersion: 1, origin: h.origin, journalId: h.journalId, binding: h.binding, headerDigest: h.headerDigest,
      collection: h.binding.collection, head: current.head, appliedSeq: current.journal.appliedSeq, safeTerminalThroughApplied: progress.terminalObserved, criticalFailure: progress.criticalFailure,
      projectionFailureCode: null, projectionCompleted: current.task?.status === "completed" };
    const view: ControlReconciliation = control ? { state: "known", controlRevision: control.controlRevision, receipt: control }
      : current.journal.controlRevision === "0" ? { state: "none", controlRevision: "0" } : { state: "unavailable", controlRevision: current.journal.controlRevision, error: { code: "analysis_storage_unavailable", message: recoveryMessages.analysis_storage_unavailable } };
    return { recoveryProtocolVersion: 1, scope: "analysis_attachment", receipt: { recoveryProtocolVersion: 1, requestId: request.requestId, digest: "9".repeat(64), origin: h.origin, journalId: h.journalId, binding: h.binding,
      admissionRequestId: h.admissionRequestId, admissionDigest: h.admissionDigest, matchedObservationRevision: current.runtime.observationRevision, confirmation: "runtime", permission: "same_runtime_watch_project_stop", mayStart: false },
      rejection: null, current, attachment: { kind: "durable", authority: current.runtime.owner ? "live" : "retired", header: h, prefix, control: view } };
  }
  f.api.invoke = async (command, args) => {
    if (command === "attach_analysis_recovery" || command === "query_analysis_attachment") {
      f.calls.push({ command, args }); const request = JSON.parse(args.requestJson) as AttachRequest;
      if (command === "query_analysis_attachment" && !outcomes.has(request.requestId)) return { ...reply(request), receipt: null, attachment: null };
      const value = reply(request); outcomes.set(request.requestId, value); return value;
    }
    const value = await original(command, args);
    if (command === "stop_analysis") control = (value as { receipt: ControlReceipt }).receipt;
    return value;
  };
  const owner = f.current().runtime.owner!;
  const packet = captureAttachment({ runtimeEpoch: owner.origin.runtimeEpoch, expectedObservationRevision: "0", origin: owner.origin, journalId: owner.journalId, binding: owner.binding,
    admissionRequestId: owner.admissionRequestId, admissionDigest: owner.admissionDigest, expectedHeaderDigest: null });
  f.calls.length = 0;
  return { ...f, packet, reply: () => reply(packet.request) };
}
