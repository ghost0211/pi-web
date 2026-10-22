#!/usr/bin/env node
/**
 * Assembles the Tauri sidecar payload under `src-tauri/`:
 *
 *   src-tauri/server/  Next.js standalone build (server.js + traced node_modules
 *                      + .next/static + public/)
 *   src-tauri/node/    Bundled Node.js runtime for the *current* platform:
 *                      `node.exe` on Windows, `bin/node` on macOS/Linux
 *
 * `bundle.resources` lists both directories (list form — deliberately not the
 * map form, whose path handling regressed in Tauri CLI 2.11, see tauri-apps
 * issue #15342), so they land at `<install>/server` and `<install>/node`,
 * where `src-tauri/src/main.rs` spawns `node[.exe] server.js` at runtime.
 *
 * The Node archive is chosen from `process.platform`/`process.arch`, so this
 * script must run on the target platform (CI: windows-latest / ubuntu-latest).
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
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  assertServerOutputMirrored,
  validatePiAiOAuthModules,
  validatePiCodemodeAssets,
  validatePiDocs,
  validatePiDynamicWorkers,
  validatePiRuntimePackages,
  validatePiWasmAssets,
} from "./desktop-bundle-validation.mjs";

const DESKTOP_NODE_VERSION = "22.19.0";

/** Node.js distribution archive for the current build platform. */
function nodeDistribution() {
  const arch = process.arch;
  const platform = process.platform;
  if (platform === "win32" && arch === "x64") {
    return { name: `node-v${DESKTOP_NODE_VERSION}-win-x64.zip`, kind: "zip", nested: false };
  }
  if (platform === "darwin" && (arch === "x64" || arch === "arm64")) {
    return { name: `node-v${DESKTOP_NODE_VERSION}-darwin-${arch}.tar.gz`, kind: "tar", nested: true };
  }
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    return { name: `node-v${DESKTOP_NODE_VERSION}-linux-${arch}.tar.xz`, kind: "tar", nested: true };
  }
  fail(`unsupported desktop platform for the bundled Node runtime: ${platform}/${arch}`);
}

