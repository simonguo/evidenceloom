// Exported scanner regressions with owned byte fixtures.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";

const configURL = new URL("../../frontend/next.config.mjs", import.meta.url);
const original = { ...process.env };
delete process.env.EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY;
process.env.TAURI = "1";
const normal = await import(`${configURL.href}?normal-source-regression`);
process.env.EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY = "acceptance";
const acceptance = await import(`${configURL.href}?acceptance-source-regression`);
for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
Object.assign(process.env, original);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function request(files, selection = "normal") {
  assert.ok(process.env.TMPDIR, "Tests require TMPDIR for owned fixtures");
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR, "frontend-export-unit-"));
  const inventory = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
    return { relativePath: name, bytes: bytes.length, sha256: hash(bytes) };
  });
  return { directory, value: { outputDirectory: directory, inventory, expectedInventorySha256: hash(Buffer.from(JSON.stringify(inventory))), expectedSelection: selection } };
}

for (const [name, bytes] of [
  ["owned.js", Buffer.from("evidenceloom-private-ui-driver-v1")],
  ["owned.js.gz", gzipSync(Buffer.from("evidenceloom-private-ui-driver-v1"))],
  ["owned.js.br", brotliCompressSync(Buffer.from("evidenceloom-private-ui-driver-v1"))],
]) {
  test(`normal exact export rejects private raw/decoded marker in ${name}`, () => {
    const fixture = request({ [name]: bytes });
    try { assert.throws(() => normal.scanDesktopFrontendExportInventory(fixture.value), /private marker/); }
    finally { fs.rmSync(fixture.directory, { recursive: true }); }
  });
}

test("normal omission and private handshake are selection bound", () => {
  const inert = request({ "owned.js": Buffer.from("inert ordinary export") });
  const privateOutput = request({ "owned.js.br": brotliCompressSync(Buffer.from("evidenceloom-private-ui-driver-v1")) }, "acceptance");
  try {
    const normalResult = normal.scanDesktopFrontendExportInventory(inert.value);
    assert.equal(normalResult.selection, "normal");
    assert.equal(normalResult.rows[0].privateMarkerHits.length, 0);
    const result = acceptance.scanDesktopFrontendExportInventory(privateOutput.value);
    assert.ok(result.rows[0].privateMarkerHits.includes("evidenceloom-private-ui-driver-v1"));
    assert.throws(() => normal.scanDesktopFrontendExportInventory(privateOutput.value), /selection mismatch/);
  } finally {
    fs.rmSync(inert.directory, { recursive: true });
    fs.rmSync(privateOutput.directory, { recursive: true });
  }
});

test("unlisted output and changed exact bytes cannot satisfy the scan", () => {
  const fixture = request({ "owned.js": Buffer.from("inert ordinary export") });
  try {
    fs.writeFileSync(path.join(fixture.directory, "unlisted.css"), "ordinary css", { flag: "wx" });
    assert.throws(() => normal.scanDesktopFrontendExportInventory(fixture.value), /exact output files/);
    fs.unlinkSync(path.join(fixture.directory, "unlisted.css"));
    fs.writeFileSync(path.join(fixture.directory, "owned.js"), randomBytes(fixture.value.inventory[0].bytes));
    assert.throws(() => normal.scanDesktopFrontendExportInventory(fixture.value), /digest mismatch/);
  } finally { fs.rmSync(fixture.directory, { recursive: true }); }
});

// Every fixture path comes from the provided TMPDIR.

test("ordinary Node launcher rejects selector presence before creating metadata or starting Python", async () => {
  const { spawnSync } = await import("node:child_process");
  const wrapper = new URL("../build_desktop_frontend.mjs", import.meta.url);
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR, "normal-frontend-guard-unit-"));
  try {
    fs.mkdirSync(path.join(directory, "scripts"));
    const ownedWrapper = path.join(directory, "scripts/build_desktop_frontend.mjs");
    fs.copyFileSync(wrapper, ownedWrapper);
    for (const [key, value] of [["EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY", ""], ["EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY", "acceptance"], ["EVIDENCELOOM_DESKTOP_FRONTEND_EVIDENCE_DIR", ""], ["NEXT_RSPACK", ""]]) {
      const result = spawnSync(process.execPath, [ownedWrapper], { cwd: directory, env: { PATH: "inert-no-tool-lookup", HOME: directory, TMPDIR: directory, [key]: value }, encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 });
      assert.equal(result.status, 1);
      assert.equal(result.signal, null);
      assert.match(result.stderr, /desktop_proof_invalid/);
      assert.equal(fs.existsSync(path.join(directory, "src-tauri")), false);
    }
  } finally { fs.rmSync(directory, { recursive: true }); }
});


