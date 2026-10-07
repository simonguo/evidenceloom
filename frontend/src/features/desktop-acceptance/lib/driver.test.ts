import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskListPage from "@/app/page";
import { taskDetailHref } from "@/components/task-center/utils";
import type { JournalHeader, ReadReply, RecoverySnapshot, RuntimeObservation } from "@/features/analysis-recovery/types";
import { reduceJournalPage } from "@/features/analysis-recovery/lib/reducer";
import { envelope, header as recoveryHeader, summary as recoverySummary, task as recoveryTask } from "@/features/analysis-recovery/test-support/fixtures";
import type { ReportVersion } from "@/lib/types";
import type { Bootstrap, ControlReply, DriverReport, FinishRequest, ReloadHint, TaskAttestation, WorkerWitness } from "../types";
import { BOOTSTRAP_KEY, DRIVER_MARKER } from "../types";
import { createAcceptanceApi, DriverFault, parseBootstrap, readBootstrap, readControlReply, readDriverReply, readFinishReply, readWorker, RequestBudget, validateReport, versionId } from "./api";
import { assertFourTerminal, freshRealmNonce, modelConnectionSucceeded, navigateVisibleRoute, parseReloadHint, reportFingerprint, savedReportFingerprint, setControlValue, stoppedProjection, waitForOriginalWorker, workerObservationReady } from "./driver";
import { DesktopVerificationEntry as DisabledEntry } from "../../desktop-verification/disabled";
import { DesktopVerificationEntry as PrivateEntry } from "../entry";