/** Path (relative to `src-tauri/node`) of the Node binary the shell spawns. */
function bundledNodeBinaryRelativePath() {
  return process.platform === "win32" ? "node.exe" : "bin/node";
}

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
  if (process.env.PI_DESKTOP_SKIP_SERVER_COPY === "1") {
    console.log("build-desktop-server: keeping existing src-tauri/server (PI_DESKTOP_SKIP_SERVER_COPY=1)");
    return;
  }
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

  // The standalone trace is a subset of the build output. It can omit async
  // chunks that only the instrumentation hook imports at startup: v0.9.68
  // shipped without `chunks/<id>.js` and every request 500'd on
  // MODULE_NOT_FOUND. Overlay the complete server output, then prove it.
  cpSync(join(nextDir, "server"), join(serverResourceDir, ".next", "server"), {
    recursive: true,
    force: true,
  });
  try {
    const mirrored = assertServerOutputMirrored(
      join(nextDir, "server"),
      join(serverResourceDir, ".next", "server"),
    );
    console.log(`build-desktop-server: .next/server mirrored (${mirrored} files)`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  // A byte-for-byte copy is necessary but not sufficient: the hook loads an
  // async chunk through the webpack runtime at startup, which is exactly what
  // the v0.9.68 bundle got wrong while every file it *did* copy matched. Boot
  // the packaged server and call a real API route before the installer exists.
  try {
    run(process.execPath, [join(repoRoot, "scripts", "desktop-server-smoke.mjs"), serverResourceDir]);
  } catch (error) {
    fail(`packaged server failed its startup smoke: ${error instanceof Error ? error.message : String(error)}`);
  }

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

  // Validate against the source installation layout, not just copies that
  // happened to reach the bundle. Otherwise a complete top-level pi-ai could
  // hide a wholly missing nested runtime (the openai-codex desktop regression).
  try {
    validatePiAiOAuthModules({
      sourceNodeModulesDir: join(repoRoot, "node_modules"),
      bundleNodeModulesDir: join(serverResourceDir, "node_modules"),
    });
    validatePiCodemodeAssets({
      sourceNodeModulesDir: join(repoRoot, "node_modules"),
      bundleNodeModulesDir: join(serverResourceDir, "node_modules"),
    });
    validatePiDynamicWorkers({
      sourceNodeModulesDir: join(repoRoot, "node_modules"),
      bundleNodeModulesDir: join(serverResourceDir, "node_modules"),
    });
    validatePiDocs({
      sourceNodeModulesDir: join(repoRoot, "node_modules"),
      bundleNodeModulesDir: join(serverResourceDir, "node_modules"),
    });
    validatePiWasmAssets({
      sourceNodeModulesDir: join(repoRoot, "node_modules"),
      bundleNodeModulesDir: join(serverResourceDir, "node_modules"),
    });
    validatePiRuntimePackages({
      sourceNodeModulesDir: join(repoRoot, "node_modules"),
      bundleNodeModulesDir: join(serverResourceDir, "node_modules"),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  pruneForeignNativeModules();
  console.log(`build-desktop-server: server bundle ready (${formatMiB(dirSize(serverResourceDir))})`);
}

/**
 * Drop platform-specific native Node addons that do not match the build
 * target. `@img/sharp-*` ships one package per platform; the
 * `linuxmusl-x64` build links against musl libc (`libc.musl-x86_64.so.1`),
 * which is absent on a glibc distro, so linuxdeploy fails AppImage bundling
 * with `Could not find dependency: libc.musl-x86_64.so.1`. The musl build is
 * never loaded at runtime on Ubuntu — sharp picks the matching glibc
 * (`linux-x64`) addon — so it is safe to drop. Likewise we can drop the
 * win32/darwin addons when building for Linux and vice versa.
 */
function pruneForeignNativeModules() {
  const imgDir = join(serverResourceDir, "node_modules", "@img");
  if (!existsSync(imgDir)) return;
  const keep = {
    linux: ["sharp-linux-x64", "sharp-libvips-linux-x64"],
    win32: ["sharp-win32-x64"],
    darwin: ["sharp-darwin-arm64", "sharp-libvips-darwin-arm64"],
  }[process.platform];
  if (!keep) return;
  for (const entry of readdirSync(imgDir)) {
    if (keep.includes(entry)) continue;
    rmSync(join(imgDir, entry), { recursive: true, force: true });
    console.log(`build-desktop-server: pruned @img/${entry} (foreign to ${process.platform})`);
  }
  // Verify we never shipped a musl-native module into a glibc (Linux desktop)
  // bundle — linuxdeploy cannot resolve libc.musl and the AppImage fails.
  const musl = join(serverResourceDir, "node_modules", "@img", "sharp-linuxmusl-x64");
  if (existsSync(musl)) fail(`musl sharp module still present at ${musl}`);
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`GET ${url} -> HTTP ${response.status}`);
  await pipeline(response.body, createWriteStream(dest));
}

function extractArchive(archivePath, destDir) {
  // Zip: bsdtar (ships with Windows 10+ and macOS) reads zip files; GNU tar does
  // not, so fall back to unzip / PowerShell where needed.
  const isZip = archivePath.endsWith(".zip");
  const attempts = isZip
    ? [
        ["tar", ["-xf", archivePath, "-C", destDir]],
        ["unzip", ["-q", archivePath, "-d", destDir]],
        [
          "powershell",
          ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}'`],
        ],
      ]
    : [["tar", ["-xf", archivePath, "-C", destDir]]];
  let lastError;
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (!result.error && result.status === 0) return;
    lastError = result.error ?? new Error(`${command} exited with ${result.status}`);
  }
  throw lastError;
}

async function ensureNodeRuntime() {
  const nodeBinary = join(nodeResourceDir, bundledNodeBinaryRelativePath());
  const versionFile = join(nodeResourceDir, ".node-version");
  if (
    existsSync(nodeBinary)
    && existsSync(versionFile)
    && readFileSync(versionFile, "utf8").trim() === DESKTOP_NODE_VERSION
  ) {
    console.log(`build-desktop-server: node runtime v${DESKTOP_NODE_VERSION} already present`);
    return;
  }

  const distribution = nodeDistribution();
  const distBase = `https://nodejs.org/dist/v${DESKTOP_NODE_VERSION}`;
  const workDir = mkdtempSync(join(tmpdir(), "pi-web-node-"));
  const archivePath = join(workDir, distribution.name);

  try {
    console.log(`build-desktop-server: downloading ${distribution.name}…`);
    await download(`${distBase}/${distribution.name}`, archivePath);
    await download(`${distBase}/SHASUMS256.txt`, join(workDir, "SHASUMS256.txt"));

    const expected = readFileSync(join(workDir, "SHASUMS256.txt"), "utf8")
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === distribution.name)?.[0];
    if (!expected) fail(`SHASUMS256.txt has no entry for ${distribution.name}`);
    const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    if (actual !== expected) {
      fail(`sha256 mismatch for ${distribution.name}: expected ${expected}, got ${actual}`);
    }

    const extractDir = join(workDir, "extract");
    mkdirSync(extractDir);
    extractArchive(archivePath, extractDir);

    rmSync(nodeResourceDir, { recursive: true, force: true });
    mkdirSync(nodeResourceDir, { recursive: true });
    const extractedRoot = join(extractDir, distribution.name.replace(/\.(zip|tar\.(gz|xz))$/, ""));
    if (process.env.PI_DESKTOP_SKIP_NODE_COPY === "1") {
      console.log(`build-desktop-server: archive extracted at ${extractedRoot} (PI_DESKTOP_SKIP_NODE_COPY=1)`);
    } else {
      cpSync(extractedRoot, nodeResourceDir, { recursive: true });
      // The POSIX Node distribution ships `bin/npm`, `bin/npx` and
      // `bin/corepack` as symlinks into `../lib/node_modules/...`. Materialize
      // them as real files — both Tauri's resource expander and any statSync()
      // walk fail on the dangling/absolute links a verbatim copy leaves behind.
      materializeSymlinks(nodeResourceDir);
      // A copy over a filesystem boundary can drop the executable bit on POSIX.
      if (process.platform !== "win32") chmodSync(nodeBinary, 0o755);
      writeFileSync(versionFile, `${DESKTOP_NODE_VERSION}\n`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }

  if (process.env.PI_DESKTOP_SKIP_NODE_COPY !== "1" && !existsSync(nodeBinary)) {
    fail(`${bundledNodeBinaryRelativePath()} missing after extracting ${distribution.name}`);
  }
  if (process.env.PI_DESKTOP_SKIP_NODE_COPY === "1") {
    console.log(`build-desktop-server: node runtime v${DESKTOP_NODE_VERSION} extracted (PI_DESKTOP_SKIP_NODE_COPY=1)`);
  } else {
    console.log(
      `build-desktop-server: node runtime v${DESKTOP_NODE_VERSION} ready (${formatMiB(dirSize(nodeResourceDir))})`,
    );
  }
}

/** Regenerate only the bundle.resources manifest (skips the next build). */
const onlyResourceManifest = process.env.PI_DESKTOP_ONLY_RESOURCE_MANIFEST === "1";
if (onlyResourceManifest) {
  writeResourceManifest();
  console.log("build-desktop-server: resource manifest ready (PI_DESKTOP_ONLY_RESOURCE_MANIFEST=1)");
} else if (process.env.PI_DESKTOP_ONLY_NODE_RUNTIME === "1") {
  // CI/local probes exercise the runtime download without a Next build.
  await ensureNodeRuntime();
  console.log("build-desktop-server: node runtime ready (PI_DESKTOP_ONLY_NODE_RUNTIME=1)");
} else {
  buildNextApp();
  copyStandaloneServer();
  await ensureNodeRuntime();
  writeResourceManifest();
  console.log("build-desktop-server: done");
}

/**
 * Tauri's resource expander treats a trailing-slash directory as a recursive
 * copy and chokes on the symlinks inside a POSIX Node distribution
 * (`node/bin/npm` -> `../lib/node_modules/npm/bin/npm-cli.js`), failing the
 * whole build with `resource path 'node/bin/corepack' doesn't exist`. Instead
 * we enumerate the payload files ourselves and point `bundle.resources` at the
 * individual paths, which Tauri copies verbatim (dereferencing symlinks into
 * regular files).
 *
 * The manifest is written back into `tauri.conf.json` on every build so the
 * resource list always matches the platform's payload. The checked-in
 * `resources` array is a placeholder that this function replaces.
 */
/**
 * Replace every symlink under `root` with a real copy of its target. The POSIX
 * Node distribution ships `bin/npm`, `bin/npx` and `bin/corepack` as symlinks
 * into `../lib/node_modules/...`; a verbatim copy leaves links that Tauri's
 * resource expander and any statSync() walk cannot follow. Targets are resolved
 * relative to the link's directory, with a fallback that re-anchors an absolute
 * target (e.g. pointing at the now-deleted extraction dir) back under `root`.
 */
function materializeSymlinks(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const linkTarget = readlinkSync(full);
      let source = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(full), linkTarget);
      if (!existsSync(source)) {
        // Re-anchor: find the `node-v<ver>-<platform>/` segment of the absolute
        // target and map the remainder back under the copied tree.
        const match = linkTarget.match(/node-v[\d.]+-[a-z]+-[a-z0-9]+[\\/](.+)$/i);
        if (match) source = join(root, match[1].split("/").join(sep));
      }
      rmSync(full, { force: true });
      if (existsSync(source)) {
        copyFileSync(source, full);
        try { chmodSync(full, statSync(source).mode); } catch { /* best effort */ }
      }
      continue;
    }
    if (entry.isDirectory()) materializeSymlinks(full);
  }
}

