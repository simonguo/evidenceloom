// Ordinary build:tauri and the normal Tauri hook share the real evidence gate.
// No selector, even an empty one, reaches a compiler or child tool.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const key of ["EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY", "EVIDENCELOOM_DESKTOP_FRONTEND_EVIDENCE_DIR", "NEXT_RSPACK", "NEXT_PRIVATE_LOCAL_WEBPACK"]) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) throw new Error("desktop_proof_invalid");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (fs.realpathSync(root) !== root) throw new Error("desktop_proof_invalid");
const target = path.join(root, "src-tauri", "target");
fs.mkdirSync(target, { recursive: true });
if (!fs.lstatSync(target).isDirectory() || fs.realpathSync(target) !== target) throw new Error("desktop_proof_invalid");
const metadata = path.join(target, `desktop-frontend-build-${randomBytes(16).toString("hex")}`);
fs.mkdirSync(metadata, { mode: 0o700 });
fs.chmodSync(metadata, 0o700);
const python = process.env.PYTHON || "python3";
const result = spawnSync(python, ["-E", "-s", "-B", "-S", path.join(root, "scripts/desktop_frontend_evidence.py"), "--frontend", path.join(root, "frontend"), "--evidence-parent", metadata, "--receipt-output", path.join(metadata, "frontend-receipt.json")], { cwd: root, env: process.env, stdio: "inherit", timeout: 450000 });
if (result.error || result.signal || result.status !== 0) throw new Error("desktop_proof_invalid");
