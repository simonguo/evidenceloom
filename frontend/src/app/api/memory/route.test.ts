// @vitest-environment node
import { webcrypto } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as nativeSleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@/features/evidence/lib/validation";
import type { DecisionSnapshot, MemoryBundle, MemoryInventory, ReviewAttachment } from "@/features/memory/types";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import { POST } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const SECRET = "provider-private-value";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  request = "";
  closed = false;
  unref = vi.fn();
  kill = vi.fn(() => { this.close(null); return true; });
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => { this.request += chunk.toString("utf-8"); });
  }
  close(code: number | null = 0) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
}

function request(value: unknown = { decisionIds: [ID] }, signal?: AbortSignal) {
  return new Request("http://localhost/api/memory", { method: "POST", body: JSON.stringify(value), signal });
}

function setupChild(script: (child: FakeChild) => void) {
  const child = new FakeChild();
  spawnMock.mockImplementation(() => { queueMicrotask(() => script(child)); return child; });
  return child;
}

function inventory(ids: string[] = [ID]): MemoryInventory {
  return { type: "memory_inventory", schema_version: 1, requested_ids: ids, reviews: [], missing_ids: ids, timestamp: "12:34:56" };
}

function output(value: unknown, code = 0, stderr = "") {
  return setupChild((child) => {
    child.stdout.write(`${JSON.stringify(value)}\n`);
    child.stderr.write(stderr);
    child.close(code);
  });
}

