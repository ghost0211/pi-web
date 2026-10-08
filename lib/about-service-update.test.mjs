import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { executePiAgentUpdate } = await jiti.import("./about-service.ts");

function createMockEnvironment() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-update-test-"));
  const fakeHome = path.join(baseDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });

  const nodePrefix = path.join(baseDir, "node-prefix");
  const nodeBinDir = path.join(nodePrefix, "bin");
  const nodePkgDir = path.join(
    nodePrefix,
    "lib",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const nodePkgBundleDir = path.join(nodePkgDir, "dist", "bundle");
  fs.mkdirSync(nodeBinDir, { recursive: true });
  fs.mkdirSync(nodePkgBundleDir, { recursive: true });

  const pkgJsonPath = path.join(nodePkgDir, "package.json");
  fs.writeFileSync(
    pkgJsonPath,
    JSON.stringify(
      {
        name: "@earendil-works/pi-coding-agent",
        version: "1.0.3",
        bin: { pi: "dist/bundle/cli.js" },
      },
      null,
      2,
    ),
    "utf8",
  );

  const cliScriptPath = path.join(nodePkgBundleDir, "cli.js");
  fs.writeFileSync(
    cliScriptPath,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
if (process.argv.includes("--version")) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));
  console.log(pkg.version);
}
`,
    { encoding: "utf8", mode: 0o755 },
  );

  // npm-managed bin symlink: nodePrefix/bin/pi -> ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
  const npmBinPi = path.join(nodeBinDir, "pi");
  fs.symlinkSync(
    path.join("..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    npmBinPi,
  );

  // Outer manual symlink: userLocal/bin/pi -> nodePrefix/bin/pi
  const userLocalBinDir = path.join(baseDir, "user-local", "bin");
  fs.mkdirSync(userLocalBinDir, { recursive: true });
  const outerPi = path.join(userLocalBinDir, "pi");
  fs.symlinkSync(npmBinPi, outerPi);

  // Fake npm in tools/bin
  const toolsBinDir = path.join(baseDir, "tools", "bin");
  fs.mkdirSync(toolsBinDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(toolsBinDir, "node"));
  const fakeNpmPath = path.join(toolsBinDir, "npm");

  const npmLogFile = path.join(baseDir, "npm-calls.log");
  fs.writeFileSync(
    fakeNpmPath,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(npmLogFile)}, JSON.stringify(args) + "\\n");

const prefixIdx = args.indexOf("--prefix");
const targetPrefix = prefixIdx !== -1 ? args[prefixIdx + 1] : null;

// If npm install -g was invoked without --prefix, simulate EEXIST collision with outer manual symlink
if (!targetPrefix) {
  console.error("npm ERR! code EEXIST");
  console.error("npm ERR! path ${outerPi}");
  console.error("npm ERR! EEXIST: file already exists, symlink '../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js' -> '${outerPi}'");
  process.exit(1);
}

// If --prefix was correctly pointed to the nodePrefix, simulate success and upgrade version
if (targetPrefix === ${JSON.stringify(nodePrefix)}) {
  const pkgPath = ${JSON.stringify(pkgJsonPath)};
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = "1.0.4";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), "utf8");
  console.log("+ @earendil-works/pi-coding-agent@1.0.4");
  console.log("updated 1 package");
  process.exit(0);
}

console.error("Unexpected prefix: " + targetPrefix);
process.exit(1);
`,
    { encoding: "utf8", mode: 0o755 },
  );

  return {
    baseDir,
    fakeHome,
    nodePrefix,
    userLocalBinDir,
    toolsBinDir,
    outerPi,
    npmBinPi,
    pkgJsonPath,
    npmLogFile,
  };
}

