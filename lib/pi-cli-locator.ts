import fs from "fs";
import path from "path";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const PACKAGE_PARTS = ["@earendil-works", "pi-coding-agent"];

export interface PiCliLocation {
  kind: "npm-global";
  launcherPath: string;
  npmBinPath: string;
  prefix: string;
  packageDir: string;
  entrypoint: string;
}
export interface PiCliNotFound { kind: "not-found" }
export interface PiCliUnsupported { kind: "unsupported"; launcherPath: string; reason: string }
export type PiCliResolution = PiCliLocation | PiCliNotFound | PiCliUnsupported;
export interface LocateOptions { env?: NodeJS.ProcessEnv; platform?: string }

/** Keep the first existing PATH entry, including broken links, to fail closed on ambiguous launchers. */
export function findPiInPath(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string | null {
  const windows = platform === "win32";
  const key = windows ? Object.keys(env).find(k => k.toUpperCase() === "PATH") ?? "PATH" : "PATH";
  if (env[key] === undefined) return null;
  const extensions = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map(ext => ext.toLowerCase())
    : [""];
  for (const rawDir of env[key]!.split(windows ? ";" : ":")) {
    const dir = rawDir.replace(/^"(.*)"$/, "$1") || ".";
    for (const ext of extensions) {
      const candidate = path.resolve(dir, `pi${ext}`);
      try {
        const info = fs.lstatSync(candidate);
        if (info.isSymbolicLink() || info.isFile()) return candidate;
      } catch { /* Continue searching only when this PATH entry does not exist. */ }
    }
  }
  return null;
}

function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validatePackage(packageDir: string): { entrypoint: string; bin: string } {
  // A linked package can belong to pnpm, npm link, or a source checkout: never convert it to an npm install.
  if (fs.realpathSync(packageDir) !== path.resolve(packageDir)) throw new Error("Package directory is linked outside the npm global layout");
  if (packageDir.split(path.sep).some(part => [".pnpm", "_npx", "pnpm-store"].includes(part))) {
    throw new Error("Package belongs to pnpm or a temporary npx cache");
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  if (pkg?.name !== PACKAGE_NAME) throw new Error(`Package name does not match ${PACKAGE_NAME}`);
  const bin = pkg?.bin?.pi;
  if (typeof bin !== "string" || !bin || path.isAbsolute(bin)) throw new Error("Package manifest does not define a relative bin.pi");
  const entrypoint = path.resolve(packageDir, bin);
  if (!contained(packageDir, entrypoint)) throw new Error("Package bin.pi escapes the package boundary");
  if (!fs.statSync(entrypoint).isFile()) throw new Error("CLI entrypoint is not a regular file");
  if (!contained(packageDir, fs.realpathSync(entrypoint))) throw new Error("CLI entrypoint realpath escapes the package boundary");
  return { entrypoint, bin };
}

function resolvePosix(launcherPath: string): PiCliLocation {
  if (!fs.lstatSync(launcherPath).isSymbolicLink()) throw new Error("Executable is a regular file/wrapper script, not an npm global symlink");
  const visited = new Set<string>();
  let current = launcherPath;
  let lastReason = "The executable is not a recognized npm global installation";
  for (let hop = 0; hop < 30; hop++) {
    if (visited.has(current)) throw new Error("Symlink cycle detected");
    visited.add(current);
    if (path.basename(path.dirname(current)) === ".bin") throw new Error("Executable is located in local node_modules/.bin");
    let info: fs.Stats;
    try { info = fs.lstatSync(current); }
    catch { throw new Error(lastReason === "The executable is not a recognized npm global installation" ? "The launcher symlink target does not exist or is broken" : lastReason); }
    if (!info.isSymbolicLink()) break;
    const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
    if (path.basename(path.dirname(current)) === "bin") {
      const prefix = fs.realpathSync(path.dirname(path.dirname(current)));
      const packageDir = path.join(prefix, "lib", "node_modules", ...PACKAGE_PARTS);
      try {
        const { entrypoint } = validatePackage(packageDir);
        if (fs.realpathSync(target) === fs.realpathSync(entrypoint)) {
          fs.accessSync(entrypoint, fs.constants.X_OK);
          return { kind: "npm-global", launcherPath, npmBinPath: current, prefix, packageDir, entrypoint };
        }
      } catch (error) { lastReason = error instanceof Error ? error.message : "Cannot validate npm global installation"; }
    }
    current = target;
  }
  throw new Error(lastReason);
}

function resolveWindows(launcherPath: string): PiCliLocation {
  const npmBinPath = fs.realpathSync(launcherPath);
  if (!/\.cmd$/i.test(npmBinPath)) throw new Error("Only a standard npm pi.cmd shim is supported on Windows; use the original installer otherwise");
  const prefix = fs.realpathSync(path.dirname(npmBinPath));
  // Prefix is passed to npm.cmd using the existing Windows shell mechanism: reject shell expansion/metacharacters.
  if (/[\r\n%!*"^&|<>]/.test(prefix)) throw new Error("npm prefix contains unsupported Windows shell characters");
  const packageDir = path.join(prefix, "node_modules", ...PACKAGE_PARTS);
  const { entrypoint } = validatePackage(packageDir);
  const content = fs.readFileSync(npmBinPath, "utf8").split(/\r?\n/)
    .filter(line => !/^\s*(?:@?rem(?:\s|$)|::|@?echo(?:\s|$))/i.test(line)).join("\n");
  // Match the executable argument of npm's batch shim, not a comment, echo, or arbitrary absolute wrapper target.
  const targets = [...content.matchAll(/(?:"(?:%_prog%|%~dp0[\\/]node\.exe|%~dp0%[\\/]node\.exe)"|\bnode)\s+"(?:%dp0%|%~dp0%?)[\\/]([^"\r\n]+)"\s+%\*/gi)];
  const invokesEntrypoint = targets.some(match => {
    const relative = match[1].replace(/[\\/]/g, path.sep);
    return path.resolve(prefix, relative).toLowerCase() === entrypoint.toLowerCase();
  });
  if (!invokesEntrypoint) throw new Error("Windows shim does not invoke the verified npm package entrypoint");
  return { kind: "npm-global", launcherPath, npmBinPath, prefix, packageDir, entrypoint };
}

/** Discover the installation used by PATH without running Pi/npm, rewriting launchers, or reading credentials. */
export function locateGlobalPiCli(options: LocateOptions = {}): PiCliResolution {
  const platform = options.platform ?? process.platform;
  const launcherPath = findPiInPath(options.env ?? process.env, platform);
  if (!launcherPath) return { kind: "not-found" };
  try {
    return platform === "win32" ? resolveWindows(launcherPath) : resolvePosix(launcherPath);
  } catch (error) {
    return { kind: "unsupported", launcherPath, reason: error instanceof Error ? error.message : "Cannot verify npm global installation" };
  }
}
