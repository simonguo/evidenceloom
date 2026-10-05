import { readOutcome, requireWire } from "./protocol";
import type { AdmissionRequest, FrozenPacket, OutcomeReply, ProjectionRequest, RecoveryApi, Scope, StartRequest, StopRequest } from "../types";

export class RecoveryPendingError extends Error {
  constructor(readonly kind: "result" | "cleanup" | "admission" = "result", options?: ErrorOptions) { super("Analysis confirmation is still pending.", options); this.name = "RecoveryPendingError"; }
}
/** The original admission is durably rejected and native preparation is retired. */
export class RecoveryAdmissionRejectedError extends Error {
  constructor(readonly code: string) { super("Analysis could not be admitted. Retry starting it explicitly."); this.name = "RecoveryAdmissionRejectedError"; }
}

/** This bounds a UI wait, not native IPC execution or owned process cleanup. */
export async function waitForAcknowledgement<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RecoveryPendingError()), milliseconds); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

type Request = AdmissionRequest | StartRequest | StopRequest | ProjectionRequest;
/** Single immutable original packet. Queries never resend private input or restamp a head. */
export class OutcomeRequest<T extends Request> {
  private execution?: Promise<OutcomeReply>;
  private known?: OutcomeReply;
  constructor(readonly packet: FrozenPacket<T>, readonly scope: Scope, private command: string, private queryCommand: string, private api: RecoveryApi, private eligible: () => boolean = () => true) {}
  private accept(value: unknown, query: boolean): OutcomeReply {
    const reply = readOutcome(value, this.scope, this.packet.request, query);
    if (this.known?.receipt) {
      requireWire(reply.receipt === null || reply.receipt.digest === this.known.receipt.digest);
      requireWire(reply.rejection === null);
      // A query cut predating commit cannot erase an immutable known result.
      if (!reply.receipt) return { ...this.known, current: reply.current };
    }
    if (this.known?.rejection) { requireWire(reply.receipt === null && (reply.rejection === null || reply.rejection.code === this.known.rejection.code)); if (!reply.rejection) return { ...this.known, current: reply.current }; }
    if (reply.receipt || reply.rejection) this.known = reply;
    return reply;
  }
  async execute(executionInputJson?: string): Promise<OutcomeReply> {
    if (!this.execution) {
      this.execution = Promise.resolve().then(async () => {
        requireWire(this.eligible());
        return this.accept(await this.api.invoke(this.command, { requestJson: this.packet.requestJson, ...(executionInputJson === undefined ? {} : { executionInputJson }) }), false);
      });
      void this.execution.catch(() => undefined);
    }
    try { return await waitForAcknowledgement(this.execution); }
    catch { return this.query(); }
  }
  async query(): Promise<OutcomeReply> {
    try { return this.accept(await waitForAcknowledgement(this.api.invoke(this.queryCommand, { requestJson: this.packet.requestJson })), true); }
    catch (cause) { throw new RecoveryPendingError(this.scope === "analysis_control" ? "cleanup" : this.scope === "analysis_admission" ? "admission" : "result", { cause }); }
  }
  get outcome() { return this.known; }
}