// Plugin callback regressions use inert Compiler/Compilation objects and owned
// byte files without a Next/webpack build.
async function compilerFixture(entries, context = { dev: true, isServer: true, nextRuntime: "nodejs" }) {
  assert.ok(process.env.TMPDIR, "Tests require TMPDIR for owned fixtures");
  assert.equal(Object.hasOwn(process.env, "EVIDENCELOOM_DESKTOP_FRONTEND_EVIDENCE_DIR"), false);
  assert.equal(Object.hasOwn(process.env, "EVIDENCELOOM_DESKTOP_FRONTEND_ENTRY"), false);
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR, "compiler-asset-unit-"));
  const frontend = path.join(directory, "frontend");
  const productionClient = !context.dev && !context.isServer;
  const outputDirectory = path.join(frontend, productionClient ? ".next" : ".next/server/chunks");
  const cleanup = () => fs.rmSync(directory, { recursive: true });
  try {
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.mkdirSync(path.join(frontend, "src/features/desktop-verification"), { recursive: true });
    fs.mkdirSync(path.join(frontend, "node_modules/next"), { recursive: true });
    fs.copyFileSync(configURL, path.join(frontend, "next.config.mjs"));
    fs.copyFileSync(new URL("../../frontend/node_modules/next/package.json", import.meta.url),
      path.join(frontend, "node_modules/next/package.json"));
    fs.writeFileSync(path.join(frontend, "tsconfig.json"), "{}");
    const selectedEntry = path.join(frontend, "src/features/desktop-verification/disabled.tsx");
    if (productionClient) fs.copyFileSync(new URL("../../frontend/src/features/desktop-verification/disabled.tsx", import.meta.url), selectedEntry);
    else fs.writeFileSync(selectedEntry, "export default null;\n");
    const hook = () => ({ callback: null, tap(_name, callback) { this.callback = callback; } });
    class InertCompilation {
      constructor() {
        this.hooks = { finishModules: hook(), afterProcessAssets: hook() };
        this.modules = [];
        this.emittedAssets = new Set();
      }
      getAssets() {
        return entries.map(([name, bytes]) => ({
          name, source: { source: () => bytes, size: () => bytes.length },
        }));
      }
    }
    class InertCompiler {
      constructor(webpack) {
        this.webpack = webpack;
        this.name = "owned-inert-server";
        this.options = { mode: "production", output: { path: outputDirectory } };
        this.hooks = { normalModuleFactory: hook(), thisCompilation: hook(), assetEmitted: hook(), done: hook(), failed: hook() };
      }
    }
    class InertReplacement { constructor() {} }
    const webpack = { version: "5.98.0", Compiler: InertCompiler, Compilation: InertCompilation, NormalModuleReplacementPlugin: InertReplacement };
    const { pathToFileURL } = await import("node:url");
    const previousTauri = process.env.TAURI;
    let config;
    try {
      if (productionClient) {
        const metadataDirectory = path.join(directory, "metadata");
        fs.mkdirSync(metadataDirectory, { mode: 0o700 });
        process.env.TAURI = "1";
        process.env.EVIDENCELOOM_DESKTOP_FRONTEND_EVIDENCE_DIR = metadataDirectory;
      }
      const owned = await import(pathToFileURL(path.join(frontend, "next.config.mjs")).href);
      config = owned.default.webpack({ plugins: [] }, {
        ...context, webpack, buildId: "owned-inert-build",
      });
    } finally {
      if (productionClient) {
        delete process.env.EVIDENCELOOM_DESKTOP_FRONTEND_EVIDENCE_DIR;
        if (previousTauri === undefined) delete process.env.TAURI;
        else process.env.TAURI = previousTauri;
      }
    }
    const plugin = config.plugins.find((candidate) => candidate.record);
    assert.ok(plugin);
    const compiler = new InertCompiler(webpack);
    const compilation = new InertCompilation();
    plugin.apply(compiler);
    compiler.hooks.thisCompilation.callback(compilation);
    if (!productionClient) compilation.hooks.finishModules.callback([]);
    const factory = { hooks: { afterResolve: hook() } };
    compiler.hooks.normalModuleFactory.callback(factory);
    const information = (name, content) => ({
      compilation, content, outputPath: outputDirectory,
      targetPath: path.resolve(outputDirectory, ...name.split("?", 1)[0].split("/")),
    });
    return {
      directory, frontend, outputDirectory, compilation, compiler, record: plugin.record, cleanup,
      selectedEntry,
      resolve: (resource) => factory.hooks.afterResolve.callback({ createData: { resource } }),
      scan: () => compilation.hooks.afterProcessAssets.callback(),
      information,
      emit(name, content, overrides = {}) {
        const value = { ...information(name, content), ...overrides };
        const originalTarget = information(name, content).targetPath;
        fs.mkdirSync(path.dirname(originalTarget), { recursive: true });
        fs.writeFileSync(originalTarget, content);
        compiler.hooks.assetEmitted.callback(name, value);
        compilation.emittedAssets.add(name);
      },
      done: () => compiler.hooks.done.callback({ compilation, hash: "inert-hash", hasErrors: () => false }),
    };
  } catch (error) { cleanup(); throw error; }
}