test("updates the actual npm installation without clobbering the PATH manual symlink", { skip: process.platform === "win32" }, async () => {
  const envFixture = createMockEnvironment();
  const originalEnv = { ...process.env };

  try {
    process.env.HOME = envFixture.fakeHome;
    process.env.PATH = `${envFixture.userLocalBinDir}${path.delimiter}${envFixture.toolsBinDir}`;
    const authDir = path.join(envFixture.fakeHome, ".pi", "agent");
    fs.mkdirSync(authDir, { recursive: true });
    const authPath = path.join(authDir, "auth.json");
    const authBytes = '{"openai-codex":{"type":"oauth","refresh":"synthetic-only"}}\n';
    fs.writeFileSync(authPath, authBytes, { mode: 0o600 });

    const result = await executePiAgentUpdate("global");

    // Before fix, this fails because blind `npm install -g` triggers EEXIST
    assert.equal(result.success, true, `Update should succeed, got output: ${result.output} (error: ${result.error})`);
    assert.equal(result.previousVersion, "1.0.3");
    assert.equal(result.newVersion, "1.0.4");
    const calls = fs.readFileSync(envFixture.npmLogFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(calls, [["install", "-g", "--prefix", envFixture.nodePrefix, "@earendil-works/pi-coding-agent@latest"]]);
    assert.equal(fs.readFileSync(authPath, "utf8"), authBytes);

    // Verify outer manual symlink was preserved and still intact
    assert.ok(fs.lstatSync(envFixture.outerPi).isSymbolicLink(), "Outer symlink must remain a symlink");
    assert.equal(fs.readlinkSync(envFixture.outerPi), envFixture.npmBinPi, "Outer symlink target unchanged");
  } finally {
    process.env = originalEnv;
    fs.rmSync(envFixture.baseDir, { recursive: true, force: true });
  }
});

async function withMockEnvironment(run) {
  const f = createMockEnvironment();
  const originalEnv = { ...process.env };
  try {
    process.env.HOME = f.fakeHome;
    process.env.PATH = `${f.userLocalBinDir}${path.delimiter}${f.toolsBinDir}`;
    return await run(f);
  } finally {
    process.env = originalEnv;
    fs.rmSync(f.baseDir, { recursive: true, force: true });
  }
}

test("unsupported launcher is rejected before npm is invoked", { skip: process.platform === "win32" }, async () => {
  await withMockEnvironment(async f => {
    fs.unlinkSync(f.outerPi);
    fs.writeFileSync(f.outerPi, '#!/bin/sh\necho "custom-wrapper"\n', { mode: 0o755 });
    const result = await executePiAgentUpdate("global");
    assert.equal(result.success, false);
    assert.match(result.output, /original installation method/);
    assert.equal(fs.existsSync(f.npmLogFile), false);
  });
});

test("npm exit zero cannot report success when active CLI verification fails", { skip: process.platform === "win32" }, async () => {
  await withMockEnvironment(async f => {
    fs.writeFileSync(path.join(f.toolsBinDir, "npm"), `#!/usr/bin/env node\nrequire('fs').unlinkSync(${JSON.stringify(path.join(path.dirname(f.pkgJsonPath), 'dist', 'bundle', 'cli.js'))});\nconsole.log('npm completed');\n`, { mode: 0o755 });
    const result = await executePiAgentUpdate("global");
    assert.equal(result.success, false);
    assert.equal(result.newVersion, null);
    assert.equal(result.error, "Updated Pi CLI could not be verified");
  });
});

test("fresh global installation keeps npm default prefix without force", { skip: process.platform === "win32" }, async () => {
  await withMockEnvironment(async f => {
    fs.unlinkSync(f.outerPi);
    fs.writeFileSync(path.join(f.toolsBinDir, "npm"), `#!/usr/bin/env node\nconst fs=require('fs');\nfs.writeFileSync(${JSON.stringify(f.npmLogFile)},JSON.stringify(process.argv.slice(2)));\nfs.symlinkSync(${JSON.stringify(f.npmBinPi)},${JSON.stringify(f.outerPi)});\n`, { mode: 0o755 });
    const result = await executePiAgentUpdate("global");
    assert.equal(result.success, true);
    assert.equal(result.previousVersion, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.npmLogFile)), ["install", "-g", "@earendil-works/pi-coding-agent@latest"]);
  });
});

test("local SDK update retains its existing command and does not infer a CLI prefix", { skip: process.platform === "win32" }, async () => {
  await withMockEnvironment(async f => {
    fs.writeFileSync(path.join(f.toolsBinDir, "npm"), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(f.npmLogFile)},JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    const result = await executePiAgentUpdate("local");
    assert.equal(result.success, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.npmLogFile)), ["install", "@earendil-works/pi-coding-agent@latest", "@earendil-works/pi-agent-core@latest", "@earendil-works/pi-ai@latest", "@earendil-works/pi-tui@latest"]);
  });
});
