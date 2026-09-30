import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { SshHostEntry } from "./ssh-hosts";

/**
 * Command construction + process helpers for SSH remote directories.
 *
 * Two backends are supported on Windows, both provided by the optional
 * SSHFS-Win package (https://github.com/winfsp/sshfs-win):
 *  - `sshfs.exe` (preferred, supports a per-host IdentityFile)
 *  - the `\\sshfs.k*` UNC provider via `net use` (default keys only)
 *
 * All functions that build command arguments are pure so they can be unit
 * tested without a remote host.
 */

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  stdinText?: string,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: Omit<CommandResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ code: null, timedOut: false, spawnError: String(error) }));
    child.on("close", (code) => finish({ code, timedOut: false }));
    if (stdinText !== undefined) {
      try {
        child.stdin?.write(stdinText);
        child.stdin?.end();
      } catch { /* process already closed stdin */ }
    }
  });
}

/** `ssh` probe args: key-only auth, fail fast, marker output on success. */
export function buildSshTestArgs(host: Pick<SshHostEntry, "host" | "port" | "user" | "identityFile">): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", String(host.port),
  ];
  if (host.identityFile) args.push("-i", host.identityFile, "-o", "IdentitiesOnly=yes");
  args.push(`${host.user}@${host.host}`, "echo __pi_ssh_ok__");
  return args;
}

export const SSH_TEST_MARKER = "__pi_ssh_ok__";

/** Probe a password-auth host via the ssh2 library (no system ssh involved). */
export async function testSshPasswordAuth(
  host: Pick<SshHostEntry, "host" | "port" | "user">,
  password: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { Client } = await import("ssh2");
    return await new Promise((resolve) => {
      const client = new Client();
      const timer = setTimeout(() => {
        client.end();
        resolve({ ok: false, error: `Connection timed out (${Math.round(timeoutMs / 1000)}s)` });
      }, timeoutMs);
      client
        .on("ready", () => {
          clearTimeout(timer);
          client.end();
          resolve({ ok: true });
        })
        .on("error", (error) => {
          clearTimeout(timer);
          const message = error instanceof Error ? error.message : String(error);
          resolve({ ok: false, error: message });
        })
        .connect({
          host: host.host,
          port: host.port,
          username: host.user,
          password,
          readyTimeout: Math.round(timeoutMs * 0.7),
        });
    });
  } catch (error) {
    return { ok: false, error: `ssh2 unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface RemotePathParts {
  /** true when the path must be resolved from the remote filesystem root. */
  absolute: boolean;
  /** Normalized remote path without a leading "~" (home-relative) or "/" duplicated. */
  path: string;
}

/** Rejects characters that would break UNC/sshfs argument syntax. */
export function parseRemotePath(input: string): RemotePathParts | null {
  const trimmed = input.trim();
  if (/[\\,!]/.test(trimmed)) return null;
  if (trimmed === "" || trimmed === "~" || trimmed === "~/") return { absolute: false, path: "" };
  if (/^~\/[\x20-\x7E]+$/.test(trimmed)) return { absolute: false, path: trimmed.slice(2) };
  if (/^\/[\x20-\x7E]*$/.test(trimmed)) return { absolute: true, path: trimmed.replace(/\/+$/, "") };
  if (/^[\x20-\x7E]+$/.test(trimmed)) return { absolute: false, path: trimmed };
  return null;
}

/**
 * UNC target for `net use` (sshfs-win provider syntax):
 *   \\sshfs.k\user@host!port\path   (key auth, home-relative)
 *   \\sshfs.kr\user@host!port\path  (key auth, root-relative)
 */
export function buildUncTarget(
  host: Pick<SshHostEntry, "host" | "port" | "user">,
  parts: RemotePathParts,
): string {
  const provider = parts.absolute ? "sshfs.kr" : "sshfs.k";
  const base = `\\\\${provider}\\${host.user}@${host.host}${host.port === 22 ? "" : `!${host.port}`}`;
  const suffix = parts.path.replace(/^\/+/, "").replace(/\//g, "\\");
  return suffix ? `${base}\\${suffix}` : base;
}

/** Argument vector for the standalone sshfs.exe binary. */
export function buildSshfsArgs(
  host: Pick<SshHostEntry, "host" | "port" | "user" | "identityFile">,
  parts: RemotePathParts,
  driveLetter: string,
): string[] {
  const remote = parts.absolute
    ? `${host.user}@${host.host}:${parts.path || "/"}`
    : `${host.user}@${host.host}:${parts.path}`;
  const options = ["idmap=user", `port=${host.port}`, "reconnect"];
  if (host.identityFile) options.push(`IdentityFile=${host.identityFile.replace(/\//g, "\\")}`);
  return ["-o", options.join(","), remote, `${driveLetter}:`];
}

/** UNC target for password auth (`\\sshfs\` prefix — credentials via net use). */
export function buildPasswordUncTarget(
  host: Pick<SshHostEntry, "host" | "port" | "user">,
  parts: RemotePathParts,
): string {
  const provider = parts.absolute ? "sshfs.r" : "sshfs";
  const base = `\\${provider}\\${host.user}@${host.host}${host.port === 22 ? "" : `!${host.port}`}`;
  const suffix = parts.path.replace(/^\/+/, "").replace(/\//g, "\\");
  return suffix ? `${base}\\${suffix}` : base;
}

/** `net use` argument vector that carries the credentials for password auth. */
export function buildPasswordNetUseArgs(uncTarget: string, user: string, password: string, driveLetter: string): string[] {
  return ["use", `${driveLetter}:`, uncTarget, password, `/user:${user}`, "/persistent:no"];
}

export function findFreeDriveLetter(used: ReadonlySet<string>): string | null {
  for (let code = "Z".charCodeAt(0); code >= "D".charCodeAt(0); code--) {
    const letter = String.fromCharCode(code);
    if (!used.has(letter)) return letter;
  }
  return null;
}

/** Parse drive letters + UNC targets out of `net use` output. */
export function parseNetUse(output: string): { letter: string; remote: string }[] {
  const result: { letter: string; remote: string }[] = [];
  for (const line of output.split(/\r?\n/)) {
    // Status column word is optional and locale-dependent (OK / 成功 / …).
    const match = line.match(/^\s*(?:\S+\s+)?([A-Z]):\s+(\\\\\S+)/i);
    if (match) result.push({ letter: match[1].toUpperCase(), remote: match[2] });
  }
  return result;
}

export const SSHFS_INSTALL_DIRS = [
  "C:\\Program Files\\SSHFS-Win\\bin\\sshfs.exe",
  "C:\\Program Files (x86)\\SSHFS-Win\\bin\\sshfs.exe",
];

export function findSshfsBinary(candidates: string[] = SSHFS_INSTALL_DIRS): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** sshfs.exe args for password auth: the password is piped via stdin. */
export function buildSshfsPasswordArgs(
  host: Pick<SshHostEntry, "host" | "port" | "user">,
  parts: RemotePathParts,
  driveLetter: string,
): string[] {
  const remote = parts.absolute
    ? `${host.user}@${host.host}:${parts.path || "/"}`
    : `${host.user}@${host.host}:${parts.path}`;
  const options = ["idmap=user", `port=${host.port}`, "reconnect", "password_stdin"];
  return ["-o", options.join(","), remote, `${driveLetter}:`];
}

export function hasSshfsWinInstalled(
  installDirs: string[] = ["C:\\Program Files\\SSHFS-Win", "C:\\Program Files (x86)\\SSHFS-Win"],
): boolean {
  return installDirs.some((dir) => existsSync(dir));
}
