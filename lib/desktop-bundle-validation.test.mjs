import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  validatePiAiOAuthModules,
  validatePiCodemodeAssets,
  validatePiDocs,
  validatePiDynamicWorkers,
  validatePiRuntimePackages,
  validatePiWasmAssets,
} from "../scripts/desktop-bundle-validation.mjs";

const TOP_LEVEL = ["@earendil-works", "pi-ai"];
const NESTED = ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai"];

function writeOauthModules(nodeModulesDir, layout, names) {
  const oauthDir = join(nodeModulesDir, ...layout, "dist", "auth", "oauth");
  mkdirSync(oauthDir, { recursive: true });
  for (const name of names) writeFileSync(join(oauthDir, name), "export {};\n");
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-bundle-validation-"));
  const sourceNodeModulesDir = join(root, "source");
  const bundleNodeModulesDir = join(root, "bundle");
  mkdirSync(sourceNodeModulesDir);
  mkdirSync(bundleNodeModulesDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { sourceNodeModulesDir, bundleNodeModulesDir };
}

test("validates every OAuth JavaScript module from every installed pi-ai layout", (t) => {
  const dirs = fixture(t);
  const modules = ["load.js", "openai-codex.js", "pkce.js"];
  writeOauthModules(dirs.sourceNodeModulesDir, TOP_LEVEL, modules);
  writeOauthModules(dirs.sourceNodeModulesDir, NESTED, modules);
  writeOauthModules(dirs.bundleNodeModulesDir, TOP_LEVEL, modules);
  writeOauthModules(dirs.bundleNodeModulesDir, NESTED, modules);

  assert.equal(validatePiAiOAuthModules(dirs), 2);
});

test("does not let a complete top-level pi-ai hide a missing nested runtime", (t) => {
  const dirs = fixture(t);
  const modules = ["load.js", "openai-codex.js"];
  writeOauthModules(dirs.sourceNodeModulesDir, TOP_LEVEL, modules);
  writeOauthModules(dirs.sourceNodeModulesDir, NESTED, modules);
  writeOauthModules(dirs.bundleNodeModulesDir, TOP_LEVEL, modules);

  assert.throws(
    () => validatePiAiOAuthModules(dirs),
    /pi-coding-agent.*pi-ai.*load\.js.*outputFileTracingIncludes/,
  );
});

test("fails when a future dynamically loaded OAuth module is omitted", (t) => {
  const dirs = fixture(t);
  writeOauthModules(dirs.sourceNodeModulesDir, TOP_LEVEL, ["load.js", "future-flow.js"]);
  writeOauthModules(dirs.bundleNodeModulesDir, TOP_LEVEL, ["load.js"]);

  assert.throws(() => validatePiAiOAuthModules(dirs), /future-flow\.js/);
});

const QUICKJS_TOP = ["quickjs-wasi"];
const QUICKJS_NESTED = ["@earendil-works", "pi-coding-agent", "node_modules", "quickjs-wasi"];

function writeQuickJS(nodeModulesDir, layout, content = "wasm-fixture") {
  const dir = join(nodeModulesDir, ...layout);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "quickjs.wasm"), content);
}

test("validates QuickJS wasm for both hoisted and SDK-nested installations", (t) => {
  const dirs = fixture(t);
  for (const layout of [QUICKJS_TOP, QUICKJS_NESTED]) {
    writeQuickJS(dirs.sourceNodeModulesDir, layout);
    writeQuickJS(dirs.bundleNodeModulesDir, layout);
  }
  assert.equal(validatePiCodemodeAssets(dirs), 2);
});

test("a complete hoisted QuickJS cannot hide a missing SDK-nested wasm", (t) => {
  const dirs = fixture(t);
  writeQuickJS(dirs.sourceNodeModulesDir, QUICKJS_TOP);
  writeQuickJS(dirs.sourceNodeModulesDir, QUICKJS_NESTED);
  writeQuickJS(dirs.bundleNodeModulesDir, QUICKJS_TOP);
  assert.throws(() => validatePiCodemodeAssets(dirs), /pi-coding-agent.*quickjs\.wasm.*outputFileTracingIncludes/);
});

test("rejects empty or incomplete Codemode wasm assets", (t) => {
  const dirs = fixture(t);
  writeQuickJS(dirs.sourceNodeModulesDir, QUICKJS_NESTED);
  writeQuickJS(dirs.bundleNodeModulesDir, QUICKJS_NESTED, "");
  assert.throws(() => validatePiCodemodeAssets(dirs), /quickjs\.wasm/);
});

