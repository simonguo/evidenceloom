import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { loadRecovery, loadRuntimeObservation } from "@/features/analysis-recovery/lib/consumer";
import { readBinding, readOrigin, readPage, readWake, sameOrigin } from "@/features/analysis-recovery/lib/protocol";
import type { ReadRequest, RecoveryApi } from "@/features/analysis-recovery/types";
import { BOOTSTRAP_KEY, BUILD_ASSET, DRIVER_MARKER, ERRORS, STEPS } from "../types";
import type { Bootstrap, Checkpoint, ControlReply, DriverError, DriverReply, DriverReport, FinishReply, FinishRequest, WorkerWitness } from "../types";

export class DriverFault extends Error {
  constructor(readonly code: DriverError) { super(code); this.name = "DesktopAcceptanceFault"; }
}
export function requireDriver(condition: unknown, code: DriverError = "identity_mismatch"): asserts condition {
  if (!condition) throw new DriverFault(code);
}
export function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireDriver(value !== null && typeof value === "object" && !Array.isArray(value));
  const object = value as Record<string, unknown>; const actual = Object.keys(object).sort(); const expected = [...keys].sort();
  requireDriver(actual.length === expected.length && actual.every((key, index) => key === expected[index]));
  return object;
}
export function hex(value: unknown, length: number): value is string {
  return typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
}
export function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
export function runId(value: unknown): value is string {
  return typeof value === "string" && /^analysis-(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value.slice(9)) <= BigInt("9223372036854775807");
}
export function versionId(value: unknown): value is string {
  return typeof value === "string" && /^report:[a-f0-9]{64}:[1-9][0-9]{0,18}$/.test(value) && BigInt(value.slice(72)) <= BigInt("9223372036854775807");
}
export function boundedJson(value: unknown, limit = 8192): string {
  const raw = JSON.stringify(value);
  requireDriver(typeof raw === "string" && new TextEncoder().encode(raw).byteLength <= limit, "ipc_rejected");
  return raw;
}
export function parseBootstrap(value: unknown): Bootstrap {
  const o = exact(value, ["schemaVersion", "planVersion", "sessionId", "buildId", "compiledStampSha256", "target", "driverMarker"]);
  requireDriver(o.schemaVersion === 1 && o.planVersion === 1 && hex(o.sessionId, 32) && hex(o.buildId, 64) && hex(o.compiledStampSha256, 64) && o.driverMarker === DRIVER_MARKER && ["x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc"].includes(o.target as string), "bootstrap_mismatch");
  return Object.freeze({ ...o }) as Bootstrap;
}
export function readBootstrap(windowObject: Window): Bootstrap {
  requireDriver(windowObject.top === windowObject && ((windowObject.location.protocol === "tauri:" && windowObject.location.hostname === "localhost") || (["http:", "https:"].includes(windowObject.location.protocol) && windowObject.location.hostname === "tauri.localhost")), "bootstrap_mismatch");
  const descriptor = Object.getOwnPropertyDescriptor(windowObject, BOOTSTRAP_KEY);
  requireDriver(descriptor && descriptor.writable === false && descriptor.configurable === false && "value" in descriptor && Object.isFrozen(descriptor.value), "bootstrap_mismatch");
  return parseBootstrap(descriptor.value);
}
export function validateReport(report: DriverReport, bootstrap: Bootstrap, realm: string): string {
  const o = exact(report, ["schemaVersion", "planVersion", "sessionId", "buildId", "requestId", "realmNonce", "driverMarker", "step", "verdict", "errorCode", "route", "tasks", "renderedReport", "stopControlVisible", "watchControlVisible"]);
  validateEnvelope(o, bootstrap, realm);
  requireDriver(STEPS.includes(report.step) && ["tasks", "settings", "report"].includes(report.route) && ((report.verdict === "pass" && report.errorCode === null) || (report.verdict === "fail" && ERRORS.includes(report.errorCode as DriverError))) && [report.renderedReport, report.stopControlVisible, report.watchControlVisible].every(value => typeof value === "boolean"));
  requireDriver(Array.isArray(report.tasks) && report.tasks.length <= 4);
  const slots = new Set<string>(); const ids = new Set<string>();
  for (const task of report.tasks) {
    exact(task, ["slot", "taskId", "status", "reportVersionId", "runId"]);
    requireDriver(["a", "b", "c", "d"].includes(task.slot) && uuid(task.taskId) && ["queued", "running", "succeeded", "stopped", "failed"].includes(task.status) && (task.reportVersionId === null || versionId(task.reportVersionId)) && (task.runId === null || runId(task.runId)) && !slots.has(task.slot) && !ids.has(task.taskId));
    slots.add(task.slot); ids.add(task.taskId);
  }
  return boundedJson(report);
}
function validateEnvelope(o: Record<string, unknown>, b: Bootstrap, realm: string) {
  requireDriver(o.schemaVersion === 1 && o.planVersion === 1 && o.sessionId === b.sessionId && o.buildId === b.buildId && o.realmNonce === realm && hex(realm, 32) && o.driverMarker === DRIVER_MARKER && typeof o.requestId === "string" && /^[A-Za-z0-9:_-]{1,96}$/.test(o.requestId));
}
export function readDriverReply(value: unknown, b: Bootstrap, requestId: string): DriverReply {
  const o = exact(value, ["schemaVersion", "sessionId", "buildId", "requestId", "status", "attestationOnly"]);
  requireDriver(o.schemaVersion === 1 && o.sessionId === b.sessionId && o.buildId === b.buildId && o.requestId === requestId && o.status === "driver_attestation_recorded" && o.attestationOnly === true, "ipc_rejected");
  boundedJson(o, 4096); return o as DriverReply;
}
export function readFinishReply(value: unknown, b: Bootstrap, request: FinishRequest): FinishReply {
  const o = exact(value, ["schemaVersion", "sessionId", "buildId", "requestId", "status", "driverReason", "privateControlsClosed", "nativeLifecycleHookAttached", "admissionState", "cleanupState", "nativeExitAuthorized"]);
  requireDriver(o.schemaVersion === 1 && o.sessionId === b.sessionId && o.buildId === b.buildId && o.requestId === request.requestId && o.status === "finish_requested" && o.driverReason === request.reason && o.privateControlsClosed === true && typeof o.nativeLifecycleHookAttached === "boolean" && o.admissionState === "unverified" && o.cleanupState === "unverified" && o.nativeExitAuthorized === false, "ipc_rejected");
  boundedJson(o, 4096); return o as FinishReply;
}
export function readWorker(value: unknown): WorkerWitness {
  const o = exact(value, ["origin", "journalId", "binding", "headerDigest", "releaseNonce"]);
  const origin = readOrigin(o.origin); const binding = readBinding(o.binding);
  requireDriver(uuid(origin.taskId) && runId(origin.runId) && binding.taskId === origin.taskId && hex(o.journalId, 64) && hex(o.headerDigest, 64) && hex(o.releaseNonce, 64));
  return Object.freeze({ origin, binding, journalId: o.journalId, headerDigest: o.headerDigest, releaseNonce: o.releaseNonce });
}
export function readControlReply(value: unknown, b: Bootstrap, requestId: string, status: Checkpoint | "worker_released"): ControlReply {
  const o = exact(value, ["schemaVersion", "sessionId", "requestId", "status", "worker", "workerStarted"]);
  requireDriver(o.schemaVersion === 1 && o.sessionId === b.sessionId && o.requestId === requestId && o.status === status && typeof o.workerStarted === "boolean" && (o.worker !== null || o.workerStarted === false), "ipc_rejected");
  boundedJson(o); return Object.freeze({ ...o, worker: o.worker === null ? null : readWorker(o.worker) }) as ControlReply;
}
/** First realm <=58 requests, second <=38: reserve one in each lane for finish. */
export class RequestBudget {
  private issued = 0;
  constructor(private realm: string, private limit: 38 | 58) { requireDriver(hex(realm, 32)); }
  next(finish = false): string {
    requireDriver(this.issued < this.limit - (finish ? 0 : 1), "ipc_rejected");
    return `${this.realm}:${++this.issued}`;
  }
}
/** Real commands remain noncancellable; a UI abort never claims their settlement. */
export function createAcceptanceApi(bootstrap: Bootstrap, realm: string, secondRealm: boolean) {
  const budget = new RequestBudget(realm, secondRealm ? 38 : 58);
  const pending = new Set<Promise<unknown>>(); const unlisteners = new Set<() => Promise<void>>(); let registrations = 0; let disposed = false;
  function track<T>(operation: () => Promise<T>): Promise<T> {
    requireDriver(!disposed && pending.size < 8, "ipc_rejected");
    const promise = Promise.resolve().then(operation); pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise;
  }
  function registerListener(channel: string, handler: (event: { payload: unknown }) => void): Promise<() => Promise<void>> {
    return track(async () => {
      requireDriver(unlisteners.size + registrations < 2, "ipc_rejected"); registrations++;
      try {
        const drop = await listen(channel, handler);
        let unregistering: Promise<void> | undefined;
        const once = (): Promise<void> => {
          if (!unregistering) {
            // The locked SDK implementation returns an async function despite
            // its public () => void type. Promise assimilation retains its ACK.
            requireDriver(pending.size < 10, "ipc_rejected");
            unregistering = Promise.resolve().then(() => drop()); pending.add(unregistering);
            const owned = unregistering;
            // Count stays nonzero through pending/rejected unlisten. Rejection
            // retains this exact failed outcome; it cannot silently look closed.
            owned.then(() => { pending.delete(owned); unlisteners.delete(once); }, () => pending.delete(owned));
          }
          return unregistering;
        };
        unlisteners.add(once);
        if (disposed) { await once(); throw new DriverFault("ipc_rejected"); }
        return once;
      } finally { registrations--; }
    });
  }
  async function disposeListeners() { await Promise.all([...unlisteners].map(drop => drop())); }
  const native: RecoveryApi = { invoke: (command, args) => track(() => invoke(command, args)), listen: registerListener };
  const command = (name: string, requestJson: string) => track(() => invoke(`plugin:desktop-acceptance|${name}`, { requestJson }));
  return {
    async verifyBuildAsset() {
      const response = await track(() => fetch(BUILD_ASSET, { cache: "no-store", credentials: "omit", redirect: "error" }));
      requireDriver(response.ok && response.body, "bootstrap_mismatch");
      const body = response.body;
      const raw = await track(async () => {
        const reader = body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
        try {
          for (let count = 0; count < 16; count++) {
            const part = await reader.read();
            if (part.done) {
              const bytes = new Uint8Array(length); let offset = 0;
              for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
              return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            }
            length += part.value.byteLength; requireDriver(length <= 1024, "bootstrap_mismatch"); chunks.push(part.value);
          }
          throw new DriverFault("bootstrap_mismatch");
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      });
      let value: unknown; try { value = JSON.parse(raw); } catch { throw new DriverFault("bootstrap_mismatch"); }
      const o = exact(value, ["schemaVersion", "buildId"]); requireDriver(o.schemaVersion === 1 && o.buildId === bootstrap.buildId, "bootstrap_mismatch");
    },
    recovery: () => loadRecovery(native), runtime: () => loadRuntimeObservation(native),
    async reportJournal(scope: Pick<WorkerWitness, "origin" | "binding" | "journalId">, throughSeq: string) {
      requireDriver(hex(scope.journalId, 64) && /^[1-9][0-9]{0,18}$/.test(throughSeq) && BigInt(throughSeq) <= BigInt(16), "report_mismatch");
      const request: ReadRequest = { recoveryProtocolVersion: 1, journalId: scope.journalId,
        origin: readOrigin(scope.origin), binding: readBinding(scope.binding), afterSeq: "0", throughSeq, limit: 16 };
      const page = readPage(await native.invoke("read_analysis_journal", { requestJson: boundedJson(request) }), request);
      requireDriver(!page.hasMore && page.lastSeq === throughSeq && page.throughSeq === throughSeq, "report_mismatch");
      return page;
    },
    async checkpoint(checkpoint: Checkpoint) {
      const requestId = budget.next(); const requestJson = boundedJson({ schemaVersion: 1, sessionId: bootstrap.sessionId, requestId, checkpoint });
      return readControlReply(await command("checkpoint", requestJson), bootstrap, requestId, checkpoint);
    },
    async release(worker: WorkerWitness) {
      const witness = readWorker(worker); const requestId = budget.next(); const requestJson = boundedJson({ schemaVersion: 1, sessionId: bootstrap.sessionId, requestId, ...witness });
      const reply = readControlReply(await command("release_worker", requestJson), bootstrap, requestId, "worker_released");
      requireDriver(reply.worker && reply.workerStarted && JSON.stringify(reply.worker) === JSON.stringify(witness), "identity_mismatch");
      return reply;
    },
    async report(report: Omit<DriverReport, "requestId">) {
      const requestId = budget.next(); const request = { ...report, requestId };
      return readDriverReply(await command("driver_report", validateReport(request, bootstrap, realm)), bootstrap, requestId);
    },
    async finish(reason: "complete" | "failed") {
      const request: FinishRequest = { schemaVersion: 1, planVersion: 1, sessionId: bootstrap.sessionId, buildId: bootstrap.buildId, requestId: budget.next(true), realmNonce: realm, driverMarker: DRIVER_MARKER, reason };
      validateEnvelope(exact(request, ["schemaVersion", "planVersion", "sessionId", "buildId", "requestId", "realmNonce", "driverMarker", "reason"]), bootstrap, realm);
      return readFinishReply(await command("finish_session", boundedJson(request)), bootstrap, request);
    },
    async listenWorker(worker: WorkerWitness, onWake: () => void) {
      const witness = readWorker(worker);
      return registerListener(`analysis-journal:${witness.origin.runtimeEpoch}:${witness.origin.runId}`, ({ payload }) => {
        // Validate the real event; retain only a bounded notification count.
        try { const wake = readWake(typeof payload === "string" ? JSON.parse(payload) : payload); if (wake.journalId === witness.journalId && sameOrigin(wake.origin, witness.origin)) onWake(); } catch { /* Invalid wakes do not prove progress. */ }
      });
    },
    disposeListeners,
    pendingCount: () => pending.size, listenerCount: () => unlisteners.size + registrations,
    async close() { disposed = true; await disposeListeners(); },
  };
}
export type AcceptanceApi = ReturnType<typeof createAcceptanceApi>;
