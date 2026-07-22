import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isTauri = process.env.TAURI === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: isTauri ? "export" : "standalone",
  outputFileTracingRoot: path.join(__dirname, ".."),
  ...(isTauri ? { images: { unoptimized: true } } : {}),
};

export default nextConfig;
