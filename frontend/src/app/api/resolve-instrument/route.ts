import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  buildRunnerEnv,
  collectSensitiveValues,
  redactSensitiveText,
  stripSensitiveKeys,
} from "../_lib/runner-env";

export const runtime = "nodejs";

type ResolvePayload = {
  query?: string;
  settings?: {
    llmProvider?: string;
    backendUrl?: string;
    quickThinkLlm?: string;
    deepThinkLlm?: string;
    apiKey?: string;
    alphaVantageApiKey?: string;
  };
};

const repoRoot = path.resolve(process.cwd(), "..");
const resolverPath = path.join(process.cwd(), "server", "resolve_instrument.py");
const pythonBin = process.env.EVIDENCELOOM_PYTHON
  ?? process.env.TRADINGAGENTS_PYTHON
  ?? process.env.PYTHON
  ?? path.join(repoRoot, ".venv", "bin", "python");

export async function POST(request: NextRequest) {
  let payload: ResolvePayload;
  try {
    payload = await request.json() as ResolvePayload;
  } catch {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  if (!payload.query?.trim()) {
    return new Response("query is required", { status: 400 });
  }

  const result = await runResolver(payload);
  if (!result.ok) {
    return new Response(result.error || "Failed to resolve instrument", { status: 400 });
  }
  return Response.json(result.data);
}

function runResolver(payload: ResolvePayload): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const sensitiveValues = collectSensitiveValues(payload.settings ?? {});
    const child = spawn(pythonBin, [resolverPath], {
      cwd: repoRoot,
      env: buildRunnerEnv(payload.settings ?? {}, repoRoot),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdin.write(JSON.stringify(sanitizePayloadForPython(payload)));
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({
      ok: false,
      error: redactSensitiveText(error.message, sensitiveValues),
    }));
    child.on("close", (code) => {
      const safeStdout = redactSensitiveText(stdout, sensitiveValues);
      const safeStderr = redactSensitiveText(stderr, sensitiveValues);
      if (code && code !== 0) {
        resolve({ ok: false, error: safeStderr.trim() || `Resolver exited with code ${code}` });
        return;
      }
      try {
        resolve({ ok: true, data: JSON.parse(safeStdout) });
      } catch {
        resolve({ ok: false, error: safeStderr.trim() || "Resolver returned invalid JSON" });
      }
    });
  });
}

function sanitizePayloadForPython(payload: ResolvePayload) {
  const { settings = {}, ...rest } = payload;
  const safeSettings = stripSensitiveKeys(settings);
  return { ...rest, ...safeSettings };
}