const wire = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
const navigation = vi.hoisted(() => ({ center: vi.fn(), router: { push: vi.fn(), prefetch: vi.fn() } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: wire.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: wire.listen }));
vi.mock("@/components/task-center/context", () => ({ useTaskCenter: () => navigation.center() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation.router }));
const sessionId = "1".repeat(32); const realm = "2".repeat(32); const buildId = "3".repeat(64);
const taskIds = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004"];
const bootstrap: Bootstrap = { schemaVersion: 1, planVersion: 1, sessionId, buildId, compiledStampSha256: "4".repeat(64), target: "aarch64-apple-darwin", driverMarker: DRIVER_MARKER };
const witness: WorkerWitness = { origin: { runtimeEpoch: "5".repeat(64), taskId: taskIds[0], runId: "analysis-1" }, journalId: "6".repeat(64), binding: { collection: { collectionId: "7".repeat(64), epoch: "1" }, taskId: taskIds[0], generation: "1" }, headerDigest: "8".repeat(64), releaseNonce: "9".repeat(64) };
const researchRunId = "20000000-0000-4000-8000-000000000001";
const tasks = (): TaskAttestation[] => taskIds.map((taskId, index) => ({ slot: (["a", "b", "c", "d"] as const)[index], taskId, status: index % 2 ? "succeeded" : "stopped", reportVersionId: index % 2 ? `report:${String(index).repeat(64)}:4` : null, runId: `analysis-${index + 1}` }));
const report = (): DriverReport => ({ schemaVersion: 1, planVersion: 1, sessionId, buildId, requestId: "real-request:1", realmNonce: realm, driverMarker: DRIVER_MARKER, step: "complete", verdict: "pass", errorCode: null, route: "report", tasks: tasks(), renderedReport: true, stopControlVisible: false, watchControlVisible: false });
const hint = (): ReloadHint => ({ schemaVersion: 1, sessionId, buildId, stage: "cd_queued", firstRealmNonce: "a".repeat(32), expiresAt: 50000, tasks: tasks().map(task => task.slot === "c" ? { ...task, status: "running" } : task.slot === "d" ? { ...task, status: "queued", reportVersionId: null, runId: null } : task), bReportDigest: "b".repeat(64), bRenderedDigest: "c".repeat(64) });
const finishRequest: FinishRequest = { schemaVersion: 1, planVersion: 1, sessionId, buildId, requestId: "finish:1", realmNonce: realm, driverMarker: DRIVER_MARKER, reason: "complete" };
const finishReply = () => ({ schemaVersion: 1, sessionId, buildId, requestId: finishRequest.requestId, status: "finish_requested", driverReason: "complete", privateControlsClosed: true, nativeLifecycleHookAttached: false, admissionState: "unverified", cleanupState: "unverified", nativeExitAuthorized: false });
function fixtureReportVersion(reportSections: ReportVersion["reportSections"]): ReportVersion {
  return {
    id: `report:${"a".repeat(64)}:4`, runId: researchRunId, versionNumber: 4,
    createdAt: "2025-01-01T00:00:00.000Z", legacy: false,
    task: { ticker: "FICTION", instrumentName: "Fictional acceptance fixture", analysisDate: "2025-01-01", assetType: "stock", researchDepth: 1, analysts: ["market"], outputLanguage: "en" },
    run: null, decision: "", reportSections,
    stats: { llmCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, elapsedSeconds: 1 },
    evaluationReviews: [],
  };
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function committedReportFixture() {
  const original = recoveryHeader();
  const header: JournalHeader = { ...original, journalId: witness.journalId, origin: witness.origin, binding: witness.binding, headerDigest: witness.headerDigest,
    reservedHead: { ...original.reservedHead, taskId: witness.origin.taskId, generation: witness.binding.generation },
    context: { ...original.context, originalRunContext: { ...original.context.originalRunContext, runId: researchRunId } } };
  const rows = [
    envelope(header, 1, "accepted", { resetVersion: 1 }),
    envelope(header, 2, "analysis", { event: { type: "progress", message: "Original worker progress" } }),
    envelope(header, 3, "analysis", { event: { type: "completed", reportSections: { market_report: "Fictional saved research for isolated WebView acceptance." }, stats: { llmCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, elapsedSeconds: 1 } } }),
    envelope(header, 4, "reader_outcome", { stream: "stdout", outcome: "eof", code: null }),
    envelope(header, 5, "reader_outcome", { stream: "stderr", outcome: "eof", code: null }),
    envelope(header, 6, "worker_outcome", { outcome: "succeeded", code: null }),
  ];
  const reduced = await reduceJournalPage({ ...recoveryTask(), id: witness.origin.taskId }, header, rows);
  const summary = { ...recoverySummary(header, "6", "6"), sealedThroughSeq: "6", workerOutcome: "succeeded" as const, cleanupState: "confirmed" as const, resultState: "projected" as const };
  const page: ReadReply = { recoveryProtocolVersion: 1, header, summary, afterSeq: "0", throughSeq: "6", lastSeq: "6", hasMore: false, rows, rangeProof: { fromSeq: "0", throughSeq: "6", digest: "f".repeat(64) } };
  return { page, version: reduced.task.reportVersions[0] };
}
beforeEach(() => { wire.invoke.mockReset(); wire.listen.mockReset(); });

describe("finite private metadata contract", () => {
  it("preserves both entry signatures without invoking the private React component", () => {
    const typed: () => null = PrivateEntry; expect(typeof typed).toBe("function"); expect(DisabledEntry()).toBeNull();
  });
  it("rejects bootstrap extra fields, invalid plan and malformed stamp", () => {
    expect(parseBootstrap(bootstrap)).toEqual(bootstrap);
    for (const changed of [{ ...bootstrap, path: "/private" }, { ...bootstrap, planVersion: 2 }, { ...bootstrap, compiledStampSha256: "Z".repeat(64) }]) expect(() => parseBootstrap(changed)).toThrow(DriverFault);
  });
  it("requires a frozen nonreplaceable top local bootstrap instead of Tauri globals", () => {
    const local = { location: { protocol: "tauri:", hostname: "localhost" } } as unknown as Window;
    Object.defineProperty(local, "top", { value: local }); Object.defineProperty(local, BOOTSTRAP_KEY, { value: Object.freeze({ ...bootstrap }), writable: false, configurable: false });
    expect(readBootstrap(local)).toEqual(bootstrap);
    const remote = { location: { protocol: "https:", hostname: "example.invalid" } } as unknown as Window;
    Object.defineProperty(remote, "top", { value: remote }); Object.defineProperty(remote, BOOTSTRAP_KEY, { value: Object.freeze({ ...bootstrap }) });
    expect(() => readBootstrap(remote)).toThrow(DriverFault);
  });
  it("serializes exactly fifteen report fields and explicit nullable task fields", () => {
    const raw = validateReport(report(), bootstrap, realm); const parsed = JSON.parse(raw);
    expect(Object.keys(parsed)).toHaveLength(15); expect(Object.keys(parsed.tasks[0])).toHaveLength(5); expect(parsed.errorCode).toBeNull(); expect(parsed.tasks[0].reportVersionId).toBeNull();
  });
  it("rejects duplicate task slots, reused IDs, free-form errors and omission of null", () => {
    const original = report();
    for (const changed of [{ ...original, tasks: [original.tasks[0], original.tasks[0]] }, { ...original, tasks: [{ ...original.tasks[1], taskId: taskIds[0] }, original.tasks[0]] }, { ...original, verdict: "fail", errorCode: "raw secret" }, { ...original, errorCode: undefined }]) expect(() => validateReport(changed as DriverReport, bootstrap, realm)).toThrow(DriverFault);
  });
  it("rejects an attestation reply promoted into native truth", () => {
    const good = { schemaVersion: 1, sessionId, buildId, requestId: "r1", status: "driver_attestation_recorded", attestationOnly: true };
    expect(readDriverReply(good, bootstrap, "r1").attestationOnly).toBe(true);
    expect(() => readDriverReply({ ...good, attestationOnly: false }, bootstrap, "r1")).toThrow(DriverFault);
    expect(() => readDriverReply({ ...good, cleanupConfirmed: true }, bootstrap, "r1")).toThrow(DriverFault);
  });
  it("keeps finish cleanup/admission unverified and exit unauthorized", () => {
    expect(readFinishReply(finishReply(), bootstrap, finishRequest).nativeExitAuthorized).toBe(false);
    for (const changed of [{ ...finishReply(), cleanupState: "confirmed" }, { ...finishReply(), nativeExitAuthorized: true }, { ...finishReply(), privateControlsClosed: false }]) expect(() => readFinishReply(changed, bootstrap, finishRequest)).toThrow(DriverFault);
  });
  it("requires matching worker identities and real started-marker shape", () => {
    expect(readWorker(witness)).toEqual(witness);
    expect(() => readWorker({ ...witness, binding: { ...witness.binding, taskId: taskIds[1] } })).toThrow(DriverFault);
    expect(() => readControlReply({ schemaVersion: 1, sessionId, requestId: "r", status: "owner_observed", worker: null, workerStarted: true }, bootstrap, "r", "owner_observed")).toThrow(DriverFault);
  });
  it("bounds counters using the native signed-64 grammar", () => {
    expect(versionId(`report:${"a".repeat(64)}:9223372036854775807`)).toBe(true);
    for (const seq of ["0", "04", "9223372036854775808"]) expect(versionId(`report:${"a".repeat(64)}:${seq}`)).toBe(false);
  });
  it("reserves a finish request while bounding both realms together to 96", () => {
    const first = new RequestBudget(realm, 58); const second = new RequestBudget("a".repeat(32), 38);
    const issued = [...Array.from({ length: 57 }, () => first.next()), ...Array.from({ length: 37 }, () => second.next())];
    expect(() => first.next()).toThrow(DriverFault); expect(() => second.next()).toThrow(DriverFault);
    issued.push(first.next(true), second.next(true)); expect(issued).toHaveLength(96); expect(new Set(issued).size).toBe(96); expect(() => first.next(true)).toThrow(DriverFault);
  });
});

describe("reload and projected report boundaries", () => {
  it("accepts only the exact four-ID queued-CD safe hint in a distinct realm", () => {
    expect(parseReloadHint(JSON.stringify(hint()), bootstrap, realm, 1000)).toEqual(hint());
    for (const changed of [{ ...hint(), sessionId: "0".repeat(32) }, { ...hint(), firstRealmNonce: realm }, { ...hint(), expiresAt: 999 }, { ...hint(), reportBody: "do not persist" }, { ...hint(), tasks: hint().tasks.slice(0, 3) }]) expect(() => parseReloadHint(JSON.stringify(changed), bootstrap, realm, 1000)).toThrow(DriverFault);
  });
  it("refuses early D admission or a saved version on stopped A/C", () => {
    const h = hint();
    expect(() => parseReloadHint(JSON.stringify({ ...h, tasks: h.tasks.map(task => task.slot === "d" ? { ...task, status: "running", runId: "analysis-4" } : task) }), bootstrap, realm, 1000)).toThrow(DriverFault);
    expect(() => assertFourTerminal(tasks().map(task => task.slot === "a" ? { ...task, reportVersionId: `report:${"a".repeat(64)}:4` } : task))).toThrow(DriverFault);
    expect(() => assertFourTerminal(tasks().map(task => task.slot === "b" ? { ...task, runId: null } : task))).toThrow(DriverFault);
    expect(() => assertFourTerminal(tasks())).not.toThrow();
  });
  it("checks fixed real-fixture report text and stats instead of fabricating saved data", () => {
    const version = fixtureReportVersion({ market_report: "Fictional saved research for isolated WebView acceptance." });
    expect(reportFingerprint(version).runId).toBe(researchRunId);
    expect(() => reportFingerprint({ ...version, reportSections: { market_report: "different persisted body" } })).toThrow(DriverFault);
    expect(() => reportFingerprint({ ...version, stats: { ...version.stats, llmCalls: 1 } })).toThrow(DriverFault);
  });
  it("requires original-run seal=applied, cancelled outcome, and confirmed cleanup", () => {
    const summary = { journalId: witness.journalId, origin: witness.origin, binding: witness.binding, cleanupState: "confirmed", sealedThroughSeq: "4", appliedSeq: "4", resultState: "projected", workerOutcome: "cancelled" };
    const snapshot = (journal: unknown) => ({ journals: [journal] } as unknown as RecoverySnapshot);
    expect(stoppedProjection(snapshot(summary), witness)).toBeTruthy();
    for (const changed of [{ ...summary, appliedSeq: "3" }, { ...summary, sealedThroughSeq: null }, { ...summary, cleanupState: "unknown" }, { ...summary, workerOutcome: "succeeded" }, { ...summary, origin: { ...witness.origin, runId: "analysis-999" } }]) expect(stoppedProjection(snapshot(changed), witness)).toBeNull();
  });
  it("generates a fresh 128-bit realm nonce from actual supplied randomness", () => {
    const source = { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => { (array as Uint8Array).fill(171); return array; } };
    expect(freshRealmNonce(source)).toBe("ab".repeat(16));
  });
});

describe("committed research identity and native origin (production reducer, mocked IPC)", () => {
  it("reads the original journal and binds a reducer-created research UUID while wire runId remains analysis-N", async () => {
    const { page, version } = await committedReportFixture();
    wire.invoke.mockImplementation(async (command, args) => {
      expect(command).toBe("read_analysis_journal");
      expect(JSON.parse(args.requestJson)).toEqual({ recoveryProtocolVersion: 1, journalId: witness.journalId, origin: witness.origin, binding: witness.binding, afterSeq: "0", throughSeq: "6", limit: 16 });
      return page;
    });
    const api = createAcceptanceApi(bootstrap, realm, false);
    const actual = await api.reportJournal(witness, "6");
    const proof = savedReportFingerprint(actual, witness, version, structuredClone(version), witness.headerDigest);
    expect(version.runId).toBe(researchRunId); expect(version.runId).not.toBe(witness.origin.runId);
    expect(proof.researchRunId).toBe(researchRunId); expect(proof.report.runId).toBe(researchRunId); expect(proof.origin.runId).toBe("analysis-1");
    const attestation = { ...report(), tasks: tasks().map(task => task.slot === "a" ? { ...task, taskId: taskIds[1] } : task.slot === "b" ? { ...task, taskId: witness.origin.taskId, reportVersionId: version.id, runId: witness.origin.runId } : task) };
    expect(JSON.parse(validateReport(attestation, bootstrap, realm)).tasks[1].runId).toBe("analysis-1");
    expect(() => validateReport({ ...attestation, tasks: attestation.tasks.map(task => task.slot === "b" ? { ...task, runId: version.runId } : task) }, bootstrap, realm)).toThrow(DriverFault);
    expect(wire.invoke).toHaveBeenCalledTimes(1); await api.close();
  });
  it("rejects a wrong research UUID even when native and UI copies agree on it", async () => {
    const { page, version } = await committedReportFixture();
    const wrong = { ...version, runId: taskIds[3] };
    expect(() => savedReportFingerprint(page, witness, wrong, wrong, witness.headerDigest)).toThrow(DriverFault);
    expect(() => savedReportFingerprint(page, witness, version, wrong, witness.headerDigest)).toThrow(DriverFault);
    expect(() => reportFingerprint({ ...version, runId: witness.origin.runId })).toThrow(DriverFault);
    const header = { ...page.header, context: { ...page.header.context, originalRunContext: { ...page.header.context.originalRunContext, runId: taskIds[3] } } };
    expect(() => savedReportFingerprint({ ...page, header }, witness, version, version, witness.headerDigest)).toThrow(DriverFault);
  });
  it("rejects a different journal header, header digest, task binding or native origin", async () => {
    const { page, version } = await committedReportFixture();
    const changed = [
      { ...page.header, journalId: "0".repeat(64) },
      { ...page.header, headerDigest: "0".repeat(64) },
      { ...page.header, origin: { ...page.header.origin, runId: "analysis-999" } },
      { ...page.header, origin: { ...page.header.origin, taskId: taskIds[1] }, binding: { ...page.header.binding, taskId: taskIds[1] }, reservedHead: { ...page.header.reservedHead, taskId: taskIds[1] } },
    ];
    for (const header of changed) expect(() => savedReportFingerprint({ ...page, header }, witness, version, version, witness.headerDigest)).toThrow();
    expect(() => savedReportFingerprint(page, { ...witness, binding: { ...witness.binding, generation: "2" } }, version, version, witness.headerDigest)).toThrow(DriverFault);
  });
  it("rejects an unbound completion seed or unsealed/partial journal instead of trusting a report prefix", async () => {
    const { page, version } = await committedReportFixture();
    const wrong = { ...version, id: `report:${witness.journalId}:2` };
    expect(() => savedReportFingerprint(page, witness, wrong, wrong, witness.headerDigest)).toThrow(DriverFault);
    expect(() => savedReportFingerprint({ ...page, hasMore: true }, witness, version, version, witness.headerDigest)).toThrow(DriverFault);
    expect(() => savedReportFingerprint({ ...page, summary: { ...page.summary, appliedSeq: "5" } }, witness, version, version, witness.headerDigest)).toThrow(DriverFault);
    expect(() => savedReportFingerprint({ ...page, summary: { ...page.summary, cleanupState: "unknown" } }, witness, version, version, witness.headerDigest)).toThrow(DriverFault);
    const api = createAcceptanceApi(bootstrap, realm, false);
    await expect(api.reportJournal(witness, "17")).rejects.toThrow(DriverFault); expect(wire.invoke).not.toHaveBeenCalled(); await api.close();
  });
  it("keeps reload/final provenance fingerprints stable while rejecting changed native report bytes", async () => {
    const { page, version } = await committedReportFixture();
    const original = savedReportFingerprint(page, witness, version, structuredClone(version), witness.headerDigest);
    const reloaded = savedReportFingerprint(structuredClone(page), page.summary, structuredClone(version), structuredClone(version), null);
    expect(JSON.stringify(reloaded)).toBe(JSON.stringify(original));
    expect(() => savedReportFingerprint(page, witness, version, { ...version, stats: { ...version.stats, elapsedSeconds: 2 } }, witness.headerDigest)).toThrow(DriverFault);
    expect(() => savedReportFingerprint(page, witness, version, { ...version, createdAt: "2025-01-01T00:00:00.000Z" }, witness.headerDigest)).toThrow(DriverFault);
    const swappedHeader = savedReportFingerprint({ ...page, header: { ...page.header, headerDigest: "0".repeat(64) } }, page.summary, version, version, null);
    expect(JSON.stringify(swappedHeader)).not.toBe(JSON.stringify(original));
  });
});

describe("real transport ownership bookkeeping (mocked IPC, no App proof)", () => {
  it("dispatches the original five-field worker witness and rejects a swapped release ack", async () => {
    wire.invoke.mockImplementation(async (command, args) => { const request = JSON.parse(args.requestJson); expect(command).toBe("plugin:desktop-acceptance|release_worker"); expect(request.releaseNonce).toBe(witness.releaseNonce); expect(request.origin).toEqual(witness.origin); return { schemaVersion: 1, sessionId, requestId: request.requestId, status: "worker_released", worker: { ...witness, releaseNonce: "0".repeat(64) }, workerStarted: true }; });
    const api = createAcceptanceApi(bootstrap, realm, false); await expect(api.release(witness)).rejects.toThrow(DriverFault); await api.close();
  });
  it("unlistens exactly once even if registration arrives after closing", async () => {
    const registration = deferred<() => void>(); const drop = vi.fn(); wire.listen.mockReturnValue(registration.promise);
    const api = createAcceptanceApi(bootstrap, realm, false); const pending = api.listenWorker(witness, vi.fn()); await Promise.resolve(); await api.close(); registration.resolve(drop);
    await expect(pending).rejects.toThrow(DriverFault); expect(drop).toHaveBeenCalledTimes(1); expect(api.listenerCount()).toBe(0);
  });
  it("filters malformed and wrong-origin wake events and disposes valid subscription once", async () => {
    let handler!: (event: { payload: unknown }) => void; const drop = vi.fn(); const wake = vi.fn();
    wire.listen.mockImplementation(async (channel, callback) => { expect(channel).toBe(`analysis-journal:${witness.origin.runtimeEpoch}:${witness.origin.runId}`); handler = callback; return drop; });
    const api = createAcceptanceApi(bootstrap, realm, false); const unlisten = await api.listenWorker(witness, wake);
    const payload = { recoveryProtocolVersion: 1, journalId: witness.journalId, origin: witness.origin, latestSeq: "4", controlRevision: "1" };
    handler({ payload: { ...payload, origin: { ...witness.origin, runId: "analysis-2" } } }); handler({ payload: "invalid" }); expect(wake).not.toHaveBeenCalled(); handler({ payload }); expect(wake).toHaveBeenCalledTimes(1);
    await unlisten(); await api.disposeListeners(); await api.close(); expect(drop).toHaveBeenCalledTimes(1);
  });
  it("does not erase outstanding noncancellable IPC on close", async () => {
    const operation = deferred<unknown>(); wire.invoke.mockReturnValue(operation.promise);
    const api = createAcceptanceApi(bootstrap, realm, false); const pending = api.checkpoint("renderer_ready"); await Promise.resolve(); expect(api.pendingCount()).toBe(1); await api.close(); expect(api.pendingCount()).toBe(1);
    operation.resolve({ schemaVersion: 1, sessionId, requestId: `${realm}:1`, status: "renderer_ready", worker: null, workerStarted: false }); await pending; expect(api.pendingCount()).toBe(0);
  });
  it("reads the real LlmTestResult div and rejects wrong, hidden or stale generic text", () => {
    const form = document.createElement("form"); const marker = document.createElement("div"); marker.className = "font-medium"; marker.textContent = "Model connection succeeded"; form.append(marker); document.body.append(form);
    vi.spyOn(marker, "getClientRects").mockReturnValue([{ width: 10, height: 10 }] as unknown as DOMRectList);
    expect(modelConnectionSucceeded(form, "en")).toBe(true); expect(modelConnectionSucceeded(form, "zh")).toBe(false);
    marker.hidden = true; expect(modelConnectionSucceeded(form, "en")).toBe(false); marker.hidden = false;
    marker.textContent = "Model connection failed"; expect(modelConnectionSucceeded(form, "en")).toBe(false);
    marker.textContent = "Model connection succeeded"; marker.className = "text-xs"; expect(modelConnectionSucceeded(form, "en")).toBe(false); form.remove();
  });
  it("uses the DOM property setter and bubbles real input/change events", () => {
    const input = document.createElement("input"); document.body.append(input); vi.spyOn(input, "getClientRects").mockReturnValue([{ width: 10, height: 10 }] as unknown as DOMRectList); const events: string[] = [];
    input.addEventListener("input", () => events.push("input")); input.addEventListener("change", () => events.push("change")); setControlValue(input, "FICTION"); expect(input.value).toBe("FICTION"); expect(events).toEqual(["input", "change"]); input.remove();
  });
});


describe("exact-owner polling and semantic report fingerprints", () => {
  const current = (owner: RuntimeObservation["owner"], runtimeGate: RuntimeObservation["runtimeGate"] = owner ? "occupied" : "vacant"): RuntimeObservation => ({ recoveryProtocolVersion: 1, initialization: "ready", runtimeEpoch: witness.origin.runtimeEpoch, observationRevision: "1", owner, runtimeGate, journalGate: "ready", blockers: [] });
  const owner = { origin: witness.origin, admissionRequestId: "original-admission", admissionDigest: "a".repeat(64), journalId: witness.journalId, binding: witness.binding, phase: "running" as const, controlRevision: "0", cleanupState: "pending" as const };
  const checkpointReply: ControlReply = { schemaVersion: 1, sessionId, requestId: "owner-checkpoint", status: "owner_observed", worker: witness, workerStarted: true };
  const awaitValue = <T>(promise: Promise<T>) => promise;
  it("polls legitimate owner vacancy/preparing state without issuing a rejecting checkpoint", async () => {
    const calls: string[] = []; const runtime = vi.fn().mockResolvedValueOnce(current(null)).mockResolvedValueOnce(current({ ...owner, phase: "preparing" })).mockResolvedValue(current(owner));
    const checkpoint = vi.fn(async () => { calls.push("checkpoint"); return checkpointReply; }); const delay = vi.fn(async (ms: number) => { expect(ms).toBe(1000); calls.push("delay"); });
    expect(await waitForOriginalWorker({ runtime, checkpoint }, taskIds[0], undefined, awaitValue, delay)).toEqual(witness); expect(checkpoint).toHaveBeenCalledTimes(1); expect(delay).toHaveBeenCalledTimes(2); expect(calls).toEqual(["delay", "delay", "checkpoint"]);
  });
  it("does not treat a different owner or reloaded run as the original", () => {
    expect(workerObservationReady(current(owner), taskIds[0], "analysis-1")).toBe(true);
    expect(workerObservationReady(current(owner), taskIds[1])).toBe(false); expect(workerObservationReady(current(owner), taskIds[0], "analysis-999")).toBe(false); expect(workerObservationReady(current(owner, "vacant"), taskIds[0])).toBe(false);
  });
  it("waits for an actual started marker and rejects unrelated native checkpoint errors", async () => {
    const runtime = vi.fn(async () => current(owner)); const delay = vi.fn(async () => undefined); const checkpoint = vi.fn().mockResolvedValueOnce({ ...checkpointReply, workerStarted: false }).mockResolvedValue(checkpointReply);
    await expect(waitForOriginalWorker({ runtime, checkpoint }, taskIds[0], undefined, awaitValue, delay)).resolves.toEqual(witness); expect(delay).toHaveBeenCalledTimes(1); expect(checkpoint).toHaveBeenCalledTimes(2);
    const failure = new DriverFault("ipc_rejected"); const rejected = vi.fn(async () => { throw failure; }); await expect(waitForOriginalWorker({ runtime, checkpoint: rejected }, taskIds[0], undefined, awaitValue, delay)).rejects.toBe(failure); expect(rejected).toHaveBeenCalledTimes(1);
  });
  it("bounds unavailable-owner observations to fifteen attempts without private sink polling", async () => {
    const runtime = vi.fn(async () => current(null)); const checkpoint = vi.fn(); const delay = vi.fn(async () => undefined);
    await expect(waitForOriginalWorker({ runtime, checkpoint }, taskIds[0], undefined, awaitValue, delay)).rejects.toThrow(DriverFault); expect(runtime).toHaveBeenCalledTimes(15); expect(checkpoint).not.toHaveBeenCalled(); expect(delay).toHaveBeenCalledTimes(14);
  });
  it("canonicalizes protocol fields while preserving original literal report text", () => {
    const version = fixtureReportVersion({ market_report: "Fictional saved research for isolated WebView acceptance.", news_report: null });
    const reordered = { ...version, stats: { elapsedSeconds: 1, tokensOut: 0, tokensIn: 0, toolCalls: 0, llmCalls: 0 }, reportSections: { news_report: null, market_report: version.reportSections.market_report } };
    expect(JSON.stringify(reportFingerprint(version))).toBe(JSON.stringify(reportFingerprint(reordered)));
    expect(() => reportFingerprint({ ...reordered, reportSections: { ...reordered.reportSections, market_report: "different original bytes" } })).toThrow(DriverFault);
  });
});

describe("actual async unlisten acknowledgement and capacity", () => {
  it("retains the listener and pending work until the SDK async drop acknowledges", async () => {
    const acknowledgement = deferred<void>(); const drop = vi.fn(() => acknowledgement.promise); wire.listen.mockResolvedValue(drop);
    const api = createAcceptanceApi(bootstrap, realm, false); const unlisten = await api.listenWorker(witness, vi.fn()); const closing = api.disposeListeners(); await Promise.resolve();
    expect(drop).toHaveBeenCalledTimes(1); expect(api.listenerCount()).toBe(1); expect(api.pendingCount()).toBe(1); expect(unlisten()).toBe(unlisten());
    acknowledgement.resolve(); await closing; expect(api.listenerCount()).toBe(0); expect(api.pendingCount()).toBe(0); await api.close(); expect(drop).toHaveBeenCalledTimes(1);
  });
  it("retains failed async unlisten instead of claiming closed or retrying it", async () => {
    const acknowledgement = deferred<void>(); const drop = vi.fn(() => acknowledgement.promise); wire.listen.mockResolvedValue(drop);
    const api = createAcceptanceApi(bootstrap, realm, false); const unlisten = await api.listenWorker(witness, vi.fn()); const attempt = unlisten(); acknowledgement.reject(new Error("mock native unlisten rejection"));
    await expect(attempt).rejects.toThrow(); expect(api.listenerCount()).toBe(1); expect(api.pendingCount()).toBe(0); await expect(api.close()).rejects.toThrow(); expect(drop).toHaveBeenCalledTimes(1);
  });
  it("awaits a late-registration async drop after closing and preserves its pending count", async () => {
    const registration = deferred<() => void>(); const acknowledgement = deferred<void>(); const drop = vi.fn(() => acknowledgement.promise); wire.listen.mockReturnValue(registration.promise);
    const api = createAcceptanceApi(bootstrap, realm, false); const joining = api.listenWorker(witness, vi.fn()); await Promise.resolve(); await api.close(); registration.resolve(drop); await Promise.resolve(); await Promise.resolve();
    expect(api.pendingCount()).toBeGreaterThan(0); expect(api.listenerCount()).toBeGreaterThan(0); acknowledgement.resolve(); await expect(joining).rejects.toThrow(DriverFault); expect(drop).toHaveBeenCalledTimes(1); expect(api.listenerCount()).toBe(0); expect(api.pendingCount()).toBe(0);
  });
  it("reserves at most two listener registration/retained-ack slots", async () => {
    const first = deferred<() => void>(); const second = deferred<() => void>(); wire.listen.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const api = createAcceptanceApi(bootstrap, realm, false); const a = api.listenWorker(witness, vi.fn()); const b = api.listenWorker(witness, vi.fn()); const rejected = api.listenWorker(witness, vi.fn());
    await expect(rejected).rejects.toThrow(DriverFault); expect(wire.listen).toHaveBeenCalledTimes(2); expect(api.listenerCount()).toBe(2);
    const ackA = deferred<void>(); const dropA = vi.fn(() => ackA.promise); const dropB = vi.fn(async () => undefined); first.resolve(dropA); second.resolve(dropB); const [unlistenA] = await Promise.all([a, b]); const pending = unlistenA();
    await expect(api.listenWorker(witness, vi.fn())).rejects.toThrow(DriverFault); expect(wire.listen).toHaveBeenCalledTimes(2); ackA.resolve(); await pending; await api.close(); expect(dropA).toHaveBeenCalledTimes(1); expect(dropB).toHaveBeenCalledTimes(1);
  });
});

describe("visible task navigation through the actual list page (mocked router, no App proof)", () => {
  let root: Root | null = null, main: HTMLElement | null = null, home: HTMLAnchorElement | null = null;
  let originalRoute = "", homeClicks = 0, lookupCalls = 0;
  async function lookup<T>(read: () => Promise<T | null> | T | null): Promise<T> {
    lookupCalls++;
    for (let attempt = 0; attempt < 3; attempt++) { const value = await read(); if (value !== null) return value; }
    throw new DriverFault("deadline_exceeded");
  }
  async function unmount() {
    if (root) { const owned = root; root = null; await act(async () => owned.unmount()); }
    main?.remove(); main = null; home?.remove(); home = null;
  }
  async function mount(includeB = true) {
    history.replaceState(null, "", taskDetailHref(taskIds[3])); homeClicks = 0; lookupCalls = 0;
    navigation.router.push.mockReset().mockImplementation((href: string) => history.replaceState(null, "", href));
    const listTasks = taskIds.map((id, index) => ({ ...recoveryTask(), id, ticker: "FICTION", status: (["stopped", "completed", "running", "queued"] as const)[index] })).filter(task => includeB || task.id !== taskIds[1]);
    navigation.center.mockReturnValue({ settings: { systemLanguage: "en" }, sortedTasks: listTasks,
      runningTask: null, queuedTasks: [], cleanupFailedTask: null, cleanupRetrying: false, cleanupUnconfirmed: false,
      resultPendingTask: null, resultRetrying: false, stopping: false, retryCleanup: vi.fn(), retryResult: vi.fn(),
      getQueuePosition: () => 1, stopRunningTask: vi.fn(), cancelQueuedTask: vi.fn(), moveQueuedTask: vi.fn() });
    const container = document.createElement("div"); container.hidden = true;
    main = document.createElement("main"); main.append(container); document.body.append(main);
    const listLink = document.createElement("a"); listLink.setAttribute("href", "/"); listLink.textContent = "Tasks";
    listLink.addEventListener("click", event => { event.preventDefault(); homeClicks++; history.replaceState(null, "", "/"); container.hidden = false; });
    document.body.append(listLink); home = listLink;
    root = createRoot(container); const owned = root; await act(async () => owned.render(createElement(TaskListPage)));
  }
  beforeEach(() => {
    originalRoute = location.pathname + location.search + location.hash;
    navigation.center.mockReset(); navigation.router.prefetch.mockReset();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
      return (this.isConnected && !this.closest("[hidden]") ? [{ width: 10, height: 10 }] : []) as unknown as DOMRectList;
    });
  });
  afterEach(async () => { await unmount(); history.replaceState(null, "", originalRoute); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("returns through the visible list link and clicks the actual UUID-bound row despite identical tickers", async () => {
    await mount();
    expect([...document.querySelectorAll<HTMLTableRowElement>('main tr[role="link"][data-task-id]')].map(row => row.dataset.taskId)).toEqual(taskIds);
    await act(async () => navigateVisibleRoute(taskDetailHref(taskIds[1]), taskIds[1], lookup));
    expect(homeClicks).toBe(1); expect(navigation.router.push).toHaveBeenCalledTimes(1); expect(navigation.router.push).toHaveBeenCalledWith(taskDetailHref(taskIds[1]));
    expect(location.pathname + location.search).toBe(taskDetailHref(taskIds[1])); expect(lookupCalls).toBe(2);
  });
  it("preserves direct visible links and an already-matched route without returning to the list", async () => {
    await mount(); const direct = document.createElement("a"); direct.setAttribute("href", taskDetailHref(taskIds[1])); let clicks = 0;
    direct.addEventListener("click", event => { event.preventDefault(); clicks++; history.replaceState(null, "", taskDetailHref(taskIds[1])); }); document.body.append(direct);
    try {
      await navigateVisibleRoute(taskDetailHref(taskIds[1]), taskIds[1], lookup);
      await navigateVisibleRoute(taskDetailHref(taskIds[1]), taskIds[1], lookup);
      expect(clicks).toBe(1); expect(homeClicks).toBe(0); expect(navigation.router.push).not.toHaveBeenCalled(); expect(lookupCalls).toBe(2);
    } finally { direct.remove(); }
  });
  it("refuses missing, hidden and wrong-ID rows instead of choosing another same-ticker task", async () => {
    for (const shape of ["missing", "hidden", "wrong-id"] as const) {
      await mount(shape !== "missing");
      const row = document.querySelector<HTMLTableRowElement>(`main tr[data-task-id="${taskIds[1]}"]`);
      if (shape === "hidden") { expect(row).not.toBeNull(); row!.hidden = true; }
      if (shape === "wrong-id") { expect(row).not.toBeNull(); row!.dataset.taskId = taskIds[2]; }
      await expect(navigateVisibleRoute(taskDetailHref(taskIds[1]), taskIds[1], lookup)).rejects.toThrow(DriverFault);
      expect(homeClicks).toBe(1); expect(navigation.router.push).not.toHaveBeenCalled(); expect(location.pathname + location.search).toBe("/"); await unmount();
    }
  });
  it("refuses duplicate visible UUID rows before clicking either original control", async () => {
    await mount(); const row = document.querySelector<HTMLTableRowElement>(`main tr[data-task-id="${taskIds[1]}"]`)!;
    row.parentElement!.append(row.cloneNode(true));
    await expect(navigateVisibleRoute(taskDetailHref(taskIds[1]), taskIds[1], lookup)).rejects.toThrow(DriverFault);
    expect(homeClicks).toBe(1); expect(navigation.router.push).not.toHaveBeenCalled();
  });
  it("rejects a task path that differs from the explicit expected UUID", async () => {
    await mount(); await expect(navigateVisibleRoute(taskDetailHref(taskIds[1]), taskIds[2], lookup)).rejects.toThrow(DriverFault);
    expect(homeClicks).toBe(0); expect(navigation.router.push).not.toHaveBeenCalled(); expect(lookupCalls).toBe(0);
  });
  it("fails without a visible list route instead of fabricating a missing task link", async () => {
    await mount(); home!.hidden = true;
    await expect(navigateVisibleRoute(taskDetailHref(taskIds[1]), taskIds[1], lookup)).rejects.toThrow(DriverFault);
    expect(homeClicks).toBe(0); expect(navigation.router.push).not.toHaveBeenCalled(); expect(location.pathname + location.search).toBe(taskDetailHref(taskIds[3]));
  });
});
