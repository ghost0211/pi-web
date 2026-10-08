import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { locateGlobalPiCli } = await jiti.import("./pi-cli-locator.ts");

const posixTest = (name, fn) => test(name, { skip: process.platform === "win32" }, fn);

function setupTestDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-locator-test-"));
  return {
    base,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function createNpmGlobalPackage(prefixDir, options = {}) {
  const libSubdir = options.legacyLayout ? [] : ["lib"];
  const pkgDir = path.join(
    prefixDir,
    ...libSubdir,
    "node_modules",
    options.scope ?? "@earendil-works",
    options.name ?? "pi-coding-agent",
  );
  fs.mkdirSync(path.join(pkgDir, "dist", "bundle"), { recursive: true });

  const pkgJson = {
    name: options.packageName ?? "@earendil-works/pi-coding-agent",
    version: options.version ?? "1.0.3",
    bin: options.bin !== undefined ? options.bin : { pi: "dist/bundle/cli.js" },
  };
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify(pkgJson, null, 2), "utf8");

  const entrypoint = path.join(pkgDir, "dist", "bundle", "cli.js");
  if (!options.skipEntrypoint) {
    fs.writeFileSync(entrypoint, `#!/usr/bin/env node\nconsole.log("${pkgJson.version}");\n`, {
      mode: 0o755,
    });
  }

  const binDir = path.join(prefixDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const npmBinPi = path.join(binDir, "pi");

  if (!options.skipBinLink) {
    const relToTarget = path.relative(binDir, entrypoint);
    fs.symlinkSync(relToTarget, npmBinPi);
  }

  return { pkgDir, entrypoint, npmBinPi };
}

posixTest("returns not-found when pi is not on PATH", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const res = locateGlobalPiCli({
      env: { PATH: base },
      platform: "linux",
    });
    assert.equal(res.kind, "not-found");
  } finally {
    cleanup();
  }
});

posixTest("detects standard POSIX global npm installation", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const prefix = path.join(base, "npm-prefix");
    const { npmBinPi, pkgDir, entrypoint } = createNpmGlobalPackage(prefix);

    const res = locateGlobalPiCli({
      env: { PATH: path.join(prefix, "bin") },
      platform: "linux",
    });

    assert.equal(res.kind, "npm-global");
    assert.equal(res.prefix, prefix);
    assert.equal(res.launcherPath, npmBinPi);
    assert.equal(res.npmBinPath, npmBinPi);
    assert.equal(res.packageDir, pkgDir);
    assert.equal(res.entrypoint, entrypoint);
  } finally {
    cleanup();
  }
});

posixTest("detects installation through nested manual symlinks (user .local/bin/pi scenario)", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const actualPrefix = path.join(base, "node-v24.18.0-linux-x64");
    const { npmBinPi, pkgDir, entrypoint } = createNpmGlobalPackage(actualPrefix);

    const middleDir = path.join(base, "middle-dir", "bin");
    fs.mkdirSync(middleDir, { recursive: true });
    const middlePi = path.join(middleDir, "pi");
    fs.symlinkSync(npmBinPi, middlePi);

    const userLocalDir = path.join(base, ".local", "bin");
    fs.mkdirSync(userLocalDir, { recursive: true });
    const outerPi = path.join(userLocalDir, "pi");
    fs.symlinkSync(middlePi, outerPi);

    const res = locateGlobalPiCli({
      env: { PATH: userLocalDir },
      platform: "linux",
    });

    assert.equal(res.kind, "npm-global");
    assert.equal(res.prefix, actualPrefix);
    assert.equal(res.launcherPath, outerPi);
    assert.equal(res.npmBinPath, npmBinPi);
    assert.equal(res.packageDir, pkgDir);
    assert.equal(res.entrypoint, entrypoint);
  } finally {
    cleanup();
  }
});

posixTest("supports path components containing spaces", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const spacePrefix = path.join(base, "node prefix with spaces");
    const { npmBinPi, pkgDir, entrypoint } = createNpmGlobalPackage(spacePrefix);

    const outerDir = path.join(base, "outer bin with spaces");
    fs.mkdirSync(outerDir, { recursive: true });
    const outerPi = path.join(outerDir, "pi");
    fs.symlinkSync(npmBinPi, outerPi);

    const res = locateGlobalPiCli({
      env: { PATH: outerDir },
      platform: "linux",
    });

    assert.equal(res.kind, "npm-global");
    assert.equal(res.prefix, spacePrefix);
    assert.equal(res.launcherPath, outerPi);
    assert.equal(res.npmBinPath, npmBinPi);
    assert.equal(res.packageDir, pkgDir);
    assert.equal(res.entrypoint, entrypoint);
  } finally {
    cleanup();
  }
});

posixTest("rejects POSIX non-npm layout without lib/ subdirectory", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const legacyPrefix = path.join(base, "legacy-prefix");
    createNpmGlobalPackage(legacyPrefix, { legacyLayout: true });

    const res = locateGlobalPiCli({
      env: { PATH: path.join(legacyPrefix, "bin") },
      platform: "linux",
    });

    assert.equal(res.kind, "unsupported");
  } finally {
    cleanup();
  }
});

