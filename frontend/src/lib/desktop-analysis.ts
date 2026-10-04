import { stripSecretFields } from "@/features/persistence/local-storage";
import { createTranslator } from "./i18n";
import { errorMessage } from "./errors";
import type { AnalysisEvent, AnalysisForm, SystemLanguage } from "./types";

type DesktopApi = {
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
};

const ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;

export class AnalysisCleanupError extends Error {
  constructor(language: SystemLanguage, cause: unknown) {
    super(createTranslator(language)("analysisCleanupFailed"), { cause });
    this.name = "AnalysisCleanupError";
  }
}

class AcknowledgementTimeout extends AnalysisCleanupError {}

async function boundedAcknowledgement<T>(promise: Promise<T>, language: SystemLanguage): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AcknowledgementTimeout(language,
        new Error("Analysis acknowledgement has not been confirmed."))), ACKNOWLEDGEMENT_TIMEOUT_MS);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function hasCleanupCode(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && error.code === "analysis_cleanup_incomplete";
}

export function isAnalysisCleanupError(error: unknown): boolean {
  return error instanceof AnalysisCleanupError || hasCleanupCode(error);
}

class DesktopAnalysisSession {
  readonly reservation: Promise<string>;
  readonly cancelled: Promise<void>;
  runId?: string;
  reservationPending = true;
  stopPending = false;
  registration?: Promise<void>;
  registrationPending = false;
  unlisten?: () => void;
  cancellationRequested = false;
  private registrationDeadline = 0;
  private notifyCancellation!: () => void;
  private stopAttempt?: Promise<void>;
  private stopFailed = false;

  constructor(readonly taskId: string, readonly language: SystemLanguage, readonly api: DesktopApi) {
    this.cancelled = new Promise((resolve) => { this.notifyCancellation = resolve; });
    this.reservation = Promise.resolve().then(async () => {
      let runId: unknown;
      try { runId = await api.invoke<unknown>("reserve_analysis", { taskId }); }
      finally { this.reservationPending = false; }
      if (typeof runId !== "string" || !runId) throw new Error("Analysis reservation was not acknowledged.");
      this.runId = runId;
      return runId;
    });
  }

  waitForReservation() {
    return boundedAcknowledgement(this.reservation, this.language);
  }

  waitForStop(retry = false) {
    return boundedAcknowledgement(this.stop(retry), this.language);
  }

  suppressEvents() { this.cancellationRequested = true; }

  cancel() {
    this.cancellationRequested = true;
    this.notifyCancellation();
  }

  register(handler: (event: { payload: AnalysisEvent | string }) => void) {
    this.registrationPending = true;
    this.registrationDeadline = Date.now() + ACKNOWLEDGEMENT_TIMEOUT_MS;
    this.registration = Promise.resolve().then(() => this.api.listen(`analysis-event:${this.taskId}:${this.runId}`, handler))
      .then((unlisten) => {
        this.registrationPending = false;
        this.unlisten = unlisten;
        // A timeout/cancellation may precede the acknowledgement. Dispose this owner only.
        if (this.cancellationRequested) this.disposeListener();
      }, (error: unknown) => {
        this.registrationPending = false;
        throw error;
      });
    // A late rejection remains observable to retry; it must not become an unhandled rejection.
    void this.registration.catch(() => undefined);
  }