test("fails when the source installation has no Codemode wasm runtime", (t) => {
  assert.throws(() => validatePiCodemodeAssets(fixture(t)), /no installed QuickJS/);
});

// --- WASM Runtime Assets Validation Tests ---

const PHOTON_TOP = ["@silvia-odwyer", "photon-node"];
const PHOTON_NESTED = ["@earendil-works", "pi-coding-agent", "node_modules", "@silvia-odwyer", "photon-node"];

function writePhotonWasm(nodeModulesDir, layout, content = "photon-wasm-fixture") {
  const dir = join(nodeModulesDir, ...layout);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "photon_rs_bg.wasm"), content);
}

test("validates both QuickJS and Photon WASM in hoisted root and nested layouts", (t) => {
  const dirs = fixture(t);
  for (const layout of [QUICKJS_TOP, QUICKJS_NESTED]) {
    writeQuickJS(dirs.sourceNodeModulesDir, layout);
    writeQuickJS(dirs.bundleNodeModulesDir, layout);
  }
  for (const layout of [PHOTON_TOP, PHOTON_NESTED]) {
    writePhotonWasm(dirs.sourceNodeModulesDir, layout);
    writePhotonWasm(dirs.bundleNodeModulesDir, layout);
  }

  assert.equal(validatePiWasmAssets(dirs), 4);
});

test("a complete QuickJS cannot hide a missing Photon WASM runtime", (t) => {
  const dirs = fixture(t);
  writeQuickJS(dirs.sourceNodeModulesDir, QUICKJS_TOP);
  writeQuickJS(dirs.bundleNodeModulesDir, QUICKJS_TOP);
  writePhotonWasm(dirs.sourceNodeModulesDir, PHOTON_NESTED);

  assert.throws(
    () => validatePiWasmAssets(dirs),
    /photon_rs_bg\.wasm.*outputFileTracingIncludes/,
  );
});

test("rejects empty or size-mismatched WASM assets", (t) => {
  const dirs = fixture(t);
  writePhotonWasm(dirs.sourceNodeModulesDir, PHOTON_NESTED, "full-wasm-content");
  writePhotonWasm(dirs.bundleNodeModulesDir, PHOTON_NESTED, "");

  assert.throws(() => validatePiWasmAssets(dirs), /photon_rs_bg\.wasm/);

  // Size mismatch
  writePhotonWasm(dirs.bundleNodeModulesDir, PHOTON_NESTED, "partial");
  assert.throws(() => validatePiWasmAssets(dirs), /photon_rs_bg\.wasm/);
});

test("rejects non-regular file (directory) for WASM asset", (t) => {
  const dirs = fixture(t);
  writeQuickJS(dirs.sourceNodeModulesDir, QUICKJS_TOP);
  const bundleFakeDir = join(dirs.bundleNodeModulesDir, ...QUICKJS_TOP, "quickjs.wasm");
  mkdirSync(bundleFakeDir, { recursive: true });

  assert.throws(() => validatePiWasmAssets(dirs), /quickjs\.wasm/);
});

test("fails when source installation has no WASM runtime assets", (t) => {
  assert.throws(() => validatePiWasmAssets(fixture(t)), /no installed WASM/);
});

// --- Dynamic Workers and Runtime Entry Dependencies Tests ---

const PI_CODING_AGENT = ["@earendil-works", "pi-coding-agent"];
const PI_CODEMODE_TOP = ["@earendil-works", "pi-codemode"];
const PI_CODEMODE_NESTED = ["@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-codemode"];

function writeCodingAgentWorkers(nodeModulesDir, layout = PI_CODING_AGENT, options = {}) {
  const {
    imageResize = true,
    codemode099 = true,
    imageContent = "resize-worker",
    codemodeContent = "099-worker",
    siblingDeps = false,
  } = options;
  if (imageResize) {
    const p = join(nodeModulesDir, ...layout, "dist", "utils");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "image-resize-worker.js"), imageContent);
    if (siblingDeps) {
      writeFileSync(join(p, "image-resize-core.js"), "core-content");
      writeFileSync(join(p, "exif-orientation.js"), "orientation-content");
      writeFileSync(join(p, "photon.js"), "photon-content");
    }
  }
  if (codemode099) {
    const p = join(nodeModulesDir, ...layout, "dist", "extensions", "codemode");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "worker.js"), codemodeContent);
  }
}