posixTest("rejects regular non-symlink wrapper scripts on POSIX", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const binDir = path.join(base, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const wrapperPi = path.join(binDir, "pi");
    fs.writeFileSync(
      wrapperPi,
      `#!/bin/bash\nexec node /some/where/cli.js "$@"\n`,
      { mode: 0o755 },
    );

    const res = locateGlobalPiCli({
      env: { PATH: binDir },
      platform: "linux",
    });

    assert.equal(res.kind, "unsupported");
    assert.equal(res.launcherPath, wrapperPi);
    assert.match(res.reason, /regular file\/wrapper script/);
  } finally {
    cleanup();
  }
});

posixTest("rejects local node_modules/.bin on PATH", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const projectDir = path.join(base, "my-project");
    const dotBinDir = path.join(projectDir, "node_modules", ".bin");
    fs.mkdirSync(dotBinDir, { recursive: true });
    const localPi = path.join(dotBinDir, "pi");
    fs.symlinkSync("../../dist/cli.js", localPi);

    const res = locateGlobalPiCli({
      env: { PATH: dotBinDir },
      platform: "linux",
    });

    assert.equal(res.kind, "unsupported");
    assert.match(res.reason, /local node_modules\/\.bin/);
  } finally {
    cleanup();
  }
});

posixTest("rejects pnpm installations fail-closed", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const pnpmDir = path.join(base, "pnpm-store", ".pnpm", "pkg");
    fs.mkdirSync(pnpmDir, { recursive: true });
    const binDir = path.join(base, "pnpm-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const pnpmPi = path.join(binDir, "pi");

    const cliJs = path.join(pnpmDir, "cli.js");
    fs.writeFileSync(cliJs, "console.log(1);", { mode: 0o755 });
    fs.symlinkSync(cliJs, pnpmPi);

    const res = locateGlobalPiCli({
      env: { PATH: binDir },
      platform: "linux",
    });

    assert.equal(res.kind, "unsupported");
    assert.ok(res.reason.length > 0);
  } finally {
    cleanup();
  }
});

posixTest("handles symlink cycle gracefully without hanging", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const binDir = path.join(base, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const piA = path.join(binDir, "pi");
    const piB = path.join(binDir, "pi-loop");
    fs.symlinkSync("pi-loop", piA);
    fs.symlinkSync("pi", piB);

    const res = locateGlobalPiCli({
      env: { PATH: binDir },
      platform: "linux",
    });

    // piA has broken target cycle so findPiInPath or locator rejects safely
    assert.ok(res.kind === "not-found" || res.kind === "unsupported");
  } finally {
    cleanup();
  }
});

posixTest("rejects invalid package metadata (wrong package name)", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const prefix = path.join(base, "fake-prefix");
    createNpmGlobalPackage(prefix, {
      packageName: "@other-org/other-agent",
    });

    const res = locateGlobalPiCli({
      env: { PATH: path.join(prefix, "bin") },
      platform: "linux",
    });

    assert.equal(res.kind, "unsupported");
    assert.match(res.reason, /does not match @earendil-works\/pi-coding-agent/);
  } finally {
    cleanup();
  }
});

posixTest("rejects invalid package metadata (missing bin.pi)", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const prefix = path.join(base, "fake-prefix");
    createNpmGlobalPackage(prefix, {
      bin: { other: "dist/cli.js" },
    });

    const res = locateGlobalPiCli({
      env: { PATH: path.join(prefix, "bin") },
      platform: "linux",
    });

    assert.equal(res.kind, "unsupported");
    assert.match(res.reason, /does not define a relative bin\.pi/);
  } finally {
    cleanup();
  }
});

posixTest("rejects missing entrypoint file", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const prefix = path.join(base, "fake-prefix");
    createNpmGlobalPackage(prefix, {
      skipEntrypoint: true,
    });

    const res = locateGlobalPiCli({
      env: { PATH: path.join(prefix, "bin") },
      platform: "linux",
    });

    assert.equal(res.kind, "unsupported");
    assert.match(res.reason, /ENOENT|does not exist|broken/);
  } finally {
    cleanup();
  }
});

posixTest("respects PATH search order and fails closed if earlier launcher is unsupported", () => {
  const { base, cleanup } = setupTestDir();
  try {
    // Unsupported wrapper directory earlier in PATH
    const wrapperDir = path.join(base, "wrapper-bin");
    fs.mkdirSync(wrapperDir, { recursive: true });
    const wrapperPi = path.join(wrapperDir, "pi");
    fs.writeFileSync(wrapperPi, `#!/bin/sh\necho "wrapper"\n`, { mode: 0o755 });

    // Valid npm prefix later in PATH
    const validPrefix = path.join(base, "valid-prefix");
    createNpmGlobalPackage(validPrefix);

    const res = locateGlobalPiCli({
      env: { PATH: `${wrapperDir}:${path.join(validPrefix, "bin")}` },
      platform: "linux",
    });

    // Must evaluate the first launcher encountered in PATH order, not skip it
    assert.equal(res.kind, "unsupported");
    assert.equal(res.launcherPath, wrapperPi);
  } finally {
    cleanup();
  }
});