  async waitForRegistration(cleanup = false) {
    if (!this.registration) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await (this.registrationPending ? Promise.race([
        this.registration,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AnalysisCleanupError(this.language,
            new Error("Analysis event listener acknowledgement timed out."))), Math.max(0, this.registrationDeadline - Date.now()));
        }),
      ]) : this.registration);
    } catch (error) {
      // runAnalysis preserves registration failure. Cleanup retries any retained disposal handle.
      if (!cleanup || this.registrationPending) throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  stop(retry = false): Promise<void> {
    this.cancel();
    if (this.stopAttempt && !(retry && this.stopFailed)) return this.stopAttempt;
    this.stopFailed = false;
    this.stopPending = true;
    this.stopAttempt = this.reservation.then((runId) => this.api.invoke<void>("stop_analysis", { taskId: this.taskId, runId }))
      .catch((error: unknown) => {
        this.stopFailed = true;
        throw new AnalysisCleanupError(this.language, error);
      }).finally(() => { this.stopPending = false; });
    // The abort event cannot await. Keep its result for runAnalysis/explicit stop to observe.
    void this.stopAttempt.catch(() => undefined);
    return this.stopAttempt;
  }

  disposeListener() {
    if (!this.unlisten) return;
    try {
      this.unlisten();
      this.unlisten = undefined;
    } catch (error) {
      throw new AnalysisCleanupError(this.language, error);
    }
  }
}

const sessions = new Map<string, DesktopAnalysisSession>();

function retire(session: DesktopAnalysisSession) {
  if (sessions.get(session.taskId) === session) sessions.delete(session.taskId);
}

function abortError() {
  return new DOMException("Analysis was aborted", "AbortError");
}

export async function runDesktopAnalysis(api: DesktopApi, taskId: string, payload: AnalysisForm, onEvent: (event: AnalysisEvent) => void, signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
  if (sessions.has(taskId)) throw new AnalysisCleanupError(payload.systemLanguage, new Error("Previous analysis is still active."));
  const session = new DesktopAnalysisSession(taskId, payload.systemLanguage, api);
  sessions.set(taskId, session);
  const abort = () => { void session.stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  let failure: unknown;
  let failed = false;
  let backendCleanupFailed = false;
  let acknowledgementTimedOut = false;
  try {
    const runId = await session.waitForReservation();
    if (session.cancellationRequested || signal?.aborted) {
      await session.waitForStop();
      throw abortError();
    }
    session.register((event) => {
      if (sessions.get(taskId) !== session || session.cancellationRequested) return;
      try {
        onEvent(typeof event.payload === "string" ? JSON.parse(event.payload) as AnalysisEvent : event.payload);
      } catch (error) {
        onEvent({ type: "error", error: errorMessage(error, createTranslator(payload.systemLanguage)("analysisRequestFailed")) });
      }
    });
    await session.waitForRegistration();
    if (session.cancellationRequested || signal?.aborted) {
      await session.waitForStop();
      throw abortError();
    }
    await Promise.race([
      api.invoke<void>("start_analysis", { taskId, runId, payloadJson: JSON.stringify(stripSecretFields(payload)) }),
      session.cancelled.then(async () => { await session.waitForStop(); throw abortError(); }),
    ]);
    if (session.cancellationRequested || signal?.aborted) {
      await session.waitForStop();
      throw abortError();
    }
  } catch (error) {
    session.suppressEvents();
    acknowledgementTimedOut = error instanceof AcknowledgementTimeout;
    failed = true;
    backendCleanupFailed = hasCleanupCode(error);
    failure = backendCleanupFailed ? new AnalysisCleanupError(payload.systemLanguage, error) : error;
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      if (failed && !backendCleanupFailed && (session.runId || session.reservationPending)) {
        // Keep the original stop promise: a late reservation must be stopped, never started.
        void session.stop();
        if (!acknowledgementTimedOut) await session.waitForStop();
      }
      await session.waitForRegistration(true);
      session.disposeListener();
      if (!backendCleanupFailed && !session.reservationPending && !session.stopPending) retire(session);
    } catch (cleanupFailure) {
      session.suppressEvents();
      failure = failed ? new AnalysisCleanupError(payload.systemLanguage, new AggregateError([failure, cleanupFailure])) : cleanupFailure;
      failed = true;
    }
  }
  if (failed) throw failure;
}

export async function stopDesktopAnalysis(taskId: string): Promise<void> {
  const session = sessions.get(taskId);
  if (!session) return;
  await session.waitForStop(true);
  await session.waitForRegistration(true);
  session.disposeListener();
  retire(session);
}
