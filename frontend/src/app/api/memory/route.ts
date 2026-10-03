import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { parsePayload, uuid } from "@/features/memory/lib/guards";
import { verifyMemoryInventory } from "@/features/memory/lib/validation";
import type { MemoryInventory } from "@/features/memory/types";

export const runtime = "nodejs";

const REQUEST_LIMIT = 16 * 1024;
const OUTPUT_LIMIT = 64 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const DEADLINE_MS = 90_000;
const CLEANUP_MS = 1_000;

type Failure = { ok: false; status: number; error: string };
type Result = Failure | { ok: true; data: MemoryInventory };
const invalidRequest = (): Failure => ({ ok: false, status: 400, error: "Invalid research memory inventory request" });
const unavailable = (): Failure => ({ ok: false, status: 502, error: "Research memory inventory could not be read" });
const invalidOutput = (): Failure => ({ ok: false, status: 502, error: "Research memory reader returned an invalid response" });
const timeout = (): Failure => ({ ok: false, status: 504, error: "Research memory inventory exceeded its time limit" });
const cancelled = (): Failure => ({ ok: false, status: 499, error: "Research memory inventory was cancelled" });

async function readIds(request: Request, deadline: number): Promise<string[]> {
  if (!request.body) throw new Error();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > REQUEST_LIMIT) throw new Error();
        chunks.push(value);
      }
      const value = parsePayload(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      const fields = value as Record<string, unknown>;
      const ids = fields.decisionIds;
      if (Object.keys(fields).length !== 1 || !Array.isArray(ids) || ids.length < 1 || ids.length > 20
        || !ids.every(uuid) || new Set(ids).size !== ids.length) throw new Error();
      return ids as string[];
    };
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error()), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

function readerEnvironment(repoRoot: string): NodeJS.ProcessEnv {
  // Only process-launch and user-directory variables are needed by this
  // stdlib-only reader. Provider credentials and research configuration never
  // enter its environment, and user payloads cannot select filesystem paths.
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL",
    "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.env.TRADINGAGENTS_MEMORY_LOG_PATH !== undefined) {
    env.TRADINGAGENTS_MEMORY_LOG_PATH = process.env.TRADINGAGENTS_MEMORY_LOG_PATH;
  }
  return {
    ...env,
    PYTHONPATH: repoRoot,
    PYTHON_DOTENV_DISABLED: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    LANGCHAIN_TRACING_V2: "false",
    LANGSMITH_TRACING: "false",
  };
}

async function decodeInventory(chunks: Buffer[], ids: string[]): Promise<Result> {
  try {
    const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (!output.endsWith("\n")) return invalidOutput();
    const line = output.slice(0, -1).replace(/\r$/, "");
    if (!line || /[\r\n]/.test(line)) return invalidOutput();
    const value = parsePayload(line);
    if (value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).type === "ready") {
      return { ok: false, status: 502, error: "Research memory inventory is unsupported; update the Python runtime" };
    }
    return { ok: true, data: await verifyMemoryInventory(value, ids) };
  } catch {
    return invalidOutput();
  }
}

function readInventory(ids: string[], request: Request, deadline: number): Promise<Result> {
  const repoRoot = path.resolve(process.env.EVIDENCELOOM_PROJECT_ROOT ?? path.resolve(process.cwd(), ".."));
  const pythonBin = process.env.EVIDENCELOOM_PYTHON ?? process.env.TRADINGAGENTS_PYTHON
    ?? process.env.PYTHON ?? path.join(repoRoot, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(pythonBin, [path.join(repoRoot, "frontend", "server", "run_analysis.py")], {
        cwd: repoRoot, env: readerEnvironment(repoRoot), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      });
    } catch {
      resolve(unavailable());
      return;
    }
    let finished = false;
    let closed = false;
    let failure: Failure | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let stdoutSize = 0;
    let stderrSize = 0;
    const chunks: Buffer[] = [];
    const finish = (result: Result) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      request.signal.removeEventListener("abort", onAbort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      chunks.length = 0;
      resolve(result);
    };
    const fail = (result: Failure) => {
      if (finished || failure) return;
      failure = result;
      if (closed) { finish(result); return; }
      try { child.kill("SIGKILL"); } catch { /* Diagnostics remain fixed and path-free. */ }
      if (!finished) {
        cleanupTimer = setTimeout(() => {
          child.unref();
          finish({ ok: false, status: 502, error: "Research memory reader could not be stopped" });
        }, Math.min(CLEANUP_MS, Math.max(0, deadline - Date.now())));
      }
    };
    const onAbort = () => fail(cancelled());
    const deadlineTimer = setTimeout(() => fail(timeout()), Math.max(0, deadline - CLEANUP_MS - Date.now()));
    child.stdout.on("data", (chunk: Buffer) => {
      if (finished || failure) return;
      stdoutSize += chunk.byteLength;
      if (stdoutSize > OUTPUT_LIMIT) {
        fail({ ok: false, status: 502, error: "Research memory reader output exceeded its limit" });
      } else chunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (finished || failure) return;
      stderrSize += chunk.byteLength;
      if (stderrSize > STDERR_LIMIT) {
        fail({ ok: false, status: 502, error: "Research memory reader output exceeded its limit" });
      }
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => fail(unavailable()));
    child.on("error", () => fail(unavailable()));
    child.on("close", (code: number | null) => {
      closed = true;
      if (finished) return;
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(unavailable()); return; }
      void decodeInventory(chunks, ids).then((result) => {
        if (Date.now() >= deadline) finish(timeout());
        else finish(result);
      });
    });
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) { onAbort(); return; }
    try {
      child.stdin.end(JSON.stringify({ __command: "smoke_test", memoryInventory: true, decisionIds: ids }));
    } catch {
      fail(unavailable());
    }
  });
}

export async function POST(request: Request) {
  const deadline = Date.now() + DEADLINE_MS;
  let ids: string[];
  try {
    ids = await readIds(request, deadline);
  } catch {
    const result = Date.now() >= deadline ? timeout() : invalidRequest();
    return Response.json({ error: result.error }, { status: result.status });
  }
  if (request.signal.aborted) return Response.json({ error: cancelled().error }, { status: 499 });
  if (Date.now() >= deadline - CLEANUP_MS) return Response.json({ error: timeout().error }, { status: 504 });
  const result = await readInventory(ids, request, deadline);
  return result.ok
    ? Response.json(result.data, { headers: { "Cache-Control": "no-store" } })
    : Response.json({ error: result.error }, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