test("detects Windows standard npm cmd shim", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const prefix = path.join(base, "windows-prefix");
    const pkgDir = path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
    fs.mkdirSync(path.join(pkgDir, "dist", "bundle"), { recursive: true });

    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "1.0.3",
        bin: { pi: "dist/bundle/cli.js" },
      }),
      "utf8",
    );

    const entrypoint = path.join(pkgDir, "dist", "bundle", "cli.js");
    fs.writeFileSync(entrypoint, "console.log(1);", "utf8");

    const cmdShim = path.join(prefix, "pi.cmd");
    fs.writeFileSync(
      cmdShim,
      `@ECHO off\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n`,
      "utf8",
    );

    const res = locateGlobalPiCli({
      env: { PATH: prefix, PATHEXT: ".cmd;.bat" },
      platform: "win32",
    });

    assert.equal(res.kind, "npm-global");
    assert.equal(res.prefix, prefix);
    assert.equal(res.launcherPath, cmdShim);
    assert.equal(res.packageDir, pkgDir);
    assert.equal(res.entrypoint, entrypoint);
  } finally {
    cleanup();
  }
});

test("rejects Windows .exe binary as unsupported", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const binDir = path.join(base, "win-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const exePath = path.join(binDir, "pi.exe");
    fs.writeFileSync(exePath, "fake exe content", "utf8");

    const res = locateGlobalPiCli({
      env: { PATH: binDir, PATHEXT: ".exe;.cmd" },
      platform: "win32",
    });

    assert.equal(res.kind, "unsupported");
    assert.equal(res.launcherPath, exePath);
    assert.match(res.reason, /standard npm pi\.cmd/);
  } finally {
    cleanup();
  }
});

posixTest("rejects a manifest bin escaping the package directory", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const prefix = path.join(base, "npm-prefix");
    createNpmGlobalPackage(prefix, { bin: { pi: "../../../../outside.js" } });
    const result = locateGlobalPiCli({ env: { PATH: path.join(prefix, "bin") }, platform: "linux" });
    assert.equal(result.kind, "unsupported");
    assert.match(result.reason, /escapes/);
  } finally { cleanup(); }
});

posixTest("rejects npm-link packages pointing at a source checkout", () => {
  const { base, cleanup } = setupTestDir();
  try {
    const prefix = path.join(base, "prefix"), source = path.join(base, "source");
    const original = createNpmGlobalPackage(prefix);
    fs.renameSync(original.pkgDir, source);
    fs.symlinkSync(source, original.pkgDir, "dir");
    const result = locateGlobalPiCli({ env: { PATH: path.join(prefix, "bin") }, platform: "linux" });
    assert.equal(result.kind, "unsupported");
    assert.match(result.reason, /linked outside/);
  } finally { cleanup(); }
});

posixTest("empty PATH components fail closed on a local wrapper", () => {
  const { base, cleanup } = setupTestDir();
  const previous = process.cwd();
  try {
    fs.writeFileSync(path.join(base, "pi"), '#!/bin/sh\necho "wrapper"\n', { mode: 0o755 });
    process.chdir(base);
    const result = locateGlobalPiCli({ env: { PATH: ":/nonexistent" }, platform: "linux" });
    assert.equal(result.kind, "unsupported");
    assert.equal(result.launcherPath, path.join(base, "pi"));
  } finally { process.chdir(previous); cleanup(); }
});

function withWindowsShim(script, check, suffix = "prefix") {
  const { base, cleanup } = setupTestDir();
  try {
    const prefix = path.join(base, suffix);
    const { npmBinPi } = createNpmGlobalPackage(prefix, { legacyLayout: true, skipBinLink: true });
    const shim = path.join(prefix, "pi.cmd");
    fs.writeFileSync(shim, script);
    check(locateGlobalPiCli({ env: { Path: prefix, PATHEXT: ".CMD;.EXE" }, platform: "win32" }), { prefix, shim, npmBinPi });
  } finally { cleanup(); }
}

test("supports current npm Windows dp0/prog cmd shims", () => {
  withWindowsShim('@ECHO off\nSET dp0=%~dp0\nSET "_prog=node"\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n', result => {
    assert.equal(result.kind, "npm-global");
  });
});

test("rejects Windows wrappers that only mention the correct entrypoint in comments", () => {
  withWindowsShim('REM node "%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\nnode "%~dp0\\other\\cli.js" %*\n', result => {
    assert.equal(result.kind, "unsupported");
    assert.match(result.reason, /does not invoke/);
  });
});

test("rejects Windows wrappers that invoke another prefix", () => {
  withWindowsShim('node "%~dp0\\other-prefix\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n', result => {
    assert.equal(result.kind, "unsupported");
  });
});

test("rejects Windows prefixes requiring shell expansion or metacharacters", () => {
  withWindowsShim('node "%~dp0\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\n', result => {
    assert.equal(result.kind, "unsupported");
    assert.match(result.reason, /shell characters/);
  }, "prefix&unsafe");
});
