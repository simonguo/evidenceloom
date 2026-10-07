import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const selectorKey = "EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY";
const evidenceKey = "EVIDENCELOOM_DESKTOP_FRONTEND_EVIDENCE_DIR";
const inertSource = "src/features/desktop-verification/disabled.tsx";
const privateEntry = "src/features/desktop-acceptance/entry.tsx";
const privateFamily = "src/features/desktop-acceptance/";
const handshakeMarker = "evidenceloom-private-ui-driver-v1";
const privateMarkers = Object.freeze([
  handshakeMarker,
  "__EVIDENCELOOM_ACCEPTANCE_BOOTSTRAP__",
  "plugin:desktop-acceptance|driver_report",
  "plugin:desktop-acceptance|finish_session",
  "driver_report",
  "finish_session",
  "desktop-acceptance-build.json",
  "evidenceloom-desktop-fixture",
]);
const limits = Object.freeze({
  compilers: 16, depth: 32, modules: 50000, privateRows: 256,
  records: 1024 * 1024, files: 10000, sourceBytes: 1024 * 1024,
  fileBytes: 64 * 1024 * 1024, totalBytes: 256 * 1024 * 1024,
  identifierBytes: 65536,
});
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (reason) => { throw new Error(`Desktop frontend evidence: ${reason}`); };

// The shipping builder must call this before starting Next/Node/Tauri tools.
export function assertNormalDesktopFrontendSelection(environment) {
  if (!environment || hasOwn(environment, selectorKey)) fail("shipping selector must be absent");
}

export function selectDesktopFrontendEntry(environment) {
  if (!environment) fail("missing environment");
  if (!hasOwn(environment, selectorKey)) return "normal";
  if (environment[selectorKey] !== "acceptance" || environment.TAURI !== "1") {
    fail("invalid private selector or non-Tauri selection");
  }
  return "acceptance";
}

const selection = selectDesktopFrontendEntry(process.env);
rejectAlternateBackend(process.env);
const isTauri = process.env.TAURI === "1";
const selectedSource = selection === "acceptance" ? privateEntry : inertSource;
const selectedAbsoluteEntry = path.resolve(__dirname, selectedSource);
const registry = [];
const sourceDigests = new Map();
const runId = randomBytes(16).toString("hex");
let metadataDirectory;
let metadataInitialized = false;

function rejectAlternateBackend(environment) {
  if (hasOwn(environment, "NEXT_RSPACK") || hasOwn(environment, "NEXT_PRIVATE_LOCAL_WEBPACK")) {
    fail("alternate webpack backend override must be absent");
  }
}

function boundedString(value, maximum, label, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== "string" || Buffer.byteLength(value) > maximum) fail(`invalid ${label}`);
  return value;
}

function sourceDigest(relativeSource) {
  const absolute = path.resolve(__dirname, relativeSource);
  if (!absolute.startsWith(`${__dirname}${path.sep}`)) fail("source escaped frontend root");
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || fs.realpathSync(absolute) !== absolute || stat.size > limits.sourceBytes) {
    fail("source must be a bounded regular owned-tree file");
  }
  const digest = sha256(readBoundedFile(absolute, limits.sourceBytes));
  if (sourceDigests.has(relativeSource) && sourceDigests.get(relativeSource) !== digest) fail("source changed during compiler run");
  sourceDigests.set(relativeSource, digest);
  return { sourcePath: relativeSource, sourceSha256: digest };
}

function readBoundedFile(absolute, maximum, expectedBytes = null) {
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || fs.realpathSync(absolute) !== absolute || before.size > maximum ||
      (expectedBytes != null && before.size !== expectedBytes)) fail("invalid bounded file identity");
  const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail("file identity changed before read");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) fail("file shortened during bounded read");
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    const final = fs.lstatSync(absolute);
    if (fs.readSync(descriptor, Buffer.alloc(1), 0, 1, offset) || opened.size !== after.size ||
        opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
        final.dev !== opened.dev || final.ino !== opened.ino || fs.realpathSync(absolute) !== absolute) fail("file changed during bounded read");
    return bytes;
  } finally { fs.closeSync(descriptor); }
}

