import { execSync, spawn } from "child_process";
import fs from "fs";
import path from "path";
import { isNewerStableVersion } from "./app-update";

export interface GitRepoInfo {
  name: string;
  url: string;
  issuesUrl: string;
  releasesUrl: string;
}

export interface PiAgentVersionInfo {
  packageName: string;
  packageUrl: string;
  installedVersion: string | null;
  cliVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number;
  error?: string;
}

export interface SystemRuntimeInfo {
  nodeVersion: string;
  platform: string;
  arch: string;
  cwd: string;
}

export interface AboutInfoResponse {
  appName: string;
  appVersion: string;
  isDesktop: boolean;
  gitRepo: GitRepoInfo;
  piAgent: PiAgentVersionInfo;
  system: SystemRuntimeInfo;
}

export interface UpdatePiAgentRequest {
  target?: "global" | "local";
}

export interface UpdatePiAgentResponse {
  success: boolean;
  output: string;
  error?: string;
  previousVersion: string | null;
  newVersion: string | null;
  target: "global" | "local";
}

const NPM_REGISTRY_URL = "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest";
const NPM_MIRROR_URL = "https://registry.npmmirror.com/@earendil-works%2Fpi-coding-agent/latest";
const FETCH_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface LatestVersionCache {
  version: string | null;
  timestamp: number;
  error?: string;
}

let latestVersionCache: LatestVersionCache | null = null;

function getRootPackageJson(): { version?: string; repository?: unknown } | null {
  try {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string; repository?: unknown };
    }
  } catch {
    // ignore
  }
  return null;
}

export function getAppVersion(): string {
  if (process.env.NEXT_PUBLIC_APP_VERSION) {
    return process.env.NEXT_PUBLIC_APP_VERSION;
  }
  const rootPkg = getRootPackageJson();
  return rootPkg?.version ?? "0.9.10";
}

