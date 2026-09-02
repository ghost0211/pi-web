#!/usr/bin/env node
/**
 * Assembles the Tauri sidecar payload under `src-tauri/`:
 *
 *   src-tauri/server/  Next.js standalone build (server.js + traced node_modules
 *                      + .next/static + public/)
 *   src-tauri/node/    Windows Node.js runtime (node.exe, npm, npx, corepack)
 *
 * `bundle.resources` lists both directories (list form — deliberately not the
 * map form, whose path handling regressed in Tauri CLI 2.11, see tauri-apps
 * issue #15342), so they land at `<install>/server` and `<install>/node`,
 * where `src-tauri/src/main.rs` spawns `node.exe server.js` at runtime.
 *
 * Usage:
 *   node scripts/build-desktop-server.mjs          # full build
 *   PI_DESKTOP_SKIP_NEXT_BUILD=1 node ...          # reuse an existing .next/
 *
 * Bump DESKTOP_NODE_VERSION when the Node floor in package.json "engines" moves.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DESKTOP_NODE_VERSION = "22.19.0";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nextDir = join(repoRoot, ".next");
const standaloneDir = join(nextDir, "standalone");
const serverResourceDir = join(repoRoot, "src-tauri", "server");
const nodeResourceDir = join(repoRoot, "src-tauri", "node");

function fail(message) {
  console.error(`build-desktop-server: ${message}`);
  process.exit(1);
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const p = join(current, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) total += statSync(p).size;
    }
  }
  return total;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function resolveNextBin() {
  // Same resolution strategy as bin/pi-web.js.
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("next/dist/bin/next", { paths: [repoRoot] });
  } catch {
    try {
      const nextPkg = require.resolve("next/package.json", { paths: [repoRoot] });
      return join(dirname(nextPkg), "dist", "bin", "next");
    } catch {
      return join(repoRoot, "node_modules", "next", "dist", "bin", "next");
    }
  }
}

function buildNextApp() {
  if (process.env.PI_DESKTOP_SKIP_NEXT_BUILD === "1") {
    console.log("build-desktop-server: skipping next build (PI_DESKTOP_SKIP_NEXT_BUILD=1)");
    return;
  }
  console.log("build-desktop-server: running next build…");
  // Invoke next's CLI entry directly with the current Node. Spawning npm.cmd
  // hits EINVAL on Windows — since the CVE-2024-27980 fix, Node refuses to
  // spawn .cmd/.bat files without shell:true. Keep the args in sync with the
  // "build" script in package.json.
  run(process.execPath, [resolveNextBin(), "build", "--webpack"], {
    cwd: repoRoot,
    env: { ...process.env, PI_WEB_STANDALONE_BUILD: "1" },
  });
}

function copyStandaloneServer() {
  if (!existsSync(join(standaloneDir, "server.js"))) {
    fail(
      `${standaloneDir}/server.js not found. This script sets PI_WEB_STANDALONE_BUILD=1 ` +
        `during next build; check that next.config.ts still honors it.`,
    );
  }

  rmSync(serverResourceDir, { recursive: true, force: true });
  mkdirSync(serverResourceDir, { recursive: true });
  cpSync(standaloneDir, serverResourceDir, { recursive: true });
  cpSync(join(nextDir, "static"), join(serverResourceDir, ".next", "static"), { recursive: true });
  cpSync(join(repoRoot, "public"), join(serverResourceDir, "public"), { recursive: true });

  // Guard against the classic failure mode where serverExternalPackages are
  // missing from the standalone node_modules trace.
  const piSdk = join(serverResourceDir, "node_modules", "@earendil-works", "pi-coding-agent");
  if (!existsSync(piSdk)) {
    fail(`standalone output is missing ${piSdk} — check outputFileTracing config`);
  }
  // Canary for dynamically-pathed runtime assets that nft cannot detect
  // (regression: the SDK theme loader ENOENT'd on dark.json in the desktop
  // build). Covered by outputFileTracingIncludes in next.config.ts.
  const themeCanary = join(piSdk, "dist", "modes", "interactive", "theme", "dark.json");
  if (!existsSync(themeCanary)) {
    fail(`standalone output is missing ${themeCanary} — check outputFileTracingIncludes`);
  }
  console.log(`build-desktop-server: server bundle ready (${formatMiB(dirSize(serverResourceDir))})`);
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(dest));
}

function extractZip(zipPath, destDir) {
  // bsdtar (ships with Windows 10+ and macOS) reads zip files; GNU tar does
  // not, so fall back to unzip / PowerShell where needed.
  const attempts = [
    ["tar", ["-xf", zipPath, "-C", destDir]],
    ["unzip", ["-q", zipPath, "-d", destDir]],
    [
      "powershell",
      ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}'`],
    ],
  ];
  let lastError;
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (!result.error && result.status === 0) return;
    lastError = result.error ?? new Error(`${command} exited with ${result.status}`);
  }
  throw lastError;
}

async function ensureNodeRuntime() {
  const nodeExe = join(nodeResourceDir, "node.exe");
  const versionFile = join(nodeResourceDir, ".node-version");
  if (
    existsSync(nodeExe)
    && existsSync(versionFile)
    && readFileSync(versionFile, "utf8").trim() === DESKTOP_NODE_VERSION
  ) {
    console.log(`build-desktop-server: node runtime v${DESKTOP_NODE_VERSION} already present`);
    return;
  }

  const distBase = `https://nodejs.org/dist/v${DESKTOP_NODE_VERSION}`;
  const zipName = `node-v${DESKTOP_NODE_VERSION}-win-x64.zip`;
  const workDir = mkdtempSync(join(tmpdir(), "pi-web-node-"));
  const zipPath = join(workDir, zipName);

  try {
    console.log(`build-desktop-server: downloading ${zipName}…`);
    await download(`${distBase}/${zipName}`, zipPath);
    await download(`${distBase}/SHASUMS256.txt`, join(workDir, "SHASUMS256.txt"));

    const expected = readFileSync(join(workDir, "SHASUMS256.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === zipName)?.[0];
    if (!expected) fail(`SHASUMS256.txt has no entry for ${zipName}`);
    const actual = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
    if (actual !== expected) {
      fail(`sha256 mismatch for ${zipName}: expected ${expected}, got ${actual}`);
    }

    const extractDir = join(workDir, "extract");
    mkdirSync(extractDir);
    extractZip(zipPath, extractDir);

    rmSync(nodeResourceDir, { recursive: true, force: true });
    mkdirSync(nodeResourceDir, { recursive: true });
    cpSync(join(extractDir, `node-v${DESKTOP_NODE_VERSION}-win-x64`), nodeResourceDir, {
      recursive: true,
    });
    writeFileSync(versionFile, `${DESKTOP_NODE_VERSION}\n`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (!existsSync(nodeExe)) fail(`node.exe missing after extracting ${zipName}`);
  console.log(
    `build-desktop-server: node runtime v${DESKTOP_NODE_VERSION} ready (${formatMiB(dirSize(nodeResourceDir))})`,
  );
}

buildNextApp();
copyStandaloneServer();
await ensureNodeRuntime();
console.log("build-desktop-server: done");