test("compiler parent assets retain raw names, canonical Next paths and original emitted bytes", async () => {
  const entries = [
    ["../app/page.js", Buffer.from("inert page")],
    ["../server-reference-manifest.json", Buffer.from("{}")],
    ["../query.js?owned-unit", Buffer.from("inert query")],
  ];
  const fixture = await compilerFixture(entries);
  try {
    fixture.scan();
    assert.deepEqual(fixture.record.assets.rows.map((row) => [row.rawAssetName, row.relativePath]), [
      ["../app/page.js", "server/app/page.js"],
      ["../server-reference-manifest.json", "server/server-reference-manifest.json"],
      ["../query.js?owned-unit", "server/query.js"],
    ]);
    for (const [name, content] of entries) fixture.emit(name, content);
    fixture.done();
    assert.equal(fixture.record.status, "development-observed");
    assert.deepEqual([...fixture.compilation.emittedAssets], entries.map(([name]) => name));
    assert.deepEqual(fixture.record.emittedAssets.rows.map((row) => row.sha256),
      entries.map(([, content]) => hash(content)));
  } finally { fixture.cleanup(); }
});

test("compiler names cannot escape Next, alias another asset or traverse a physical symlink", async () => {
  for (const name of ["../../../escape.js", "/absolute.js", "C:/absolute.js", "..\\escape.js"]) {
    const fixture = await compilerFixture([[name, Buffer.from("inert")]]);
    try { assert.throws(() => fixture.scan(), /unsafe (relative asset path|compiler asset name)/); }
    finally { fixture.cleanup(); }
  }
  for (const entries of [
    [["../app/page.js", Buffer.from("inert")], ["inside/../../app/page.js", Buffer.from("inert")]],
    [["../alias.js?one", Buffer.from("inert")], ["../alias.js?two", Buffer.from("inert")]],
    [["../Alias.js", Buffer.from("same bytes")], ["../alias.js", Buffer.from("same bytes")]],
  ]) {
    const aliases = await compilerFixture(entries);
    try { assert.throws(() => aliases.scan(), /duplicate or aliased compilation asset/); }
    finally { aliases.cleanup(); }
  }
  const symlink = await compilerFixture([["../linked/page.js", Buffer.from("inert")]]);
  try {
    const outside = path.join(symlink.directory, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(symlink.frontend, ".next/server/linked"), "dir");
    assert.throws(() => symlink.scan(), /unsafe physical compiler asset path/);
  } finally { symlink.cleanup(); }
  const exported = request({ "owned.js": Buffer.from("inert") });
  try {
    exported.value.inventory[0].relativePath = "../owned.js";
    assert.throws(() => normal.scanDesktopFrontendExportInventory(exported.value), /unsafe relative asset path/);
  } finally { fs.rmSync(exported.directory, { recursive: true }); }
});

