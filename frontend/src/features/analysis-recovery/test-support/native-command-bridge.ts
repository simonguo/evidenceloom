import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { RecoveryApi } from "../types";

/** Routes JSONL to the compiled production-module fixture; it implements no native gates. */
export async function nativeCommandBridge(executable: string, artifactDirectory?: string, compilerDirectory?: string) {
  if (!compilerDirectory) throw new Error("The owned native fixture requires an explicit existing compiler directory.");
  const owned = await mkdtemp(join(tmpdir(), "evidenceloom-owned-recovery-"));
  const fixtureRoot = join(owned, "fixture-root");
  // Compiler/linker locations are the only inherited build environment. Credentials and application configuration are excluded.
  const compilerEnvironment = Object.fromEntries(["SystemRoot", "WINDIR", "INCLUDE", "LIB", "LIBPATH", "PATHEXT"].flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const child = spawn(executable, ["--exact", "analysis_recovery::runtime::tests::analysis_recovery_command_bridge", "--ignored", "--nocapture"], { env: { ...compilerEnvironment, NODE_ENV: "test", PATH: `${compilerDirectory}${delimiter}${process.env.PATH ?? ""}`, HOME: owned, USERPROFILE: owned, TMPDIR: owned, TEMP: owned, TMP: owned, EVIDENCELOOM_RECOVERY_FIXTURE_ROOT: fixtureRoot }, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>(), listeners = new Map<string, (event: { payload: unknown }) => void>();
  const raw: string[] = [], requests: string[] = [], replies: { id: string; ok?: unknown; error?: unknown }[] = []; let sequence = 0;
  child.stderr.on("data", (buffer: Buffer) => raw.push(buffer.toString("utf8")));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    raw.push(`${line}\n`);
    if (line.startsWith("RECOVERY_REPLY ")) {
      const reply = JSON.parse(line.slice("RECOVERY_REPLY ".length)) as { id: string; ok?: unknown; error?: unknown };
      replies.push(reply);
      const waiting = pending.get(reply.id); if (!waiting) return; pending.delete(reply.id);
      if (Object.hasOwn(reply, "error")) waiting.reject(reply.error); else waiting.resolve(reply.ok);
    } else if (line.startsWith("RECOVERY_WAKE ")) {
      const wake = JSON.parse(line.slice("RECOVERY_WAKE ".length)) as { origin: { runtimeEpoch: string; runId: string } };
      listeners.get(`analysis-journal:${wake.origin.runtimeEpoch}:${wake.origin.runId}`)?.({ payload: wake });
    }
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => { pending.forEach((waiting) => waiting.reject(error)); pending.clear(); });
    child.once("close", (code) => { pending.forEach((waiting) => waiting.reject(new Error("Owned native fixture closed before acknowledgement"))); pending.clear(); resolve(code); });
  });
  const invoke = (command: string, args: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
    const id = `owned-bridge-${++sequence}`, line = JSON.stringify({ id, command, args }); requests.push(line); pending.set(id, { resolve, reject }); child.stdin.write(`${line}\n`);
  });
  const api: RecoveryApi = { invoke, listen: async (channel, handler) => { listeners.set(channel, handler); return () => { if (listeners.get(channel) === handler) listeners.delete(channel); }; } };
  return { api, invoke, requests, replies, raw, async close() {
    child.stdin.end(); const code = await closed; lines.close();
    if (artifactDirectory) { await writeFile(join(artifactDirectory, "native-bridge-stdout-stderr.log"), raw.join("")); await writeFile(join(artifactDirectory, "native-bridge-requests.jsonl"), `${requests.join("\n")}\n`); await writeFile(join(artifactDirectory, "native-bridge-result.json"), `${JSON.stringify({ exit_code: code, requests: requests.length, scope: "Compiled production-module fictional worker and actual SQLite; no native Tauri IPC, Keychain or provider." }, null, 2)}\n`); await cp(fixtureRoot, join(artifactDirectory, "native-fixture-root"), { recursive: true }); }
    await rm(owned, { recursive: true, force: true }); return code;
  } };
}
