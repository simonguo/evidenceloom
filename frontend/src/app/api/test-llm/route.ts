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

type TestLlmPayload = {
  llmProvider?: string;
  backendUrl?: string;
  quickThinkLlm?: string;
  deepThinkLlm?: string;
  apiKey?: string;
  temperature?: string;
  openaiReasoningEffort?: string;
  googleThinkingLevel?: string;
  anthropicEffort?: string;
  alphaVantageApiKey?: string;
};

const repoRoot = path.resolve(process.cwd(), "..");
const runnerPath = path.join(process.cwd(), "server", "run_analysis.py");
const pythonBin = process.env.EVIDENCELOOM_PYTHON
  ?? process.env.TRADINGAGENTS_PYTHON
  ?? process.env.PYTHON
  ?? path.join(repoRoot, ".venv", "bin", "python");

export async function POST(request: NextRequest) {
  let payload: TestLlmPayload;
  try {
    payload = await request.json() as TestLlmPayload;
  } catch {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  const result = await runLlmTest(payload, request.signal);
  return Response.json(result);
}

function runLlmTest(payload: TestLlmPayload, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve) => {
    const sensitiveValues = collectSensitiveValues(payload);
    const child = spawn(pythonBin, [runnerPath], {
      cwd: repoRoot,
      env: buildRunnerEnv(payload, repoRoot),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      finish({ ok: false, error: "LLM test timed out after 60 seconds." });
      child.kill("SIGTERM");
    }, 60_000);

    const abort = () => {
      finish({ ok: false, error: "LLM test was cancelled." });
      child.kill("SIGTERM");
    };

    function finish(result: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve(result);
    }

    signal.addEventListener("abort", abort, { once: true });
    child.stdin.write(JSON.stringify({ ...stripSensitiveKeys(payload), __command: "test_llm" }));
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({
      ok: false,
      error: redactSensitiveText(error.message, sensitiveValues),
    }));
    child.on("close", (code) => {
      const safeStdout = redactSensitiveText(stdout, sensitiveValues);
      const safeStderr = redactSensitiveText(stderr, sensitiveValues);
      const parsed = parseRunnerJson(safeStdout);
      if (parsed) {
        finish(parsed);
        return;
      }
      finish({
        ok: false,
        error: safeStderr.trim() || `LLM test runner exited with code ${code ?? "unknown"}.`,
      });
    });
  });
}

function parseRunnerJson(stdout: string) {
  for (const line of stdout.trim().split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}