test("normal compiler rejects raw-name and raw, gzip or brotli private markers after normalization", async () => {
  for (const [name, content] of [
    ["../evidenceloom-private-ui-driver-v1/../owned.js", Buffer.from("inert")],
    ["../owned.js", Buffer.from("evidenceloom-private-ui-driver-v1")],
    ["../owned.js.gz", gzipSync(Buffer.from("evidenceloom-private-ui-driver-v1"))],
    ["../owned.js.br", brotliCompressSync(Buffer.from("evidenceloom-private-ui-driver-v1"))],
  ]) {
    const fixture = await compilerFixture([[name, content]]);
    try { assert.throws(() => fixture.scan(), /private marker/); }
    finally { fixture.cleanup(); }
  }
});

test("compiler emission binds original name, canonical target, output directory and exact written content", async () => {
  const content = Buffer.from("inert original");
  for (const mutation of ["target", "output", "content", "name"]) {
    const fixture = await compilerFixture([["../owned.js", content]]);
    try {
      fixture.scan();
      const name = mutation === "name" ? "../other.js" : "../owned.js";
      const emitted = mutation === "content" ? Buffer.alloc(content.length, 0x78) : content;
      const overrides = mutation === "target" ? { targetPath: path.join(fixture.directory, "outside.js") }
        : mutation === "output" ? { outputPath: path.join(fixture.frontend, ".next") } : {};
      assert.throws(() => fixture.emit(name, emitted, overrides),
        /emitted asset target differs|emitted compiler output directory changed|emitted asset differs from scanned compilation/);
    } finally { fixture.cleanup(); }
  }
  const fixture = await compilerFixture([["../owned.js", content]]);
  try {
    fixture.scan();
    const information = fixture.information("../owned.js", content);
    fs.writeFileSync(information.targetPath, Buffer.alloc(content.length, 0x78));
    assert.throws(() => fixture.compiler.hooks.assetEmitted.callback("../owned.js", information),
      /original emitted file differs from callback bytes/);
  } finally { fixture.cleanup(); }
  const diagnosticBytes = Buffer.from("owned unsupported asset bytes");
  const diagnosticEntries = [["../diagnostic.unrecognized", diagnosticBytes]];
  const diagnostic = await compilerFixture(diagnosticEntries);
  try {
    let originalFailure;
    try { diagnostic.scan(); } catch (error) { originalFailure = error; }
    assert.ok(originalFailure instanceof Error);
    assert.match(originalFailure.message, /unsupported exported asset format/);
    assert.equal(diagnostic.record.status, "failed");
    assert.equal(diagnostic.record.assets, null);
    assert.equal(diagnostic.record.compilerOutputDirectory, diagnostic.outputDirectory);
    assert.deepEqual(diagnostic.record.assetScanFailure, {
      phase: "afterProcessAssets", rawAssetName: "../diagnostic.unrecognized",
      relativePath: "server/diagnostic.unrecognized", extension: ".unrecognized",
      bytes: diagnosticBytes.length, sha256: hash(diagnosticBytes),
    });
    assert.equal(JSON.stringify(diagnostic.record.assetScanFailure).includes(diagnosticBytes.toString()), false);
    const firstFailure = diagnostic.record.assetScanFailure;
    diagnosticEntries[0] = ["../later.unrecognized", Buffer.from("later inert bytes")];
    assert.throws(() => diagnostic.scan(), /unsupported exported asset format/);
    assert.equal(diagnostic.record.assetScanFailure, firstFailure);
  } finally { diagnostic.cleanup(); }
});