async function realReader(source: string, action: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(path.join(tmpdir(), "memory-reader-"));
  const server = path.join(directory, "frontend", "server");
  mkdirSync(server, { recursive: true });
  writeFileSync(path.join(server, "run_analysis.py"), source);
  vi.stubEnv("EVIDENCELOOM_PROJECT_ROOT", directory);
  vi.stubEnv("EVIDENCELOOM_PYTHON", process.execPath);
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnMock.mockImplementation(actual.spawn);
  try { await action(directory); }
  finally {
    for (const result of spawnMock.mock.results) {
      const child = result.value as import("node:child_process").ChildProcess | undefined;
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.kill("SIGKILL");
        await Promise.race([closed, nativeSleep(1_000)]);
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

beforeEach(() => {
  spawnMock.mockReset();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("read-only memory inventory route", () => {
  it("uses only the known bootstrap command and controlled server launch configuration", async () => {
    vi.stubEnv("EVIDENCELOOM_PROJECT_ROOT", "/controlled/research");
    vi.stubEnv("EVIDENCELOOM_PYTHON", "/controlled/python");
    vi.stubEnv("TRADINGAGENTS_MEMORY_LOG_PATH", "/controlled/memory.md");
    vi.stubEnv("OPENAI_API_KEY", SECRET);
    vi.stubEnv("ALPHA_VANTAGE_API_KEY", SECRET);
    vi.stubEnv("LANGCHAIN_API_KEY", SECRET);
    vi.stubEnv("LANGCHAIN_TRACING_V2", "true");
    vi.stubEnv("LANGSMITH_TRACING", "true");
    vi.stubEnv("PYTHON_DOTENV_DISABLED", "0");
    vi.stubEnv("PYTHONPATH", "/uncontrolled/module-path");
    const child = output(inventory(), 0, `private stderr ${SECRET} /Users/private/store`);
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(inventory());
    expect(JSON.parse(child.request)).toEqual({ __command: "smoke_test", memoryInventory: true, decisionIds: [ID] });
    const [python, args, options] = spawnMock.mock.calls[0];
    const controlledRoot = path.resolve("/controlled/research");
    expect(python).toBe("/controlled/python");
    expect(args).toEqual([path.join(controlledRoot, "frontend", "server", "run_analysis.py")]);
    expect(options.cwd).toBe(controlledRoot);
    expect(options.windowsHide).toBe(true);
    expect(options.env.PYTHONPATH).toBe(controlledRoot);
    expect(options.env.TRADINGAGENTS_MEMORY_LOG_PATH).toBe("/controlled/memory.md");
    expect(options.env.PYTHON_DOTENV_DISABLED).toBe("1");
    expect(options.env.LANGCHAIN_TRACING_V2).toBe("false");
    expect(options.env.LANGSMITH_TRACING).toBe("false");
    expect(Object.values(options.env)).not.toContain(SECRET);
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([
    null, [], {}, { decisionIds: [] }, { decisionIds: "not-a-list" },
    { decisionIds: [ID, ID] }, { decisionIds: ["ABCDEFAB-1111-4111-8111-111111111111"] }, { decisionIds: ["../private"] },
    { decisionIds: Array.from({ length: 21 }, (_, i) => `${i.toString().padStart(8, "0")}-1111-4111-8111-111111111111`) },
    { decisionIds: [ID], pythonPath: "/arbitrary/python" },
    { decisionIds: [ID], projectRoot: "/arbitrary/research" },
    { decisionIds: [ID], apiKey: SECRET }, { decisionIds: [ID], settings: {} },
  ])("rejects invalid identities and unknown client fields before launching: %j", async (value) => {
    const response = await POST(request(value));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid research memory inventory request" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    `{"decisionIds":["${ID}"],"decisionIds":["${ID}"]}`,
    "{broken-json",
    JSON.stringify({ decisionIds: [ID], padding: "x".repeat(16 * 1024) }),
  ])("rejects malformed, duplicate-key and oversized request bodies", async (body) => {
    const response = await POST(new Request("http://localhost/api/memory", { method: "POST", body }));
    expect(response.status).toBe(400);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("requires an exit-zero validated response, never stderr evidence", async () => {
    output(inventory(), 9, `${SECRET} https://private.example/path?apikey=${SECRET}`);
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(JSON.stringify({ error: "Research memory inventory could not be read" }));
  });

  it("rejects an older source runtime's ready event without entering research", async () => {
    const child = output({ type: "ready", timestamp: "12:34:56" });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Research memory inventory is unsupported; update the Python runtime" });
    expect(JSON.parse(child.request).__command).toBe("smoke_test");
  });

  it.each([
    JSON.stringify(inventory()),
    `${JSON.stringify(inventory())}\n\n`,
    `${JSON.stringify(inventory())}\n{"type":"error","error":"bad"}\n`,
    `${JSON.stringify(inventory())} {}\n`,
    `{"type":"memory_inventory","type":"memory_inventory","schema_version":1,"requested_ids":["${ID}"],"reviews":[],"missing_ids":["${ID}"]}\n`,
    `{"type":"memory_inventory","schema_version":1,"requested_ids":["${ID}"],"reviews":[],"missing_ids":["${ID}"],"schema_version":1}\n`,
    `{"type":"error","error":"${SECRET} /Users/private/store"}\n`,
    "not-json\n",
    "",
  ])("requires exactly one strict newline-framed JSON event", async (text) => {
    setupChild((child) => { child.stdout.write(text); child.close(); });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Research memory reader returned an invalid response" });
  });

  it("accepts a single CRLF-framed event and chunk boundaries", async () => {
    setupChild((child) => {
      const bytes = Buffer.from(`${JSON.stringify(inventory())}\r\n`);
      for (let position = 0; position < bytes.length; position += 3) child.stdout.write(bytes.subarray(position, position + 3));
      child.close();
    });
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(inventory());
  });

  it.each([
    { ...inventory(), missing_ids: [] },
    { ...inventory(), missing_ids: [ID, ID] },
    { ...inventory(), requested_ids: [OTHER_ID], missing_ids: [OTHER_ID] },
    { ...inventory(), missing_ids: [OTHER_ID] },
    { ...inventory(), timestamp: "99:00:00" },
    { ...inventory(), timestamp: "１２:00:00" },
    { ...inventory(), timestamp: null },
    { ...inventory(), path: "/Users/private/store" },
  ])("rejects incomplete partitions, identities and unapproved protocol fields", async (value) => {
    output(value);
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Research memory reader returned an invalid response" });
  });

  it("rejects invalid UTF-8 rather than replacing bytes", async () => {
    setupChild((child) => { child.stdout.write(Buffer.from([0xc3, 0x28, 0x0a])); child.close(); });
    const response = await POST(request());
    expect(response.status).toBe(502);
  });

  it("does not accept a fake inventory on stderr", async () => {
    setupChild((child) => { child.stderr.write(`${JSON.stringify(inventory())}\n`); child.close(); });
    const response = await POST(request());
    expect(response.status).toBe(502);
  });

  it("kills the reader when stdout exceeds the byte limit", async () => {
    const child = setupChild((process) => { process.stdout.write(Buffer.alloc(64 * 1024 * 1024 + 1)); });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Research memory reader output exceeded its limit" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("bounds discarded stderr and kills a noisy reader without exposing it", async () => {
    const child = setupChild((process) => { process.stderr.write(Buffer.alloc(64 * 1024 + 1, SECRET)); });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Research memory reader output exceeded its limit" });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("reserves cleanup time within the total ninety-second deadline", async () => {
    vi.useFakeTimers();
    const child = setupChild(() => undefined);
    const result = POST(request());
    await vi.advanceTimersByTimeAsync(89_000);
    const response = await result;
    expect(response.status).toBe(504);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.closed).toBe(true);
    expect(await response.json()).toEqual({ error: "Research memory inventory exceeded its time limit" });
  });

  it("bounds cleanup when a process never reports close", async () => {
    vi.useFakeTimers();
    const child = setupChild(() => undefined);
    child.kill.mockImplementation(() => true);
    const result = POST(request());
    await vi.advanceTimersByTimeAsync(90_000);
    const response = await result;
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Research memory reader could not be stopped" });
    expect(child.unref).toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
  });

  it("does not launch a reader after the request consumes the cleanup reserve", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ decisionIds: [ID] })));
          controller.close();
        }, 89_500);
      },
    });
    const result = POST(new Request("http://localhost/api/memory", { method: "POST", body, duplex: "half" } as RequestInit));
    await vi.advanceTimersByTimeAsync(89_500);
    const response = await result;
    expect(response.status).toBe(504);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("terminates an aborted request and exposes a fixed diagnostic", async () => {
    const controller = new AbortController();
    const child = setupChild(() => controller.abort());
    const response = await POST(request({ decisionIds: [ID] }, controller.signal));
    expect(response.status).toBe(499);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not disclose a spawn error or filesystem path", async () => {
    spawnMock.mockImplementation(() => { throw new Error(`${SECRET} /Users/private/python`); });
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Research memory inventory could not be read" });
  });

  it("reads a real subprocess over the known request without credentials or dotenv", async () => {
    vi.stubEnv("OPENAI_API_KEY", SECRET);
    await realReader(`
      const fs = require('node:fs');
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const request = JSON.parse(input);
        const safe = request.__command === 'smoke_test' && request.memoryInventory === true
          && !process.env.OPENAI_API_KEY && process.env.PYTHON_DOTENV_DISABLED === '1';
        fs.writeFileSync('checked', String(safe));
        process.stderr.write('${SECRET} /Users/private/python');
        process.stdout.write(JSON.stringify({type:'memory_inventory',schema_version:1,
          requested_ids:request.decisionIds,reviews:[],missing_ids:request.decisionIds})+'\\n');
      });
    `, async (directory) => {
      const response = await POST(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ...inventory(), timestamp: undefined });
      expect(readFileSync(path.join(directory, "checked"), "utf-8")).toBe("true");
    });
  });

  it("kills an actually started hanging reader and waits for its process exit", async () => {
    await realReader(`
      require('node:fs').writeFileSync('started', String(process.pid));
      process.stdin.resume();
      setInterval(() => {}, 1000);
    `, async (directory) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const result = POST(request());
      const started = path.join(directory, "started");
      const stopWaiting = process.hrtime.bigint() + BigInt(3_000_000_000);
      while (!existsSync(started) && process.hrtime.bigint() < stopWaiting) await nativeSleep(10);
      expect(existsSync(started)).toBe(true);
      await vi.advanceTimersByTimeAsync(89_000);
      const response = await result;
      expect(response.status).toBe(504);
      const child = spawnMock.mock.results[0].value as import("node:child_process").ChildProcess;
      expect(child.killed).toBe(true);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    });
  });

  it("preserves the entire native numeric artifact string in a validated review attachment", async () => {
    const bundle = JSON.parse(readFileSync(new URL("../../../../../tests/fixtures/memory_bundle_v1.json", import.meta.url), "utf-8")) as MemoryBundle;
    const snapshot: DecisionSnapshot = bundle.input_snapshot.decisions[0];
    const body = { schema_version: 1 as const, decision_id: snapshot.run_id, reviewed_at: "2025-02-15T12:00:00.000000Z", snapshot };
    const review: ReviewAttachment = { ...body, attachment_sha256: await sha256(body) };
    const event: MemoryInventory = {
      type: "memory_inventory", schema_version: 1, requested_ids: [snapshot.run_id, ID], reviews: [review], missing_ids: [ID],
    };
    output(event);
    const response = await POST(request({ decisionIds: event.requested_ids }));
    expect(response.status).toBe(200);
    const received = await response.json() as MemoryInventory;
    expect(received).toEqual(event);
    const calculationRef = snapshot.outcome!.calculation_sha256!;
    const payload = received.reviews[0].snapshot.artifacts[calculationRef].payload;
    expect(payload).toBe(snapshot.artifacts[calculationRef].payload);
    expect(payload).toContain("123.45678901234567");
    expect(payload).toContain("0.0026250092036250727");
    expect(received.reviews[0].snapshot.reflection).toEqual(snapshot.reflection);
  });
});
