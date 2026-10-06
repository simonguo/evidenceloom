import { createTranslator } from "@/lib/i18n";
import { compactNumber, formatDuration, taskDetailHref } from "@/components/task-center/utils";
import { gateReady, sameBinding, sameOrigin } from "@/features/analysis-recovery/lib/protocol";
import type { JournalSummary, RecoverySnapshot, RuntimeObservation } from "@/features/analysis-recovery/types";
import type { AnalysisTask, ReportVersion } from "@/lib/types";
import { boundedJson, createAcceptanceApi, DriverFault, exact, hex, readBootstrap, requireDriver, runId, uuid, validateReport, versionId } from "./api";
import type { AcceptanceApi } from "./api";
import { DRIVER_MARKER } from "../types";
import type { Bootstrap, DriverError, DriverReport, DriverStep, DriverView, ReloadHint, TaskAttestation, TaskSlot, WorkerWitness } from "../types";

const HINT_KEY = "evidenceloom-private-ui-driver-v1:reload";
const TOTAL_MS = 90_000;
// Consumed equality assertions against the frozen B03 fixture payload, not inserted report data.
// The next integrated fixture freeze must independently rebind these two expectations.
const FIXTURE_REPORT = "Fictional saved research for isolated WebView acceptance.";
const FIXTURE_STATS = { llmCalls: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, elapsedSeconds: 1 } as const;
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
export function freshRealmNonce(cryptoObject: Pick<Crypto, "getRandomValues"> = crypto): string {
  return [...cryptoObject.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, "0")).join("");
}
export function parseReloadHint(raw: string, bootstrap: Bootstrap, realm: string, now: number): ReloadHint {
  requireDriver(new TextEncoder().encode(raw).byteLength <= 4096);
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new DriverFault("identity_mismatch"); }
  const o = exact(value, ["schemaVersion", "sessionId", "buildId", "stage", "firstRealmNonce", "expiresAt", "tasks", "bReportDigest", "bRenderedDigest"]);
  requireDriver(o.schemaVersion === 1 && o.sessionId === bootstrap.sessionId && o.buildId === bootstrap.buildId && o.stage === "cd_queued" && hex(o.firstRealmNonce, 32) && o.firstRealmNonce !== realm && Number.isSafeInteger(o.expiresAt) && (o.expiresAt as number) > now && (o.expiresAt as number) <= now + TOTAL_MS && hex(o.bReportDigest, 64) && hex(o.bRenderedDigest, 64));
  requireDriver(Array.isArray(o.tasks) && o.tasks.length === 4);
  const report: DriverReport = { schemaVersion: 1, planVersion: 1, sessionId: bootstrap.sessionId, buildId: bootstrap.buildId, requestId: "hint-validation", realmNonce: realm, driverMarker: DRIVER_MARKER, step: "d_queued", verdict: "pass", errorCode: null, route: "tasks", tasks: o.tasks as TaskAttestation[], renderedReport: false, stopControlVisible: false, watchControlVisible: false };
  validateReport(report, bootstrap, realm);
  const slots = new Map(report.tasks.map(task => [task.slot, task]));
  requireDriver(slots.get("a")?.status === "stopped" && slots.get("a")?.reportVersionId === null && runId(slots.get("a")?.runId) && slots.get("b")?.status === "succeeded" && versionId(slots.get("b")?.reportVersionId) && runId(slots.get("b")?.runId) && slots.get("c")?.status === "running" && slots.get("c")?.reportVersionId === null && runId(slots.get("c")?.runId) && slots.get("d")?.status === "queued" && slots.get("d")?.reportVersionId === null && slots.get("d")?.runId === null);
  return o as ReloadHint;
}
export function assertFourTerminal(tasks: readonly TaskAttestation[]) {
  requireDriver(tasks.length === 4 && new Set(tasks.map(task => task.slot)).size === 4 && new Set(tasks.map(task => task.taskId)).size === 4);
  for (const task of tasks) requireDriver(uuid(task.taskId) && runId(task.runId) && ((["a", "c"].includes(task.slot) && task.status === "stopped" && task.reportVersionId === null) || (["b", "d"].includes(task.slot) && task.status === "succeeded" && versionId(task.reportVersionId))), "report_mismatch");
}
export async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value)); requireDriver(bytes.byteLength <= 32768, "report_mismatch");
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function reportFingerprint(version: ReportVersion) {
  requireDriver(versionId(version.id) && runId(version.runId) && !version.legacy && version.reportSections.market_report === FIXTURE_REPORT && Object.keys(version.reportSections).filter(key => version.reportSections[key]).length === 1 && Object.entries(FIXTURE_STATS).every(([key, value]) => version.stats[key as keyof typeof FIXTURE_STATS] === value), "report_mismatch");
  return { id: version.id, runId: version.runId,
    stats: { llmCalls: version.stats.llmCalls, toolCalls: version.stats.toolCalls, tokensIn: version.stats.tokensIn, tokensOut: version.stats.tokensOut, elapsedSeconds: version.stats.elapsedSeconds },
    reportSections: Object.fromEntries(Object.keys(version.reportSections).sort().map(key => [key, version.reportSections[key]])),
  };
}
function visible(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected || element.getClientRects().length === 0 || element.closest("[hidden]")) return false;
  const style = getComputedStyle(element); return style.display !== "none" && style.visibility !== "hidden";
}
export function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: string) {
  requireDriver(!control.disabled && visible(control), "control_unavailable");
  const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set; requireDriver(setter, "control_unavailable");
  setter.call(control, value); control.dispatchEvent(new Event("input", { bubbles: true })); control.dispatchEvent(new Event("change", { bubbles: true }));
}
/** Exact original LlmTestResult div marker; surrounding provider/model text is not a success marker. */
export function modelConnectionSucceeded(scope: ParentNode, language: "zh" | "en"): boolean {
  const expected = language === "zh" ? "模型连接成功" : "Model connection succeeded";
  return [...scope.querySelectorAll<HTMLElement>("div.font-medium")].some(element => visible(element) && normalized(element.textContent ?? "") === expected);
}
function button(scope: ParentNode, text: string): HTMLButtonElement {
  const matches = [...scope.querySelectorAll<HTMLButtonElement>("button")].filter(candidate => visible(candidate) && !candidate.disabled && normalized(candidate.textContent ?? "") === text);
  requireDriver(matches.length === 1, "control_unavailable"); return matches[0];
}
function field(scope: ParentNode, text: string): HTMLInputElement | HTMLSelectElement {
  const labels = [...scope.querySelectorAll<HTMLLabelElement>("label")].filter(label => normalized(label.childNodes[0]?.textContent ?? "") === text || (label.htmlFor && normalized(label.textContent ?? "") === text));
  const controls = labels.map(label => label.control).filter((control): control is HTMLInputElement | HTMLSelectElement => control instanceof HTMLInputElement || control instanceof HTMLSelectElement);
  requireDriver(controls.length === 1 && visible(controls[0]), "control_unavailable"); return controls[0];
}
function route(): DriverReport["route"] { return location.pathname === "/settings" ? "settings" : location.pathname === "/tasks/detail" ? "report" : "tasks"; }
function taskVersion(task: AnalysisTask): ReportVersion | null {
  requireDriver(task.origin === "analysis" && task.reportVersions.length <= 1, "report_mismatch");
  return task.reportVersions[0] ?? null;
}
export function stoppedProjection(snapshot: RecoverySnapshot, witness: WorkerWitness): JournalSummary | null {
  const summary = snapshot.journals.find(journal => journal.journalId === witness.journalId && sameOrigin(journal.origin, witness.origin) && sameBinding(journal.binding, witness.binding));
  return summary && summary.cleanupState === "confirmed" && summary.sealedThroughSeq !== null && summary.appliedSeq === summary.sealedThroughSeq && summary.resultState === "projected" && summary.workerOutcome === "cancelled" ? summary : null;
}