// Compiler-only NextTypesPlugin policy regressions.
test("compiler type guards keep UTF-8 byte totals and exact original emitted files", async () => {
  const entries = [
    ["../../types/app/api/resolve-instrument/route.ts", Buffer.from('export type Name = "研究";\n')],
    ["../../types/server.d.ts", Buffer.from("declare module 'next/server' {}\n")],
    ["../../types/cache-life.d.ts", Buffer.from("export type CacheLife = number;\n")],
  ];
  const fixture = await compilerFixture(entries);
  try {
    fixture.scan();
    assert.deepEqual(fixture.record.assets.rows.map((row) => [row.rawAssetName, row.relativePath, row.bytes, row.sha256]),
      entries.map(([name, bytes]) => [name, name.slice(6), bytes.length, hash(bytes)]));
    assert.deepEqual(fixture.record.assets.totals, {
      files: 3, bytes: entries.reduce((total, [, bytes]) => total + bytes.length, 0), decodedBytes: 0,
    });
    assert.ok(fixture.record.assets.rows.every((row) => row.privateMarkerHits.length === 0));
    for (const [name, bytes] of entries) {
      fixture.emit(name, bytes);
      assert.equal(hash(fs.readFileSync(fixture.information(name, bytes).targetPath)), hash(bytes));
    }
    fixture.done();
    assert.equal(fixture.record.status, "development-observed");
    assert.deepEqual(fixture.record.emittedAssets.rows.map((row) => row.sha256), entries.map(([, bytes]) => hash(bytes)));
  } finally { fixture.cleanup(); }
  const bytes = Buffer.from("export type Original = number;\n");
  const mismatch = await compilerFixture([["../../types/original.d.ts", bytes]]);
  try {
    mismatch.scan();
    const information = mismatch.information("../../types/original.d.ts", bytes);
    fs.mkdirSync(path.dirname(information.targetPath), { recursive: true });
    fs.writeFileSync(information.targetPath, Buffer.alloc(bytes.length, 0x78));
    assert.throws(() => mismatch.compiler.hooks.assetEmitted.callback("../../types/original.d.ts", information),
      /original emitted file differs from callback bytes/);
  } finally { mismatch.cleanup(); }
});

test("compiler type policy rejects outside paths, unknown formats and binary or compressed payloads", async () => {
  for (const [name, bytes, expected] of [
    ["../outside.ts", Buffer.from("export {};"), /unsupported exported asset format/],
    ["../../Types/uppercase.ts", Buffer.from("export {};"), /unsupported exported asset format/],
    ["../../types/uppercase.TS", Buffer.from("export {};"), /unsupported exported asset format/],
    ["../../types/unknown.bin", Buffer.from("inert"), /unsupported exported asset format/],
    ["../../types/not-type.tsx", Buffer.from("inert"), /unsupported exported asset format/],
    ["../../types/nul.ts", Buffer.from([0x61, 0x00, 0x62]), /plain UTF-8 without NUL/],
    ["../../types/non-utf8.ts", Buffer.from([0xff, 0xfe, 0xfd]), /plain UTF-8 without NUL/],
    ["../../types/opaque.ts", Buffer.from("504b030461", "hex"), /opaque or nested compression/],
    ["../../types/masked.ts", gzipSync(Buffer.from("export {};")), /opaque or nested compression/],
    ["../../types/guard.ts.gz", gzipSync(Buffer.from("export {};")), /unsupported or nested compressed export format/],
    ["../../types/guard.ts.br", brotliCompressSync(Buffer.from("export {};")), /unsupported or nested compressed export format/],
  ]) {
    const fixture = await compilerFixture([[name, bytes]]);
    try { assert.throws(() => fixture.scan(), expected); assert.equal(fixture.record.assets, null); }
    finally { fixture.cleanup(); }
  }
});

test("compiler type assets retain private-name and payload guards and file inventory bounds", async () => {
  for (const [name, bytes] of [
    ["../../types/evidenceloom-private-ui-driver-v1/../safe.ts", Buffer.from("export {};")],
    ["../../types/evidenceloom-private-ui-driver-v1.d.ts", Buffer.from("export {};")],
    ["../../types/plain.ts", Buffer.from("// evidenceloom-private-ui-driver-v1\nexport {};")],
  ]) {
    const fixture = await compilerFixture([[name, bytes]]);
    try { assert.throws(() => fixture.scan(), /private marker in normal compilation assets/); }
    finally { fixture.cleanup(); }
  }
  const bounded = await compilerFixture(Array.from({ length: 10001 }, (_, index) =>
    [`../../types/guard-${index}.ts`, Buffer.from("export {};")]));
  try {
    assert.throws(() => bounded.scan(), /asset inventory bound exceeded/);
    assert.equal(bounded.record.assets, null);
    assert.equal(bounded.record.assetScanFailure.relativePath, "types/guard-10000.ts");
    assert.equal(bounded.record.assetScanFailure.bytes, Buffer.byteLength("export {};"));
  } finally { bounded.cleanup(); }
});

