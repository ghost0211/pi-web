import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validatePiRuntimePackages } from "../scripts/desktop-bundle-validation.mjs";

const SDK_NESTED = "@earendil-works/pi-coding-agent/node_modules/";
const RUNTIME_FILES = {
  "@earendil-works/chord": ["dist/index.js", "dist/context/index.js"],
  "@earendil-works/pi-telemetry": ["dist/index.js"],
  [`${SDK_NESTED}@earendil-works/chord`]: ["dist/index.js", "dist/context/index.js"],
  [`${SDK_NESTED}@earendil-works/pi-telemetry`]: ["dist/index.js"],
  [`${SDK_NESTED}@earendil-works/pi-mcp`]: ["dist/index.js", "dist/transports/streamable-http.js", "dist/oauth/flow.js"],
  [`${SDK_NESTED}@earendil-works/pi-codemode`]: ["dist/index.js", "dist/wasm.js", "dist/runtime/worker.js"],
  [`${SDK_NESTED}quickjs-wasi`]: ["dist/index.js", "dist/wasi-shim.js", "quickjs.wasm"],
  [`${SDK_NESTED}@silvia-odwyer/photon-node`]: ["photon_rs.js", "photon_rs_bg.js", "photon_rs_bg.wasm"],
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-runtime-regress-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceNodeModulesDir = join(root, "source");
  const bundleNodeModulesDir = join(root, "bundle");
  // Synthetic packages isolate this guard from npm's version/hoisting choices.
  // Actual Next output is separately checked against its real installed source.
  for (const [pkg, files] of Object.entries(RUNTIME_FILES)) {
    const src = join(sourceNodeModulesDir, pkg);
    for (const file of ["package.json", ...files]) {
      const path = join(src, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file === "package.json" ? '{"type":"module"}' : "synthetic-runtime-asset");
    }
    mkdirSync(dirname(join(bundleNodeModulesDir, pkg)), { recursive: true });
    cpSync(src, join(bundleNodeModulesDir, pkg), { recursive: true });
  }
  return { sourceNodeModulesDir, bundleNodeModulesDir };
}

test("validates complete hoisted and nested runtime packages", (t) => {
  assert.deepEqual(validatePiRuntimePackages(fixture(t)), { packages: 8, files: 26 });
});

for (const [name, file, expected] of [
  ["Chord manifest", "@earendil-works/chord/package.json", /chord.*package\.json/],
  ["nested Chord manifest", `${SDK_NESTED}@earendil-works/chord/package.json`, /chord.*package\.json/],
  ["QuickJS shim", `${SDK_NESTED}quickjs-wasi/dist/wasi-shim.js`, /wasi-shim\.js/],
  ["QuickJS entry", `${SDK_NESTED}quickjs-wasi/dist/index.js`, /quickjs-wasi.*index\.js/],
  ["Photon loader", `${SDK_NESTED}@silvia-odwyer/photon-node/photon_rs.js`, /photon_rs\.js/],
  ["Photon wrapper", `${SDK_NESTED}@silvia-odwyer/photon-node/photon_rs_bg.js`, /photon_rs_bg\.js/],
  ["Codemode WASM loader", `${SDK_NESTED}@earendil-works/pi-codemode/dist/wasm.js`, /pi-codemode.*wasm\.js/],
  ["MCP transport", `${SDK_NESTED}@earendil-works/pi-mcp/dist/transports/streamable-http.js`, /streamable-http\.js/],
  ["MCP OAuth flow", `${SDK_NESTED}@earendil-works/pi-mcp/dist/oauth/flow.js`, /flow\.js/],
  ["nested telemetry", `${SDK_NESTED}@earendil-works/pi-telemetry`, /pi-telemetry/],
]) {
  test(`rejects bundle missing ${name}`, (t) => {
    const dirs = fixture(t);
    rmSync(join(dirs.bundleNodeModulesDir, file), { recursive: true, force: true });
    assert.throws(() => validatePiRuntimePackages(dirs), expected);
  });
}

for (const corruption of ["empty", "truncated", "directory"]) {
  test(`rejects ${corruption} runtime files`, (t) => {
    const dirs = fixture(t);
    const target = join(dirs.bundleNodeModulesDir, SDK_NESTED, "quickjs-wasi", "quickjs.wasm");
    if (corruption === "directory") { rmSync(target); mkdirSync(target); }
    else writeFileSync(target, corruption === "empty" ? "" : "truncated");
    assert.throws(() => validatePiRuntimePackages(dirs), /quickjs\.wasm/);
  });
}

test("always validates the source manifest as a regular file", (t) => {
  const dirs = fixture(t);
  const manifest = join(dirs.sourceNodeModulesDir, "@earendil-works/chord/package.json");
  rmSync(manifest); mkdirSync(manifest);
  assert.throws(() => validatePiRuntimePackages(dirs), /package\.json/);
});

test("does not recursively validate unrelated nested node_modules", (t) => {
  const dirs = fixture(t);
  const path = join(dirs.sourceNodeModulesDir, "@earendil-works/chord/node_modules/unrelated/index.js");
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "not-copied");
  assert.equal(validatePiRuntimePackages(dirs).packages, 8);
});

test("rejects a source package with a manifest but no runtime files", (t) => {
  const dirs = fixture(t);
  rmSync(join(dirs.sourceNodeModulesDir, "@earendil-works/chord/dist"), { recursive: true });
  assert.throws(() => validatePiRuntimePackages(dirs), /no runtime files/);
});

test("fails when source contains no Pi runtime packages", (t) => {
  const dirs = fixture(t);
  rmSync(dirs.sourceNodeModulesDir, { recursive: true, force: true });
  assert.throws(() => validatePiRuntimePackages(dirs), /no Pi runtime packages/);
});