/** The public protocol supplies phase, not a worker-start marker or OS liveness. */
export function workerObservationReady(runtime: RuntimeObservation, taskId: string, expectedRun?: string): boolean {
  return runtime.initialization === "ready" && runtime.runtimeGate === "occupied" && runtime.owner !== null && runtime.owner.phase === "running" && runtime.owner.origin.taskId === taskId && runtime.owner.binding.taskId === taskId && (expectedRun === undefined || runtime.owner.origin.runId === expectedRun);
}
/** Query first; an owner=None checkpoint rejection is never a retry mechanism. */
export async function waitForOriginalWorker(
  api: Pick<AcceptanceApi, "runtime" | "checkpoint">, taskId: string, expectedRun: string | undefined,
  awaitValue: <T>(promise: Promise<T>) => Promise<T>, delay: (milliseconds: number) => Promise<void>,
): Promise<WorkerWitness> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const runtime = await awaitValue(api.runtime());
    if (workerObservationReady(runtime, taskId, expectedRun)) {
      const observed = await awaitValue(api.checkpoint("owner_observed"));
      if (observed.worker && observed.workerStarted) {
        const witness = observed.worker; const fresh = await awaitValue(api.runtime());
        requireDriver(workerObservationReady(fresh, taskId, expectedRun) && fresh.owner && witness.origin.taskId === taskId && fresh.owner.journalId === witness.journalId && sameOrigin(fresh.owner.origin, witness.origin) && sameBinding(fresh.owner.binding, witness.binding), "identity_mismatch");
        return witness;
      }
    }
    if (attempt < 14) await delay(1000); // <=1 Hz and <=15 fresh private checkpoints.
  }
  throw new DriverFault("deadline_exceeded");
}