test("strict final export scanner still rejects plain and compressed TypeScript assets", () => {
  for (const [name, bytes, expected] of [
    ["types/guard.ts", Buffer.from("export {};"), /unsupported exported asset format/],
    ["types/server.d.ts", Buffer.from("declare module 'next/server' {}"), /unsupported exported asset format/],
    ["types/guard.ts.gz", gzipSync(Buffer.from("export {};")), /unsupported or nested compressed export format/],
    ["types/guard.ts.br", brotliCompressSync(Buffer.from("export {};")), /unsupported or nested compressed export format/],
  ]) {
    const fixture = request({ [name]: bytes });
    try { assert.throws(() => normal.scanDesktopFrontendExportInventory(fixture.value), expected); }
    finally { fs.rmSync(fixture.directory, { recursive: true }); }
  }
});


// Production client callbacks keep the same physical-source requirements as real
// Next. These inert records do not prove that Next injected a client boundary.
test("normal production client requires physical selected-source resolution and module bytes", async () => {
  const entries = [["static/chunks/owned.js", Buffer.from("owned normal client")]];
  const fixture = await compilerFixture(entries, { dev: false, isServer: false });
  try {
    const selectedBytes = fs.readFileSync(fixture.selectedEntry);
    assert.match(selectedBytes.toString("utf8"), /^"use client";\n/);
    const module = {
      resource: fixture.selectedEntry,
      nameForCondition: () => fixture.selectedEntry,
      identifier: () => fixture.selectedEntry,
    };
    fixture.resolve(fixture.selectedEntry);
    fixture.compilation.modules = [module];
    fixture.compilation.hooks.finishModules.callback(fixture.compilation.modules);
    fixture.scan();
    for (const [name, content] of entries) fixture.emit(name, content);
    fixture.done();
    assert.equal(fixture.record.status, "complete");
    assert.deepEqual(fixture.record.replacements, []);
    assert.deepEqual(fixture.record.resolutions.map((row) => [row.sourcePath, row.sourceSha256]), [
      ["src/features/desktop-verification/disabled.tsx", hash(selectedBytes)],
    ]);
    assert.deepEqual(fixture.record.moduleRows.map((row) => [row.phase, row.kind, row.sourceSha256]), [
      ["finishModules", "physical-source", hash(selectedBytes)],
      ["done", "physical-source", hash(selectedBytes)],
    ]);
    assert.equal(fixture.record.emittedAssets.rows[0].sha256, hash(entries[0][1]));
    assert.equal(fixture.record.assets.rows[0].privateMarkerHits.length, 0);
  } finally { fixture.cleanup(); }
});

test("normal production client rejects absent entry, resolution-only and identifier-only evidence", async () => {
  for (const [label, resolved, moduleKind] of [
    ["observed absent client entry", false, "absent"],
    ["resolution without a module", true, "absent"],
    ["identifier reference without physical module", true, "identifier"],
    ["physical module without resolution", false, "physical"],
  ]) {
    const entries = [["static/chunks/owned.js", Buffer.from("owned normal client")]];
    const fixture = await compilerFixture(entries, { dev: false, isServer: false });
    try {
      if (resolved) fixture.resolve(fixture.selectedEntry);
      fixture.compilation.modules = moduleKind === "absent" ? [] : [{
        ...(moduleKind === "physical" ? { resource: fixture.selectedEntry } : {}),
        identifier: () => fixture.selectedEntry,
      }];
      fixture.compilation.hooks.finishModules.callback(fixture.compilation.modules);
      fixture.scan();
      for (const [name, content] of entries) fixture.emit(name, content);
      assert.throws(() => fixture.done(), /client missing selected entry/, label);
      assert.notEqual(fixture.record.status, "complete", label);
      if (moduleKind === "identifier") {
        assert.ok(fixture.record.moduleRows.length > 0);
        assert.ok(fixture.record.moduleRows.every((row) => row.kind === "identifier-reference"));
      }
    } finally { fixture.cleanup(); }
  }
});