function listFilesRecursive(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    // Resolve through statSync so a symlink to a directory is materialized as
    // its target tree; a dangling symlink is skipped rather than crashing the
    // whole manifest.
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

function writeResourceManifest() {
  const tauriRoot = join(repoRoot, "src-tauri");
  const configPath = join(tauriRoot, "tauri.conf.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const files = [
    ...listFilesRecursive(serverResourceDir),
    ...listFilesRecursive(nodeResourceDir),
  ].map((file) => relative(tauriRoot, file).split(sep).join("/"));
  if (!files.some((file) => file === `node/${bundledNodeBinaryRelativePath().replace(/\\/g, "/")}`)) {
    fail(`resource manifest is missing node/${bundledNodeBinaryRelativePath()}`);
  }
  // server/server.js is produced by copyStandaloneServer(); when it is absent
  // (e.g. a manifest-only probe on a machine without a build) we still write
  // the node manifest, but warn so a real build never ships without it.
  if (!files.some((file) => file === "server/server.js")) {
    console.warn("build-desktop-server: warning: server/server.js not present; the bundle will lack the web server");
  }
  config.bundle.resources = files;
  // The manifest is per-platform and regenerated by beforeBuildCommand on every
  // build; keep the working tree stable by restoring the placeholder after a
  // manifest-only probe. Real builds leave the expanded list in place for the
  // bundler, which is exactly what it must read.
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`build-desktop-server: resource manifest written (${files.length} files)`);
  return files;
}