function writePiCodemodeRuntime(nodeModulesDir, layout, options = {}) {
  const {
    worker = true,
    prelude = true,
    protocol = true,
    host = true,
    index = true,
    workerContent = "export default {};\n",
  } = options;

  const runtimeDir = join(nodeModulesDir, ...layout, "dist", "runtime");
  mkdirSync(runtimeDir, { recursive: true });

  if (worker) writeFileSync(join(runtimeDir, "worker.js"), workerContent);
  if (prelude) writeFileSync(join(runtimeDir, "prelude-source.js"), "export const PRELUDE_SOURCE = '';\n");
  if (protocol) writeFileSync(join(runtimeDir, "protocol.js"), "export const PROTOCOL = 1;\n");
  if (host) writeFileSync(join(runtimeDir, "host.js"), "export class Execution {}\n");
  if (index) {
    const distDir = join(nodeModulesDir, ...layout, "dist");
    writeFileSync(join(distDir, "index.js"), "export * from './runtime/host.js';\n");
  }
}

test("validates dynamic workers and runtime entry dependencies for SDK 1.0 and 0.99 layout", (t) => {
  const dirs = fixture(t);
  // Source setup
  writeCodingAgentWorkers(dirs.sourceNodeModulesDir);
  writePiCodemodeRuntime(dirs.sourceNodeModulesDir, PI_CODEMODE_NESTED);
  // Bundle setup
  writeCodingAgentWorkers(dirs.bundleNodeModulesDir);
  writePiCodemodeRuntime(dirs.bundleNodeModulesDir, PI_CODEMODE_NESTED);

  const checked = validatePiDynamicWorkers(dirs);
  // 1 image worker + 1 codemode 0.99 worker + 1 codemode 1.0 worker = 3
  assert.equal(checked, 3);
});

test("dynamic worker fails when worker file is missing from bundle", (t) => {
  const dirs = fixture(t);
  writeCodingAgentWorkers(dirs.sourceNodeModulesDir);
  writeCodingAgentWorkers(dirs.bundleNodeModulesDir, PI_CODING_AGENT, { codemode099: false });

  assert.throws(
    () => validatePiDynamicWorkers(dirs),
    /codemode.*worker\.js.*outputFileTracingIncludes/,
  );
});

test("dynamic worker fails when image-resize-worker sibling dependency is missing from bundle", (t) => {
  const dirs = fixture(t);
  writeCodingAgentWorkers(dirs.sourceNodeModulesDir, PI_CODING_AGENT, { siblingDeps: true });
  // Bundle only has image-resize-worker.js, missing image-resize-core.js!
  writeCodingAgentWorkers(dirs.bundleNodeModulesDir, PI_CODING_AGENT, { siblingDeps: false });

  assert.throws(
    () => validatePiDynamicWorkers(dirs),
    /image-resize-core\.js.*outputFileTracingIncludes/,
  );
});

test("dynamic worker tolerates older SDK where image-resize-worker sibling dependencies are absent", (t) => {
  const dirs = fixture(t);
  // Source has only image-resize-worker.js without sibling dependencies (older SDK)
  writeCodingAgentWorkers(dirs.sourceNodeModulesDir, PI_CODING_AGENT, { siblingDeps: false });
  writeCodingAgentWorkers(dirs.bundleNodeModulesDir, PI_CODING_AGENT, { siblingDeps: false });

  assert.equal(validatePiDynamicWorkers(dirs), 2);
});

test("dynamic worker fails when runtime entry dependencies are not traced (not just worker alone)", (t) => {
  const dirs = fixture(t);
  writePiCodemodeRuntime(dirs.sourceNodeModulesDir, PI_CODEMODE_NESTED);
  // Bundle only has worker.js, missing prelude-source.js dependency!
  writePiCodemodeRuntime(dirs.bundleNodeModulesDir, PI_CODEMODE_NESTED, { prelude: false });

  assert.throws(
    () => validatePiDynamicWorkers(dirs),
    /prelude-source\.js.*outputFileTracingIncludes/,
  );
});

test("dynamic worker fails when runtime entry index.js is missing from bundle", (t) => {
  const dirs = fixture(t);
  writePiCodemodeRuntime(dirs.sourceNodeModulesDir, PI_CODEMODE_NESTED);
  // Bundle has worker and runtime files, but missing index.js!
  writePiCodemodeRuntime(dirs.bundleNodeModulesDir, PI_CODEMODE_NESTED, { index: false });

  assert.throws(
    () => validatePiDynamicWorkers(dirs),
    /index\.js.*outputFileTracingIncludes/,
  );
});