/** Executes original UI handlers; read-only recovery queries and private controls are separate. */
export async function runPrivateDriver(readView: () => DriverView, signal: AbortSignal) {
  const bootstrap = readBootstrap(window); const realm = freshRealmNonce(); const started = Date.now();
  const rawHint = sessionStorage.getItem(HINT_KEY); const hint = rawHint === null ? null : parseReloadHint(rawHint, bootstrap, realm, started);
  const deadline = hint?.expiresAt ?? started + TOTAL_MS; const api = createAcceptanceApi(bootstrap, realm, hint !== null);
  const slots = new Map<TaskSlot, string>(hint?.tasks.map(task => [task.slot, task.taskId]) ?? []);
  const runs = new Map<TaskSlot, string>(hint?.tasks.filter(task => task.runId !== null).map(task => [task.slot, task.runId!]) ?? []);
  let step: DriverStep = hint ? "realm_reloaded" : "renderer_ready"; let reloadRequested = false; let wakeCount = 0;
  const onPageHide = async () => { try { await api.close(); } catch { /* Native unlisten may remain unconfirmed on external realm destruction. */ } }; window.addEventListener("pagehide", onPageHide, { once: true });
  function remaining() { requireDriver(!signal.aborted && Date.now() < deadline, "deadline_exceeded"); return deadline - Date.now(); }
  async function bounded<T>(promise: Promise<T>, maximum = 15_000, terminal = false): Promise<T> {
    void promise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined; let abort: (() => void) | undefined;
    try {
      const limit = terminal ? maximum : Math.min(remaining(), maximum);
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        if (!terminal) {
          abort = () => reject(new DriverFault("deadline_exceeded")); signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }
        timer = setTimeout(() => reject(new DriverFault("deadline_exceeded")), limit);
      })]);
    } finally { if (timer !== undefined) clearTimeout(timer); if (abort) signal.removeEventListener("abort", abort); }
  }
  async function pause(ms = 100) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await bounded(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), ms + 100); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function wait<T>(read: () => Promise<T | null> | T | null): Promise<T> {
    const until = Math.min(deadline, Date.now() + 15_000);
    while (Date.now() < until) { remaining(); const value = await bounded(Promise.resolve().then(read)); if (value !== null) return value; await pause(); }
    throw new DriverFault("deadline_exceeded");
  }
  function viewTask(slot: TaskSlot): AnalysisTask {
    const task = readView().tasks.find(candidate => candidate.id === slots.get(slot)); requireDriver(task, "identity_mismatch"); return task;
  }
  function attest(): TaskAttestation[] {
    return (["a", "b", "c", "d"] as const).filter(slot => slots.has(slot)).map(slot => {
      const task = viewTask(slot); const version = taskVersion(task);
      const statuses = { queued: "queued", running: "running", completed: "succeeded", stopped: "stopped", error: "failed" } as const;
      requireDriver(task.status in statuses, "unexpected_state");
      return { slot, taskId: task.id, status: statuses[task.status as keyof typeof statuses], reportVersionId: version?.id ?? null, runId: runs.get(slot) ?? version?.runId ?? null };
    });
  }
  function globalControls() { return [...document.querySelectorAll<HTMLElement>('aside[role="alert"]')].find(aside => aside.getAttribute("aria-label") === createTranslator(readView().settings.systemLanguage)("analysisRecoveryTitle") && visible(aside)) ?? null; }
  async function report(nextStep: DriverStep, code: DriverError | null = null, renderedReport = false, terminal = false) {
    step = nextStep; const controls = globalControls(); const t = createTranslator(readView().settings.systemLanguage);
    await bounded(api.report({ schemaVersion: 1, planVersion: 1, sessionId: bootstrap.sessionId, buildId: bootstrap.buildId, realmNonce: realm, driverMarker: DRIVER_MARKER, step, verdict: code === null ? "pass" : "fail", errorCode: code, route: route(), tasks: attest(), renderedReport, stopControlVisible: [...document.querySelectorAll("button")].some(control => visible(control) && normalized(control.textContent ?? "") === t("stopTask")), watchControlVisible: !!controls && [...controls.querySelectorAll("button")].some(control => visible(control) && normalized(control.textContent ?? "") === t("watchExistingAnalysis")) }), terminal ? 3000 : 15_000, terminal);
  }
  async function navigate(path: string) {
    if (location.pathname + location.search === path) return;
    const anchor = await wait(() => [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find(candidate => visible(candidate) && candidate.getAttribute("href") === path) ?? null);
    anchor.click(); await wait(() => location.pathname + location.search === path && document.querySelector("main") ? true : null);
  }
  async function snapshot() { return bounded(api.recovery()); }
  async function create(slot: TaskSlot) {
    requireDriver(!slots.has(slot) && slots.size < 4 && readView().tasks.length === slots.size, "identity_mismatch");
    const previous = new Set(readView().tasks.map(task => task.id)); await navigate("/tasks/new");
    const query = await wait(() => document.querySelector<HTMLInputElement>("#instrument-query")); setControlValue(query, "FICTION");
    requireDriver(query.form, "control_unavailable"); button(query.form, "GO").click();
    const form = await wait(() => [...document.querySelectorAll<HTMLFormElement>("main form")].find(candidate => candidate.querySelector('input[type="date"]')) ?? null);
    const t = createTranslator(readView().settings.systemLanguage);
    setControlValue(field(form, t("analysisDate")), "2024-01-02"); await pause();
    setControlValue(field(form, t("researchDepth")), "1"); await pause();
    setControlValue(field(form, t("outputLanguage")), "English"); await pause();
    const submit = [...form.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].filter(candidate => visible(candidate) && !candidate.disabled); requireDriver(submit.length === 1, "control_unavailable"); submit[0].click();
    const task = await wait(() => {
      const added = readView().tasks.filter(candidate => !previous.has(candidate.id)); requireDriver(added.length <= 1, "identity_mismatch");
      return added.length === 1 ? added[0] : null;
    });
    requireDriver(uuid(task.id) && task.origin === "analysis" && task.ticker === "FICTION" && task.analysisDate === "2024-01-02" && task.reportVersions.length === 0 && ![...slots.values()].includes(task.id), "identity_mismatch");
    slots.set(slot, task.id); await wait(() => location.pathname + location.search === taskDetailHref(task.id) ? true : null);
  }
  async function worker(slot: TaskSlot): Promise<WorkerWitness> {
    const taskId = slots.get(slot); requireDriver(taskId, "identity_mismatch");
    const witness = await waitForOriginalWorker(api, taskId, runs.get(slot), bounded, pause);
    await wait(() => viewTask(slot).status === "running" ? true : null);
    requireDriver(!runs.has(slot) || runs.get(slot) === witness.origin.runId, "identity_mismatch"); runs.set(slot, witness.origin.runId);
    return witness;
  }
  async function queued(slot: TaskSlot, predecessor: WorkerWitness) {
    await wait(async () => {
      const current = await snapshot(); const task = current.tasks.find(candidate => candidate.id === slots.get(slot));
      requireDriver(!current.journals.some(journal => journal.origin.taskId === slots.get(slot)), "identity_mismatch");
      const owner = current.runtime.owner;
      requireDriver(owner && owner.journalId === predecessor.journalId && sameOrigin(owner.origin, predecessor.origin) && sameBinding(owner.binding, predecessor.binding), "identity_mismatch");
      return task?.status === "queued" && viewTask(slot).status === "queued" ? true : null;
    });
  }
  async function stop(slot: "a" | "c", witness: WorkerWitness, global: boolean) {
    const drop = await bounded(api.listenWorker(witness, () => { wakeCount = Math.min(4096, wakeCount + 1); }));
    try {
      const t = createTranslator(readView().settings.systemLanguage);
      if (global) { const controls = await wait(globalControls); requireDriver(readView().nativeAnalysis?.taskId === witness.origin.taskId && readView().nativeAnalysis?.attached, "identity_mismatch"); button(controls, t("stopTask")).click(); }
      else { await navigate(taskDetailHref(witness.origin.taskId)); const main = document.querySelector("main"); requireDriver(main, "control_unavailable"); button(main, t("stopTask")).click(); }
      await wait(async () => { const current = await snapshot(); const task = current.tasks.find(candidate => candidate.id === witness.origin.taskId); return stoppedProjection(current, witness) && task?.status === "stopped" && task.reportVersions.length === 0 && viewTask(slot).status === "stopped" && viewTask(slot).reportVersions.length === 0 ? true : null; });
    } finally { await bounded(drop(), 3000, true); }
    // No listener cleanup or wake count is interpreted as native process cleanup.
  }
  async function success(slot: "b" | "d", witness: WorkerWitness): Promise<ReportVersion> {
    return wait(async () => {
      const current = await snapshot(); const summary = current.journals.find(journal => journal.journalId === witness.journalId && sameOrigin(journal.origin, witness.origin) && sameBinding(journal.binding, witness.binding));
      const nativeTask = current.tasks.find(candidate => candidate.id === witness.origin.taskId); const task = viewTask(slot);
      if (!(summary && summary.cleanupState === "confirmed" && summary.workerOutcome === "succeeded" && summary.sealedThroughSeq !== null && summary.appliedSeq === summary.sealedThroughSeq && summary.resultState === "projected" && nativeTask?.status === "completed" && task.status === "completed")) return null;
      const version = taskVersion(task); const nativeVersion = taskVersion(nativeTask);
      requireDriver(version && nativeVersion && version.runId === witness.origin.runId && version.id.startsWith(`report:${witness.journalId}:`) && JSON.stringify(reportFingerprint(version)) === JSON.stringify(reportFingerprint(nativeVersion)), "report_mismatch"); return version;
    });
  }
  async function rendered(slot: "b" | "d", version: ReportVersion): Promise<string> {
    reportFingerprint(version); await navigate(taskDetailHref(viewTask(slot).id));
    const select = await wait(() => document.querySelector<HTMLSelectElement>("#report-version-select"));
    requireDriver([...select.options].length === 1 && select.value === version.id, "report_mismatch");
    const language = readView().settings.systemLanguage; const title = language === "zh" ? `审阅选中的报告 v${version.versionNumber}` : `Review selected report v${version.versionNumber}`;
    const summary = await wait(() => [...document.querySelectorAll<HTMLElement>("main details > summary")].find(candidate => normalized(candidate.textContent ?? "") === title && visible(candidate)) ?? null);
    const details = summary.parentElement; requireDriver(details instanceof HTMLDetailsElement, "report_mismatch"); if (!details.open) summary.click();
    const preview = await wait(() => [...document.querySelectorAll<HTMLElement>("main [aria-label]")].find(candidate => candidate.getAttribute("aria-label") === (language === "zh" ? `报告版本 v${version.versionNumber} 预览` : `Report version v${version.versionNumber} preview`) && visible(candidate)) ?? null);
    const metadataDetails = preview.querySelector("details"); requireDriver(metadataDetails, "report_mismatch"); if (!metadataDetails.open) metadataDetails.querySelector("summary")?.click();
    const text = await wait(() => normalized(preview.textContent ?? "").includes(version.id) && [...preview.querySelectorAll(".report-markdown p")].some(p => normalized(p.textContent ?? "") === FIXTURE_REPORT) ? normalized(preview.textContent ?? "") : null);
    const t = createTranslator(language); const expected = [[t("llm"), String(version.stats.llmCalls)], [t("tools"), String(version.stats.toolCalls)], [t("tokens"), `${compactNumber(version.stats.tokensIn)}↑ ${compactNumber(version.stats.tokensOut)}↓`], [t("elapsed"), formatDuration(version.stats.elapsedSeconds)]];
    for (const [label, value] of expected) {
      const info = [...document.querySelectorAll<HTMLButtonElement>("main button[title]")].find(candidate => candidate.title === label && visible(candidate));
      const actual = info?.parentElement?.parentElement?.querySelector(".text-lg"); requireDriver(actual && visible(actual) && normalized(actual.textContent ?? "") === value, "report_mismatch");
    }
    return digest({ versionId: version.id, text, metrics: expected });
  }
  try {
    await bounded(api.verifyBuildAsset()); await wait(() => readView().hydrated && readView().storageState === "ready" ? true : null);
    if (!hint) {
      const empty = await snapshot(); requireDriver(empty.tasks.length === 0 && empty.journals.length === 0 && readView().tasks.length === 0 && gateReady(empty.runtime), "unexpected_state");
      await report("renderer_ready"); await bounded(api.checkpoint("renderer_ready")); await bounded(api.checkpoint("runtime_ready"));
      await navigate("/settings"); const t = createTranslator(readView().settings.systemLanguage);
      const form = await wait(() => document.querySelector<HTMLFormElement>("main form"));
      for (const [label, value] of [[t("llmProviderLabel"), "openai"], [t("backendUrlLabel"), "https://fixture.invalid/v1"], [t("quickModelLabel"), "fictional-quick"], [t("deepModelLabel"), "fictional-deep"], [t("llmApiKeyLabel"), "fictional-acceptance-key"]]) { setControlValue(field(form, label), value); await pause(); }
      button(form, readView().settings.systemLanguage === "zh" ? "测试模型" : "Test model").click();
      await wait(() => modelConnectionSucceeded(form, readView().settings.systemLanguage) ? true : null);
      button(form, t("saveSettings")).click(); await wait(() => location.pathname === "/" && readView().settings.backendUrl === "https://fixture.invalid/v1" && readView().settings.quickThinkLlm === "fictional-quick" && readView().settings.deepThinkLlm === "fictional-deep" ? true : null); await report("settings_saved");
      await create("a"); const a = await worker("a"); await report("a_started");
      await create("b"); await queued("b", a); await report("b_queued"); await stop("a", a, false); await report("a_stopped");
      const b = await worker("b"); await bounded(api.release(b)); const bVersion = await success("b", b); const bRenderedDigest = await rendered("b", bVersion); await report("b_saved", null, true);
      await wait(async () => gateReady((await snapshot()).runtime) ? true : null);
      await create("c"); const c = await worker("c"); await report("c_started"); await create("d"); await queued("d", c); await report("d_queued");
      const nextHint: ReloadHint = { schemaVersion: 1, sessionId: bootstrap.sessionId, buildId: bootstrap.buildId, stage: "cd_queued", firstRealmNonce: realm, expiresAt: deadline, tasks: attest(), bReportDigest: await digest(reportFingerprint(bVersion)), bRenderedDigest };
      const hintJson = boundedJson(nextHint, 4096);
      requireDriver(api.pendingCount() === 0, "ipc_rejected"); await bounded(api.disposeListeners(), 3000); requireDriver(api.listenerCount() === 0 && api.pendingCount() === 0, "ipc_rejected");
      sessionStorage.setItem(HINT_KEY, hintJson); reloadRequested = true; location.reload(); return { reloadRequested: true };
    }
    await report("realm_reloaded"); const recovered = await snapshot(); requireDriver(recovered.tasks.length === 4 && readView().tasks.length === 4 && recovered.tasks.every(task => [...slots.values()].includes(task.id)), "identity_mismatch");
    const c = await worker("c"); await queued("d", c);
    const bVersion = taskVersion(viewTask("b")); const nativeBTask = recovered.tasks.find(task => task.id === slots.get("b"));
    const nativeBVersion = nativeBTask && taskVersion(nativeBTask);
    requireDriver(bVersion && nativeBVersion && bVersion.id === hint.tasks.find(task => task.slot === "b")?.reportVersionId && bVersion.runId === runs.get("b") && await digest(reportFingerprint(bVersion)) === hint.bReportDigest && await digest(reportFingerprint(nativeBVersion)) === hint.bReportDigest, "report_mismatch");
    requireDriver(await rendered("b", bVersion) === hint.bRenderedDigest, "report_mismatch"); await report("b_report_restored", null, true);
    const controls = await wait(globalControls); const t = createTranslator(readView().settings.systemLanguage);
    requireDriver(readView().nativeAnalysis?.taskId === c.origin.taskId && !readView().nativeAnalysis?.attached, "identity_mismatch"); button(controls, t("watchExistingAnalysis")).click(); await wait(() => readView().nativeAnalysis?.taskId === c.origin.taskId && readView().nativeAnalysis?.attached ? true : null);
    await stop("c", c, true); await report("c_stopped"); const d = await worker("d"); await bounded(api.release(d)); const dVersion = await success("d", d); await rendered("d", dVersion); await report("d_saved", null, true);
    const final = await snapshot(); requireDriver(gateReady(final.runtime) && final.tasks.length === 4 && final.journals.length === 4 && final.tasks.every(task => [...slots.values()].includes(task.id)), "unexpected_state");
    const terminalTasks = attest(); assertFourTerminal(terminalTasks);
    for (const attestation of terminalTasks) {
      const nativeTask = final.tasks.find(task => task.id === attestation.taskId);
      const journal = final.journals.find(candidate => candidate.origin.taskId === attestation.taskId && candidate.origin.runId === attestation.runId);
      requireDriver(nativeTask && journal && journal.cleanupState === "confirmed" && journal.resultState === "projected" && journal.sealedThroughSeq !== null && journal.appliedSeq === journal.sealedThroughSeq, "report_mismatch");
      const saved = taskVersion(nativeTask);
      requireDriver((attestation.status === "stopped" && nativeTask.status === "stopped" && saved === null && journal.workerOutcome === "cancelled") || (attestation.status === "succeeded" && nativeTask.status === "completed" && saved && saved.id === attestation.reportVersionId && saved.runId === attestation.runId && saved.id.startsWith(`report:${journal.journalId}:`) && journal.workerOutcome === "succeeded"), "report_mismatch");
    }
    await bounded(api.disposeListeners(), 3000); requireDriver(api.listenerCount() === 0 && api.pendingCount() === 0, "ipc_rejected"); await report("complete", null, true);
    const finish = await bounded(api.finish("complete"), 3000); sessionStorage.removeItem(HINT_KEY);
    // This reply deliberately grants no native cleanup or exit authorization.
    return { reloadRequested: false, finish, wakeCount };
  } catch (cause) {
    if (!reloadRequested) {
      const code = cause instanceof DriverFault ? cause.code : "unexpected_state";
      // Failure reporting is best effort and finite. Never copy exception text or user values.
      try { await report(step, code, false, true); } catch { /* External watchdog must catch missing attestation. */ }
      try { await bounded(api.finish("failed"), 3000, true); } catch { /* No retry or cleanup-success claim. */ }
    }
    throw new DriverFault(cause instanceof DriverFault ? cause.code : "unexpected_state");
  } finally { window.removeEventListener("pagehide", onPageHide); try { await bounded(api.close(), 3000, true); } catch { /* Failure is retained; no closed/idle proof is manufactured. */ } }
}

// React StrictMode can subscribe, release, then resubscribe in one microtask.
// A lease keeps that cycle from creating a second four-task run or a false finish.
let realmDriver: { leases: number; abort: AbortController } | null = null;
export function attachRealmDriver(readView: () => DriverView): () => void {
  if (!realmDriver) {
    const abort = new AbortController(); realmDriver = { leases: 0, abort };
    void runPrivateDriver(readView, abort.signal).catch(() => undefined);
  }
  const owned = realmDriver; owned.leases++;
  return () => { owned.leases--; queueMicrotask(() => { if (owned.leases === 0) owned.abort.abort(); }); };
}