export function getPiAgentInstalledVersion(): string | null {
  const candidatePaths = [
    path.join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    path.join(__dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    path.join(process.cwd(), "server", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
  ];

  for (const pkgPath of candidatePaths) {
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    } catch {
      // try next
    }
  }

  // Fallback to environment variable if defined during build
  if (process.env.NEXT_PUBLIC_PI_VERSION && process.env.NEXT_PUBLIC_PI_VERSION !== "unknown") {
    return process.env.NEXT_PUBLIC_PI_VERSION;
  }

  // Fallback to package.json dependency specification
  try {
    const rootPkgPath = path.join(process.cwd(), "package.json");
    if (fs.existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const dep = rootPkg.dependencies?.["@earendil-works/pi-coding-agent"];
      if (dep) return dep.replace(/^[\^~]/, "");
    }
  } catch {
    // ignore
  }

  return null;
}

export function getPiAgentCliVersion(): string | null {
  try {
    const stdout = execSync("pi --version", {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = stdout.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

export async function fetchLatestPiAgentVersion(force = false): Promise<{
  latestVersion: string | null;
  error?: string;
}> {
  const now = Date.now();
  if (!force && latestVersionCache && now - latestVersionCache.timestamp < CACHE_TTL_MS) {
    return {
      latestVersion: latestVersionCache.version,
      error: latestVersionCache.error,
    };
  }

  // Attempt official npm registry first, then fallback to npmmirror
  const registries = [NPM_REGISTRY_URL, NPM_MIRROR_URL];
  let lastError: string | undefined;

  for (const registryUrl of registries) {
    try {
      const response = await fetch(registryUrl, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = (await response.json()) as { version?: unknown };
        if (typeof data.version === "string" && data.version) {
          latestVersionCache = {
            version: data.version,
            timestamp: now,
          };
          return { latestVersion: data.version };
        }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  latestVersionCache = {
    version: latestVersionCache?.version ?? null,
    timestamp: now,
    error: lastError,
  };

  return {
    latestVersion: latestVersionCache.version,
    error: lastError,
  };
}

export async function getAboutInfo(forceCheck = false): Promise<AboutInfoResponse> {
  const isDesktop = process.env.PI_WEB_DESKTOP === "1";
  const appVersion = getAppVersion();
  const installedVersion = getPiAgentInstalledVersion();
  const cliVersion = getPiAgentCliVersion();

  const { latestVersion, error: fetchError } = await fetchLatestPiAgentVersion(forceCheck);

  // Check if update is available: compare latest against installed or CLI
  let updateAvailable = false;
  if (latestVersion) {
    const compareVersion = cliVersion ?? installedVersion;
    if (compareVersion) {
      updateAvailable = isNewerStableVersion(latestVersion, compareVersion);
    }
  }

  const gitRepo: GitRepoInfo = {
    name: "ghost0211/pi-web",
    url: "https://github.com/ghost0211/pi-web",
    issuesUrl: "https://github.com/ghost0211/pi-web/issues",
    releasesUrl: "https://github.com/ghost0211/pi-web/releases",
  };

  const piAgent: PiAgentVersionInfo = {
    packageName: "@earendil-works/pi-coding-agent",
    packageUrl: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
    installedVersion,
    cliVersion,
    latestVersion,
    updateAvailable,
    lastCheckedAt: latestVersionCache?.timestamp ?? Date.now(),
    error: fetchError,
  };

  const system: SystemRuntimeInfo = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd: process.cwd(),
  };

  return {
    appName: isDesktop ? "Pi Web Desktop" : "Pi Web",
    appVersion,
    isDesktop,
    gitRepo,
    piAgent,
    system,
  };
}

export function executePiAgentUpdate(target: "global" | "local" = "global"): Promise<UpdatePiAgentResponse> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const npmCmd = isWindows ? "npm.cmd" : "npm";
    const previousCli = getPiAgentCliVersion();
    const previousInstalled = getPiAgentInstalledVersion();
    const previousVersion = target === "global" ? previousCli : previousInstalled;

    const args: string[] = [];
    const execCwd = process.cwd();

    if (target === "global") {
      args.push("install", "-g", "@earendil-works/pi-coding-agent@latest");
    } else {
      args.push(
        "install",
        "@earendil-works/pi-coding-agent@latest",
        "@earendil-works/pi-agent-core@latest",
        "@earendil-works/pi-ai@latest",
        "@earendil-works/pi-tui@latest",
      );
      // If running inside desktop or subdirectory without package.json, verify cwd
      if (!fs.existsSync(path.join(execCwd, "package.json"))) {
        resolve({
          success: false,
          output: `Cannot find package.json in ${execCwd} to perform local update.`,
          error: "package.json not found",
          previousVersion,
          newVersion: previousVersion,
          target,
        });
        return;
      }
    }

    let stdoutData = "";
    let stderrData = "";

    const proc = spawn(npmCmd, args, {
      cwd: execCwd,
      shell: isWindows,
      env: { ...process.env },
    });

    const timeoutTimer = setTimeout(() => {
      proc.kill();
      resolve({
        success: false,
        output: `${stdoutData}\n${stderrData}\nCommand timed out after 180s.`.trim(),
        error: "Update process timed out",
        previousVersion,
        newVersion: target === "global" ? getPiAgentCliVersion() : getPiAgentInstalledVersion(),
        target,
      });
    }, 180_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutTimer);
      resolve({
        success: false,
        output: `${stdoutData}\n${stderrData}\nError: ${err.message}`.trim(),
        error: err.message,
        previousVersion,
        newVersion: target === "global" ? getPiAgentCliVersion() : getPiAgentInstalledVersion(),
        target,
      });
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutTimer);
      const combinedOutput = `${stdoutData}\n${stderrData}`.trim();
      const newVersion = target === "global" ? getPiAgentCliVersion() : getPiAgentInstalledVersion();
      
      // Invalidate the cache after update
      latestVersionCache = null;

      if (code === 0) {
        resolve({
          success: true,
          output: combinedOutput || "Update completed successfully.",
          previousVersion,
          newVersion,
          target,
        });
      } else {
        resolve({
          success: false,
          output: combinedOutput || `npm exited with code ${code}`,
          error: `Process exited with code ${code}`,
          previousVersion,
          newVersion,
          target,
        });
      }
    });
  });
}
