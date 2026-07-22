import { spawn } from "node:child_process";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  buildRunnerEnv,
  collectSensitiveValues,
  createRedactedLineBuffer,
  redactSensitiveText,
  stripSensitiveKeys,
} from "../_lib/runner-env";

export const runtime = "nodejs";
type AnalyzePayload = {
  ticker?: string;
  analysisDate?: string;
  assetType?: "stock" | "crypto";
  analysts?: string[];
  researchDepth?: number;
  llmProvider?: string;
  backendUrl?: string;
  quickThinkLlm?: string;
  deepThinkLlm?: string;
  outputLanguage?: string;
  apiKey?: string;
  alphaVantageApiKey?: string;
  checkpointEnabled?: boolean;
};

const repoRoot = path.resolve(process.cwd(), "..");
const runnerPath = path.join(process.cwd(), "server", "run_analysis.py");
const pythonBin = process.env.EVIDENCELOOM_PYTHON
  ?? process.env.TRADINGAGENTS_PYTHON
  ?? process.env.PYTHON
  ?? path.join(repoRoot, ".venv", "bin", "python");

export async function POST(request: NextRequest) {
  const payload = (await request.json()) as AnalyzePayload;
  const errors = validatePayload(payload);

  if (errors.length > 0) {
    return new Response(errors.join("\n"), { status: 400 });
  }

  const encoder = new TextEncoder();
  const sensitiveValues = collectSensitiveValues(payload);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let streamClosed = false;
      const closeStream = () => {
        if (!streamClosed) {
          streamClosed = true;
          controller.close();
        }
      };
      const childEnv = buildRunnerEnv(payload, repoRoot);
      const child = spawn(pythonBin, [runnerPath], {
        cwd: repoRoot,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.stdin.write(JSON.stringify(sanitizePayloadForPython(payload)));
      child.stdin.end();

      const stdout = createRedactedLineBuffer(sensitiveValues, (line) => {
        controller.enqueue(encoder.encode(`${line}\n`));
      });
      const stderr = createRedactedLineBuffer(sensitiveValues, (message) => {
        if (message) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: "message", messageType: "stderr", message })}\n`));
        }
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout.push(chunk.toString("utf8"));
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr.push(chunk.toString("utf8"));
      });

      child.on("error", (error) => {
        if (streamClosed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: "error",
          error: redactSensitiveText(error.message, sensitiveValues),
        })}\n`));
        closeStream();
      });

      child.on("close", (code) => {
        if (streamClosed) return;
        stdout.flush();
        stderr.flush();
        if (code && code !== 0) {
          controller.enqueue(encoder.encode(JSON.stringify({ type: "error", error: `Python runner exited with code ${code}` }) + "\n"));
        }
        closeStream();
      });

      request.signal.addEventListener("abort", () => {
        child.kill("SIGTERM");
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function validatePayload(payload: AnalyzePayload) {
  const errors: string[] = [];
  if (!payload.ticker?.trim()) errors.push("ticker is required");
  if (!payload.analysisDate || !/^\d{4}-\d{2}-\d{2}$/.test(payload.analysisDate)) errors.push("analysisDate must be YYYY-MM-DD");
  if (!payload.analysts?.length) errors.push("at least one analyst is required");
  if (payload.assetType && !["stock", "crypto"].includes(payload.assetType)) errors.push("assetType must be stock or crypto");
  return errors;
}

function sanitizePayloadForPython(payload: AnalyzePayload): AnalyzePayload {
  return stripSensitiveKeys(payload) as AnalyzePayload;
}