function initializeMetadata(required) {
  if (metadataInitialized) {
    if (required && !metadataDirectory) fail("production Tauri build requires metadata directory");
    return;
  }
  metadataInitialized = true;
  if (!hasOwn(process.env, evidenceKey)) {
    if (required) fail("production Tauri build requires metadata directory");
    return;
  }
  const candidate = boundedString(process.env[evidenceKey], 4096, "metadata directory");
  if (!path.isAbsolute(candidate) || path.resolve(candidate) !== candidate) fail("metadata directory must be canonical absolute path");
  const stat = fs.lstatSync(candidate);
  if (!stat.isDirectory() || fs.realpathSync(candidate) !== candidate ||
      candidate === __dirname || candidate.startsWith(`${__dirname}${path.sep}`) ||
      (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
      fs.readdirSync(candidate).length !== 0) {
    fail("metadata directory must be fresh, private, external, and builder-owned");
  }
  // These checks do not establish builder provenance, immutability, or a sealed export.
  metadataDirectory = candidate;
}

function saveRegistry() {
  const document = {
    schema: "evidenceloom-desktop-frontend-compiler-evidence-v1", runId,
    registryClosed: false,
    compilerOwner: { pid: process.pid, nodeVersion: process.version,
      nextVersion: JSON.parse(readBoundedFile(path.join(__dirname, "node_modules/next/package.json"), limits.sourceBytes)).version,
      backend: "webpack", buildWorker: false },
    proofBoundary: "compilation-only; external builder must close registry and bind sealed export inventory",
    persistedEvidence: Boolean(metadataDirectory), records: registry,
  };
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`);
  if (bytes.length > limits.records) fail("compiler records exceeded 1 MiB");
  if (!metadataDirectory) return;
  const stat = fs.lstatSync(metadataDirectory);
  if (!stat.isDirectory() || fs.realpathSync(metadataDirectory) !== metadataDirectory ||
      (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    fail("metadata ownership changed");
  }
  const temporary = path.join(metadataDirectory, `.compiler-records-${runId}.tmp`);
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, path.join(metadataDirectory, "compiler-records.json"));
}

function knownSources(value) {
  if (value == null) return [];
  const raw = boundedString(value, limits.identifierBytes, "module identifier");
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  const found = new Set();
  const normalized = decoded.replaceAll("\\", "/");
  const root = __dirname.replaceAll("\\", "/");
  for (const family of [privateFamily, inertSource]) {
    const needle = `${root}/${family}`;
    let offset = normalized.indexOf(needle);
    while (offset !== -1) {
      if (offset && !/[\s"'!|?=&,:;]/.test(normalized[offset - 1])) fail("known source path has unowned prefix");
      const tail = normalized.slice(offset + root.length + 1);
      const relative = family === inertSource ? inertSource : tail.match(/^src\/features\/desktop-acceptance\/[A-Za-z0-9_./-]+/)?.[0];
      if (!relative || relative.includes("/../") || relative.endsWith("/")) fail("unreadable known source reference");
      found.add(relative);
      offset = normalized.indexOf(needle, offset + needle.length);
    }
  }
  const unowned = normalized.replaceAll(`${root}/${privateFamily}`, "@owned-private/")
    .replaceAll(`${root}/${inertSource}`, "@owned-inert");
  if (unowned.includes(privateFamily) || unowned.includes(inertSource)) fail("known source reference outside owned frontend root");
  return [...found];
}

function physicalKnownSource(value) {
  if (value == null) return null;
  const normalized = boundedString(value, limits.identifierBytes, "physical resource")
    .split("!").at(-1).split(/[?#]/, 1)[0].replaceAll("\\", "/");
  if (!path.isAbsolute(normalized) || path.resolve(normalized) !== normalized) return null;
  const relative = path.relative(__dirname, normalized).replaceAll("\\", "/");
  return relative === inertSource || relative.startsWith(privateFamily) ? relative : null;
}

function collectModules(modules, phase, record) {
  if (!modules || typeof modules[Symbol.iterator] !== "function") fail("missing public module iterable");
  const visited = new Set();
  const rows = [];
  let traversedEdges = 0;
  function visit(module, depth, parentOrdinal, relation) {
    if (++traversedEdges > limits.modules * 3) fail("module edge traversal bound exceeded");
    if (!module || (typeof module !== "object" && typeof module !== "function")) fail("invalid module record");
    if (visited.has(module)) return;
    if (depth > limits.depth || visited.size >= limits.modules) fail("module traversal bound exceeded");
    visited.add(module);
    const ordinal = visited.size;
    const identifier = typeof module.identifier === "function" ? module.identifier() : null;
    const condition = typeof module.nameForCondition === "function" ? module.nameForCondition() : null;
    const sources = new Set([
      ...knownSources(module.resource), ...knownSources(condition), ...knownSources(identifier),
    ]);
    const physicalSources = new Set([physicalKnownSource(module.resource), physicalKnownSource(condition)]);
    for (const relativeSource of sources) {
      if (rows.length + record.moduleRows.length >= limits.privateRows) fail("known-source row bound exceeded");
      const digest = sourceDigest(relativeSource);
      rows.push({ phase, ordinal, parentOrdinal, relation, depth,
        kind: physicalSources.has(relativeSource) ? "physical-source" : "identifier-reference", ...digest,
        identitySha256: identifier == null ? null : sha256(identifier) });
      if (selection === "normal" && relativeSource.startsWith(privateFamily)) fail("private module in normal compiler");
      if (selection === "acceptance" && relativeSource === inertSource) fail("inert module in private compiler");
    }
    // Public ConcatenatedModule members; identity visitation prevents root duplication.
    if (module.modules != null) {
      if (typeof module.modules[Symbol.iterator] !== "function") fail("invalid nested module iterable");
      for (const child of module.modules) visit(child, depth + 1, ordinal, "modules");
    }
    if (module.rootModule != null) visit(module.rootModule, depth + 1, ordinal, "rootModule");
  }
  for (const module of modules) visit(module, 0, null, "compilation.modules");
  record.moduleRows.push(...rows);
  record.phases.push({ phase, visitedModules: visited.size, traversedEdges, knownSourceRows: rows.length });
}

function relativeName(value) {
  boundedString(value, 4096, "asset name");
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) ||
      value.split("/").some((part) => !part || part === "." || part === "..")) fail("unsafe relative asset path");
  return value;
}

function scanBytes(name, bytes, totals) {
  relativeName(name);
  const extension = path.posix.extname(name).toLowerCase();
  const allowed = new Set([".js", ".mjs", ".cjs", ".html", ".css", ".json", ".map", ".txt", ".xml", ".svg", ".ico",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".wav", ".gz", ".br"]);
  if (!allowed.has(extension)) fail("unsupported exported asset format");
  if (!Buffer.isBuffer(bytes) || bytes.length > limits.fileBytes) fail("asset byte bound exceeded");
  totals.files += 1;
  totals.bytes += bytes.length;
  if (totals.files > limits.files || totals.bytes > limits.totalBytes) fail("asset inventory bound exceeded");
  const hits = new Set(privateMarkers.filter((marker) => name.includes(marker) || bytes.includes(Buffer.from(marker))));
  const row = { relativePath: name, bytes: bytes.length, sha256: sha256(bytes), privateMarkerHits: [] };
  if (extension === ".gz" || extension === ".br") {
    const decodedExtension = path.posix.extname(name.slice(0, -extension.length)).toLowerCase();
    if (!allowed.has(decodedExtension) || [".gz", ".br"].includes(decodedExtension)) fail("unsupported or nested compressed export format");
    const decoded = extension === ".gz" ? gunzipSync(bytes, { maxOutputLength: limits.fileBytes })
      : brotliDecompressSync(bytes, { maxOutputLength: limits.fileBytes });
    rejectOpaqueCompression(decoded);
    totals.decodedBytes += decoded.length;
    if (totals.decodedBytes > limits.totalBytes) fail("decoded asset inventory bound exceeded");
    for (const marker of privateMarkers) if (decoded.includes(Buffer.from(marker))) hits.add(marker);
    row.decodedBytes = decoded.length;
    row.decodedSha256 = sha256(decoded);
  } else rejectOpaqueCompression(bytes);
  row.privateMarkerHits = [...hits];
  return row;
}

function rejectOpaqueCompression(bytes) {
  const magics = ["1f8b", "504b0304", "504b0506", "504b0708", "425a68", "fd377a585a00", "28b52ffd", "377abcaf271c", "526172211a07"];
  if (magics.some((magic) => bytes.subarray(0, magic.length / 2).toString("hex") === magic)) fail("opaque or nested compression requires external review");
}

function physicalCompilerPath(absolute, directory) {
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || fs.realpathSync(current) !== current ||
        (index < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) fail("unsafe physical compiler asset path");
  }
}

function compilerAssetBoundary(outputDirectory) {
  boundedString(outputDirectory, 4096, "compiler output directory");
  const buildRoot = path.join(__dirname, ".next");
  if (!path.isAbsolute(outputDirectory) || path.resolve(outputDirectory) !== outputDirectory ||
      (outputDirectory !== buildRoot && !outputDirectory.startsWith(`${buildRoot}${path.sep}`))) fail("compiler output escaped Next build root");
  physicalCompilerPath(__dirname, true);
  physicalCompilerPath(buildRoot, true);
  physicalCompilerPath(outputDirectory, true);
  return { buildRoot, outputDirectory };
}

function compilerAssetIdentity(outputDirectory, rawAssetName) {
  const { buildRoot } = compilerAssetBoundary(outputDirectory);
  boundedString(rawAssetName, 4096, "compiler asset name");
  if (!rawAssetName || rawAssetName.includes("\\") || rawAssetName.includes("\0") ||
      path.posix.isAbsolute(rawAssetName) || path.win32.isAbsolute(rawAssetName) ||
      /^[a-zA-Z]:/.test(rawAssetName)) fail("unsafe compiler asset name");
  // Webpack 5 emitAssets removes the query from its write target, while the
  // assetEmitted hook and emittedAssets set retain the original logical name.
  const logicalName = rawAssetName.split("?", 1)[0];
  if (!logicalName) fail("unsafe compiler asset name");
  const targetPath = path.resolve(outputDirectory, ...logicalName.split("/"));
  const canonicalName = relativeName(path.relative(buildRoot, targetPath).split(path.sep).join("/"));
  physicalCompilerPath(targetPath, false);
  return { rawAssetName, relativePath: canonicalName, targetPath };
}

// NextTypesPlugin emits plain type guards under canonical .next/types only.
// This policy is compiler-only; the shared final-export scanner stays strict.
function scanCompilerTypeAsset(name, bytes, totals) {
  relativeName(name);
  if (!name.startsWith("types/") || path.posix.extname(name) !== ".ts") fail("unsupported compiler type asset");
  if (!Buffer.isBuffer(bytes) || bytes.length > limits.fileBytes) fail("asset byte bound exceeded");
  totals.files += 1;
  totals.bytes += bytes.length;
  if (totals.files > limits.files || totals.bytes > limits.totalBytes) fail("asset inventory bound exceeded");
  rejectOpaqueCompression(bytes);
  if (bytes.includes(0)) fail("compiler type asset must be plain UTF-8 without NUL");
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("compiler type asset must be plain UTF-8 without NUL"); }
  return {
    relativePath: name, bytes: bytes.length, sha256: sha256(bytes),
    privateMarkerHits: privateMarkers.filter((marker) => name.includes(marker) || bytes.includes(Buffer.from(marker))),
  };
}

function scanCompilerAsset(identity, bytes, totals) {
  const row = identity.relativePath.startsWith("types/") && path.posix.extname(identity.relativePath) === ".ts"
    ? scanCompilerTypeAsset(identity.relativePath, bytes, totals)
    : scanBytes(identity.relativePath, bytes, totals);
  // Keep raw logical names visible: normalization must not erase a private hit.
  row.rawAssetName = identity.rawAssetName;
  for (const marker of privateMarkers) {
    if (identity.rawAssetName.includes(marker) && !row.privateMarkerHits.includes(marker)) row.privateMarkerHits.push(marker);
  }
  return row;
}

function scanCompilationAssets(compilation, outputDirectory, record) {
  if (typeof compilation.getAssets !== "function") fail("missing public compilation asset inventory");
  const totals = { files: 0, bytes: 0, decodedBytes: 0 };
  const rows = [];
  const names = new Set();
  const canonicalNames = new Set();
  for (const asset of compilation.getAssets()) {
    const identity = compilerAssetIdentity(outputDirectory, asset.name);
    // Match Webpack emitAssets/checkSimilarFile, which folds targetPath casing.
    const canonicalKey = identity.relativePath.toLowerCase();
    if (names.has(asset.name) || canonicalNames.has(canonicalKey)) fail("duplicate or aliased compilation asset");
    names.add(asset.name);
    canonicalNames.add(canonicalKey);
    if (!asset.source || typeof asset.source.source !== "function" || typeof asset.source.size !== "function" ||
        asset.source.size() > limits.fileBytes) fail("unsupported or oversized compilation source");
    const source = asset.source.source();
    if (typeof source !== "string" && !Buffer.isBuffer(source) && !(source instanceof Uint8Array)) fail("unsupported compilation source bytes");
    const bytes = Buffer.from(source);
    try { rows.push(scanCompilerAsset(identity, bytes, totals)); }
    catch (error) {
      // Diagnose only bytes already obtained from this original compilation.
      // Keep the first failure and the original thrown error; never store content.
      record.status = "failed";
      try {
        if (!record.assetScanFailure) {
          record.assetScanFailure = {
            phase: "afterProcessAssets", rawAssetName: identity.rawAssetName,
            relativePath: identity.relativePath,
            extension: path.posix.extname(identity.relativePath).toLowerCase(),
            bytes: bytes.length, sha256: sha256(bytes),
          };
        }
        saveRegistry();
      }
      catch { /* Preserve the original scanner error if evidence persistence also fails. */ }
      throw error;
    }
  }
  if (selection === "normal" && rows.some((row) => row.privateMarkerHits.length)) fail("private marker in normal compilation assets");
  return { boundary: "compiler-output-bound canonical Next build paths and afterProcessAssets bytes; not final frontend/out export", totals, rows };
}

class DesktopFrontendEvidencePlugin {
  constructor(record, webpack, context) { this.record = record; this.webpack = webpack; this.context = context; }
  apply(compiler) {
    const { record, webpack, context } = this;
    let currentCompilation;
    if (record.compilerApplied || typeof webpack.Compiler !== "function" || !(compiler instanceof webpack.Compiler) ||
        !compiler.webpack || compiler.webpack.version !== webpack.version ||
        compiler.webpack.NormalModuleReplacementPlugin !== webpack.NormalModuleReplacementPlugin) {
      fail("unexpected actual compiler backend or duplicate plugin application");
    }
    record.compilerApplied = true;
    record.compilerName = boundedString(compiler.name ?? compiler.options.name, 128, "compiler name", true);
    record.webpackMode = boundedString(compiler.options.mode, 32, "webpack mode");
    const { buildRoot, outputDirectory } = compilerAssetBoundary(compiler.options.output?.path);
    record.compilerBuildRoot = buildRoot;
    record.compilerOutputDirectory = outputDirectory;
    record.status = "registered";
    compiler.hooks.normalModuleFactory.tap("DesktopFrontendEvidence", (factory) => {
      factory.hooks.afterResolve.tap("DesktopFrontendEvidence", (resolved) => {
        const resource = resolved?.createData?.resource;
        for (const relativeSource of knownSources(resource)) {
          if (selection === "normal" && relativeSource.startsWith(privateFamily)) fail("private resolution in normal compiler");
        }
        if (physicalKnownSource(resource) === selectedSource) {
          if (record.resolutions.length >= limits.privateRows) fail("resolution row bound exceeded");
          record.resolutions.push({ ...sourceDigest(selectedSource), resourceSha256: sha256(resource) });
        }
        // Webpack afterResolve is a bail hook: do not return the resolve object.
      });
    });
    compiler.hooks.thisCompilation.tap("DesktopFrontendEvidence", (compilation) => {
      if (!(compilation instanceof webpack.Compilation)) fail("unexpected actual compilation backend");
      currentCompilation = compilation;
      record.iteration += 1;
      record.replacements = [];
      record.resolutions = [];
      record.phases = [];
      record.moduleRows = [];
      record.assets = null;
      record.emittedAssets = { totals: { files: 0, bytes: 0, decodedBytes: 0 }, rows: [] };
      record.status = "compiling";
      compilation.hooks.finishModules.tap("DesktopFrontendEvidence", (modules) => collectModules(modules, "finishModules", record));
      compilation.hooks.afterProcessAssets.tap("DesktopFrontendEvidence", () => {
        if (compiler.options.output.path !== outputDirectory) fail("compiler output directory changed");
        record.assets = scanCompilationAssets(compilation, outputDirectory, record);
      });
    });
    compiler.hooks.assetEmitted.tap("DesktopFrontendEvidence", (name, information) => {
      if (!information || information.compilation !== currentCompilation ||
          !Buffer.isBuffer(information.content) || !record.assets) fail("missing emitted-asset byte record");
      if (compiler.options.output.path !== outputDirectory || information.outputPath !== outputDirectory) fail("emitted compiler output directory changed");
      const identity = compilerAssetIdentity(outputDirectory, name);
      if (boundedString(information.targetPath, 8192, "emitted asset target") !== identity.targetPath) fail("emitted asset target differs from bound compiler name");
      const row = scanCompilerAsset(identity, information.content, record.emittedAssets.totals);
      const expected = record.assets.rows.find((asset) => asset.rawAssetName === name);
      if (!expected || expected.relativePath !== row.relativePath || expected.bytes !== row.bytes || expected.sha256 !== row.sha256 ||
          record.emittedAssets.rows.some((asset) => asset.relativePath === row.relativePath)) fail("emitted asset differs from scanned compilation");
      const written = readBoundedFile(identity.targetPath, limits.fileBytes, row.bytes);
      if (sha256(written) !== row.sha256) fail("original emitted file differs from callback bytes");
      if (selection === "normal" && row.privateMarkerHits.length) fail("private marker in normal emitted asset");
      record.emittedAssets.rows.push(row);
    });
    compiler.hooks.done.tap("DesktopFrontendEvidence", (stats) => {
      if (stats.compilation !== currentCompilation || stats.hasErrors() || record.phases.length !== 1 ||
          record.phases[0].phase !== "finishModules") fail("failed compiler or missing pre-optimization record");
      collectModules(stats.compilation.modules, "done", record);
      for (const source of ["next.config.mjs", "tsconfig.json", selectedSource]) sourceDigest(source);
      record.compilationHash = boundedString(stats.hash, 128, "compilation hash", context.dev);
      if (!context.dev && !record.compilationHash) fail("missing production compilation hash");
      if (compiler.options.output.path !== outputDirectory) fail("compiler output directory changed");
      if (!record.assets || !stats.compilation.emittedAssets ||
          JSON.stringify([...stats.compilation.emittedAssets].sort()) !== JSON.stringify(record.emittedAssets.rows.map((row) => row.rawAssetName).sort())) fail("missing emitted asset inventory record");
      const finalAssets = stats.compilation.getAssets();
      if (finalAssets.length !== record.assets.rows.length || finalAssets.some((asset) => {
        const expected = record.assets.rows.find((row) => row.rawAssetName === asset.name);
        const identity = compilerAssetIdentity(outputDirectory, asset.name);
        return !expected || identity.relativePath !== expected.relativePath || asset.source.size() !== expected.bytes;
      })) fail("final compilation asset inventory changed");
      if (record.replacements.length && !record.resolutions.length) fail("replacement missing physical selected-source resolution");
      if (!context.isServer && !context.dev) {
        if (!record.resolutions.length || !record.moduleRows.some((row) => row.kind === "physical-source" && row.sourcePath === selectedSource)) fail("client missing selected entry");
        if (selection === "acceptance") {
          for (const required of [privateEntry, `${privateFamily}lib/api.ts`, `${privateFamily}lib/driver.ts`]) {
            if (!record.moduleRows.some((row) => row.kind === "physical-source" && row.sourcePath === required)) fail("private client missing required implementation");
          }
          if (!record.assets.rows.some((row) => row.privateMarkerHits.includes(handshakeMarker))) fail("private client missing consumed handshake marker");
        }
      }
      record.status = context.dev ? "development-observed" : "complete";
      saveRegistry();
    });
    compiler.hooks.failed.tap("DesktopFrontendEvidence", () => { record.status = "failed"; saveRegistry(); });
    saveRegistry();
  }
}

function exportedFiles(directory) {
  const files = [];
  let entries = 0;
  function walk(relative, depth) {
    if (depth > limits.depth) fail("export directory depth bound exceeded");
    for (const name of fs.readdirSync(path.join(directory, relative)).sort()) {
      if (++entries > limits.modules) fail("export filesystem entry bound exceeded");
      const next = relativeName(relative ? `${relative}/${name}` : name);
      const absolute = path.join(directory, next);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail("symlink in export inventory");
      if (stat.isDirectory()) walk(next, depth + 1);
      else if (stat.isFile()) {
        if (files.length >= limits.files || stat.size > limits.fileBytes) fail("export file bound exceeded");
        files.push(next);
      } else fail("unsupported export filesystem object");
    }
  }
  walk("", 0);
  return files.sort();
}

// A separate post-export gate. The caller must freeze this exact output and bind
// its inventory digest to the successful, closed compiler registry and builder run.
export function scanDesktopFrontendExportInventory({ outputDirectory, inventory, expectedInventorySha256, expectedSelection = "normal" }) {
  if (!["normal", "acceptance"].includes(expectedSelection) || expectedSelection !== selection) fail("export selection mismatch");
  boundedString(outputDirectory, 4096, "export directory");
  if (!path.isAbsolute(outputDirectory) || path.resolve(outputDirectory) !== outputDirectory ||
      fs.realpathSync(outputDirectory) !== outputDirectory || !fs.lstatSync(outputDirectory).isDirectory()) fail("export root must be canonical regular directory");
  if (!Array.isArray(inventory) || !inventory.length || inventory.length > limits.files ||
      typeof expectedInventorySha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedInventorySha256)) fail("invalid bound export inventory");
  const canonical = inventory.map((item) => {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "bytes,relativePath,sha256" ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > limits.fileBytes ||
        typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) fail("invalid export inventory row");
    return { relativePath: relativeName(item.relativePath), bytes: item.bytes, sha256: item.sha256 };
  }).sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  const inventoryBytes = Buffer.from(JSON.stringify(canonical));
  if (inventoryBytes.length > limits.records || sha256(inventoryBytes) !== expectedInventorySha256) fail("export inventory digest mismatch");
  const expectedNames = canonical.map((item) => item.relativePath);
  if (new Set(expectedNames).size !== expectedNames.length || JSON.stringify(exportedFiles(outputDirectory)) !== JSON.stringify(expectedNames)) fail("export inventory does not cover exact output files");
  const totals = { files: 0, bytes: 0, decodedBytes: 0 };
  const rows = canonical.map((item) => {
    const absolute = path.join(outputDirectory, item.relativePath);
    const bytes = readBoundedFile(absolute, limits.fileBytes, item.bytes);
    if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) fail("export inventory file digest mismatch");
    const row = scanBytes(item.relativePath, bytes, totals);
    if (expectedSelection === "normal" && row.privateMarkerHits.length) fail("private marker in bound normal export");
    return row;
  });
  if (JSON.stringify(exportedFiles(outputDirectory)) !== JSON.stringify(expectedNames)) fail("export file inventory changed during scan");
  const result = {
    schema: "evidenceloom-desktop-frontend-export-scan-v1", selection: expectedSelection, inventorySha256: expectedInventorySha256,
    proofBoundary: "inventory-bound bytes; external builder sealing and compiler-registry closure required",
    totals, rows,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > limits.records) fail("export scan records exceeded 1 MiB");
  return result;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: isTauri ? "export" : "standalone",
  // The external collector retains one direct Next CLI process and its whole registry.
  // Next 15.5.27 already defaults this off when webpack is customized; pin it.
  experimental: { webpackBuildWorker: false, parallelServerCompiles: false, parallelServerBuildTraces: false },
  outputFileTracingRoot: path.join(__dirname, ".."),
  ...(isTauri ? { images: { unoptimized: true } } : {}),
  webpack(config, context) {
    rejectAlternateBackend(process.env);
    if (!context || typeof context.dev !== "boolean" || typeof context.isServer !== "boolean" ||
        !context.webpack || !/^5\./.test(context.webpack.version) ||
        typeof context.webpack.NormalModuleReplacementPlugin !== "function" ||
        ![undefined, "nodejs", "edge"].includes(context.nextRuntime)) fail("unexpected webpack callback context");
    initializeMetadata(!context.dev && isTauri);
    if (registry.length >= limits.compilers) fail("compiler callback bound exceeded");
    const record = {
      callbackOrdinal: registry.length + 1, selection, dev: context.dev, isServer: context.isServer,
      nextRuntime: context.nextRuntime ?? null, webpackVersion: context.webpack.version,
      buildId: boundedString(context.buildId, 256, "build ID", context.dev),
      configSource: sourceDigest("next.config.mjs"), tsconfigSource: sourceDigest("tsconfig.json"),
      selectedSource: sourceDigest(selectedSource), compilerApplied: false, status: "callback-created",
      iteration: 0, replacements: [], resolutions: [], phases: [], moduleRows: [], assets: null, emittedAssets: null,
    };
    if (!context.dev && !record.buildId) fail("missing production build ID");
    registry.push(record);
    const replacement = new context.webpack.NormalModuleReplacementPlugin(/^@desktop-verification-entry$/, (request) => {
      if (request.request !== "@desktop-verification-entry") fail("unexpected replacement phase");
      if (record.replacements.length >= limits.privateRows) fail("replacement row bound exceeded");
      record.replacements.push({ originalSpecifier: request.request, ...sourceDigest(selectedSource) });
      // This public beforeResolve replacement runs before TS path resolution.
      request.request = selectedAbsoluteEntry;
    });
    config.plugins ??= [];
    config.plugins.unshift(replacement, new DesktopFrontendEvidencePlugin(record, context.webpack, context));
    saveRegistry();
    return config;
  },
};

export default nextConfig;
