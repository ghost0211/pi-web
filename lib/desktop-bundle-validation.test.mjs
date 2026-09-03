import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePiAiOAuthModules } from "../scripts/desktop-bundle-validation.mjs";

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