test("rejects empty or size-mismatched dynamic worker files", (t) => {
  const dirs = fixture(t);
  writePiCodemodeRuntime(dirs.sourceNodeModulesDir, PI_CODEMODE_TOP);
  writePiCodemodeRuntime(dirs.bundleNodeModulesDir, PI_CODEMODE_TOP, { workerContent: "" });

  assert.throws(() => validatePiDynamicWorkers(dirs), /worker\.js/);

  writePiCodemodeRuntime(dirs.bundleNodeModulesDir, PI_CODEMODE_TOP, { workerContent: "different" });
  assert.throws(() => validatePiDynamicWorkers(dirs), /worker\.js/);
});

test("rejects non-regular file (directory) where dynamic worker is expected", (t) => {
  const dirs = fixture(t);
  writeCodingAgentWorkers(dirs.sourceNodeModulesDir, PI_CODING_AGENT, { codemode099: false });
  const fakeWorkerDir = join(dirs.bundleNodeModulesDir, ...PI_CODING_AGENT, "dist", "utils", "image-resize-worker.js");
  mkdirSync(fakeWorkerDir, { recursive: true });

  assert.throws(() => validatePiDynamicWorkers(dirs), /image-resize-worker\.js/);
});

test("fails when source installation has no dynamic workers", (t) => {
  assert.throws(() => validatePiDynamicWorkers(fixture(t)), /no dynamic worker runtimes/);
});

// --- Documentation Assets Tests ---

function writeDocs(nodeModulesDir, layout, docs) {
  const docsDir = join(nodeModulesDir, ...layout);
  mkdirSync(docsDir, { recursive: true });
  for (const [name, content] of Object.entries(docs)) {
    const filePath = join(docsDir, name);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, content);
  }
}

test("validates SDK documentation assets in the bundle (including 1.0 codemode.md)", (t) => {
  const dirs = fixture(t);
  const docs = {
    "overview.md": "# Overview\n",
    "codemode.md": "# Codemode Reference\n",
    "nested/deep.md": "# Deep Doc\n",
  };
  writeDocs(dirs.sourceNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], docs);
  writeDocs(dirs.bundleNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], docs);

  assert.equal(validatePiDocs(dirs), 1);
});

test("fails when an individual documentation asset is missing from bundle", (t) => {
  const dirs = fixture(t);
  const sourceDocs = { "overview.md": "# Overview\n", "codemode.md": "# Codemode\n" };
  const bundleDocs = { "overview.md": "# Overview\n" };

  writeDocs(dirs.sourceNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], sourceDocs);
  writeDocs(dirs.bundleNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], bundleDocs);

  assert.throws(
    () => validatePiDocs(dirs),
    /codemode\.md.*outputFileTracingIncludes/,
  );
});

test("fails when the entire documentation directory is missing from bundle", (t) => {
  const dirs = fixture(t);
  writeDocs(dirs.sourceNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], { "overview.md": "# Doc\n" });

  assert.throws(
    () => validatePiDocs(dirs),
    /missing documentation directory.*outputFileTracingIncludes/,
  );
});

test("rejects empty or size-mismatched documentation assets", (t) => {
  const dirs = fixture(t);
  writeDocs(dirs.sourceNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], { "overview.md": "# Doc\n" });
  writeDocs(dirs.bundleNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], { "overview.md": "" });

  assert.throws(() => validatePiDocs(dirs), /overview\.md/);

  writeDocs(dirs.bundleNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], { "overview.md": "# D\n" });
  assert.throws(() => validatePiDocs(dirs), /overview\.md/);
});

test("rejects directory where documentation file is expected", (t) => {
  const dirs = fixture(t);
  writeDocs(dirs.sourceNodeModulesDir, ["@earendil-works", "pi-coding-agent", "docs"], { "overview.md": "# Doc\n" });
  const fakeDocDir = join(dirs.bundleNodeModulesDir, "@earendil-works", "pi-coding-agent", "docs", "overview.md");
  mkdirSync(fakeDocDir, { recursive: true });

  assert.throws(() => validatePiDocs(dirs), /overview\.md/);
});

test("fails when source installation has no documentation directory", (t) => {
  assert.throws(() => validatePiDocs(fixture(t)), /no installed documentation/);
});

// --- Verification Against Real Node Modules ---

test("validates against real repository node_modules layout", () => {
  const dirs = {
    sourceNodeModulesDir: "./node_modules",
    bundleNodeModulesDir: "./node_modules",
  };

  assert.ok(validatePiAiOAuthModules(dirs) >= 1);
  assert.ok(validatePiCodemodeAssets(dirs) >= 1);
  assert.ok(validatePiWasmAssets(dirs) >= 1);
  assert.ok(validatePiDynamicWorkers(dirs) >= 1);
  assert.ok(validatePiDocs(dirs) >= 1);
  assert.ok(validatePiRuntimePackages(dirs).packages >= 1);
});
