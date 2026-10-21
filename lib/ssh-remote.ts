import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isUtf8 } from "node:buffer";
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

/**
 * Decode child-process output. Windows console tools (`net.exe`, `ssh.exe`)
 * write in the OEM code page (936/GBK on zh-CN), not UTF-8, so a UTF-8 decode
 * turned "系统错误 67" into "??????§? 67" and hid the real reason.
 */
export function decodeWindowsOutput(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  if (isUtf8(buffer)) return buffer.toString("utf8");
  try {
    return new TextDecoder("gbk").decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (result: Omit<CommandResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        stdout: decodeWindowsOutput(Buffer.concat(stdout)),
        stderr: decodeWindowsOutput(Buffer.concat(stderr)),
      });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout.push(Buffer.from(chunk)); });
    child.stderr?.on("data", (chunk) => { stderr.push(Buffer.from(chunk)); });
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

/** `ssh` probe args: key-only auth, fail fast, marker output on success. */export function buildSshTestArgs(host: Pick<SshHostEntry, "host" | "port" | "user" | "identityFile">): string[] {
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

/** `ssh` args that print the remote login home behind a marker. */
export function buildSshHomeArgs(
  host: Pick<SshHostEntry, "host" | "port" | "user" | "identityFile">,
): string[] {
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", String(host.port),
  ];
  if (host.identityFile) args.push("-i", host.identityFile, "-o", "IdentitiesOnly=yes");
  args.push(`${host.user}@${host.host}`, `printf '__PI_HOME__%s\\n' "$HOME"`);
  return args;
}

export const SSH_HOME_MARKER = "__PI_HOME__";

/**
 * Resolve the remote login home so a `~`/relative path can be mounted as an
 * absolute one. Mounting the home-relative UNC provider (`\\sshfs\user@host`)
 * breaks as soon as a component of the path is a symlink that points outside
 * the home, so the mount route always uses the root-relative provider.
 */
export async function resolveRemoteHome(
  host: Pick<SshHostEntry, "host" | "port" | "user" | "identityFile">,
  password: string | undefined,
  timeoutMs = 12_000,
): Promise<string | null> {
  if (password) {
    try {
      const { Client } = await import("ssh2");
      return await new Promise<string | null>((resolve) => {
        const client = new Client();
        let settled = false;
        const finish = (value: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.end();
          resolve(value);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        client
          .on("ready", () => {
            client.exec('printf %s "$HOME"', (error, stream) => {
              if (error) {
                finish(null);
                return;
              }
              let output = "";
              stream.on("data", (chunk: Buffer) => { output += String(chunk); });
              stream.on("close", () => {
                const home = output.trim();
                finish(home.startsWith("/") ? home : null);
              });
            });
          })
          .on("error", () => finish(null))
          .connect({ host: host.host, port: host.port, username: host.user, password, readyTimeout: Math.round(timeoutMs * 0.7) });
      });
    } catch {
      return null;
    }
  }
  const result = await runCommand("ssh", buildSshHomeArgs(host), timeoutMs);
  const line = result.stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(SSH_HOME_MARKER));
  if (!line) return null;
  const home = line.slice(SSH_HOME_MARKER.length).trim();
  return home.startsWith("/") ? home : null;
}

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
 * UNC provider ROOT for `net use` (sshfs-win provider syntax).
 *
 * The provider only accepts the host root — `\\sshfs\user@host!port` — and the
 * remote path is walked *inside* the mapped drive. Putting the path into the UNC
 * name (`\\sshfs.r\user@host\home\me\project`) makes Windows fail with
 * "System error 67: The network name cannot be found", which looked like a
 * credential problem but is purely a naming restriction.
 *
 *   \\sshfs\user@host      (key/password auth, home-relative)
 *   \\sshfs.r\user@host    (key/password auth, root-relative)
 *   \\sshfs.k\user@host    (key-only auth, home-relative)
 *   \\sshfs.kr\user@host   (key-only auth, root-relative)
 */
export function buildUncRoot(
  host: Pick<SshHostEntry, "host" | "port" | "user">,
  parts: RemotePathParts,
  options: { keyAuth?: boolean } = {},
): string {
  const provider = options.keyAuth
    ? (parts.absolute ? "sshfs.kr" : "sshfs.k")
    : (parts.absolute ? "sshfs.r" : "sshfs");
  const suffix = host.port === 22 ? "" : `!${host.port}`;
  return `\\\\${provider}\\${host.user}@${host.host}${suffix}`;
}

/** Local path inside a mapped UNC drive: `Y:\home\me\project` (never `Y:\`). */
export function mappedDrivePath(driveLetter: string, parts: RemotePathParts): string {
  const segments = parts.path.replace(/^\/+/, "").split("/").filter(Boolean);
  return segments.length === 0 ? `${driveLetter}:\\` : `${driveLetter}:\\${segments.join("\\")}`;
}

/**
 * UNC target for `net use` (sshfs-win provider syntax):
 *   \\sshfs.k\user@host!port\path   (key auth, home-relative)
 *   \\sshfs.kr\user@host!port\path  (key auth, root-relative)
 *
 * Kept for reference/tests: Windows rejects a path inside the UNC name, so the
 * mount route maps `buildUncRoot` and joins the path onto the drive instead.
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
  extraOptions: string[] = [],
): string[] {
  const remote = parts.absolute
    ? `${host.user}@${host.host}:${parts.path || "/"}`
    : `${host.user}@${host.host}:${parts.path}`;
  // accept-new keeps a first-time host from blocking on a host-key prompt:
  // sshfs has no terminal here, so a prompt is an indefinite hang.
  const options = ["idmap=user", `port=${host.port}`, "reconnect", "StrictHostKeyChecking=accept-new", ...extraOptions];
  if (host.identityFile) options.push(`IdentityFile=${host.identityFile.replace(/\//g, "\\")}`);
  return ["-o", options.join(","), remote, `${driveLetter}:`];
}

export interface SshfsMountResult {
  /** The drive became available and the process was left running. */
  ready: boolean;
  /** Last stderr/stdout lines, for a precise error message. */
  detail: string;
}

function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      // `child.kill()` on Windows leaves the real worker (the ssh child) alive, so
      // a failed mount would keep its pipes open forever.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/**
 * Mount with `sshfs.exe` without waiting for it to exit.
 *
 * sshfs.exe is a long-lived FUSE/WinFsp process: it exits only when the mount
 * is unmounted. Awaiting it (the previous behavior) always ended in a timeout
 * that then killed the just-created mount, so every sshfs mount reported
 * "code ?, timed out". Readiness is observed by polling the drive instead, and
 * only a failed mount is killed.
 */
export async function startSshfsMount(params: {
  binary: string;
  args: string[];
  driveLetter: string;
  stdinText?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  probeDrive?: (driveLetter: string) => boolean;
}): Promise<SshfsMountResult> {
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const timeoutMs = params.timeoutMs ?? 20_000;
  const probe = params.probeDrive ?? ((letter: string) => existsSync(`${letter}:\\`));
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(params.binary, params.args, {
      windowsHide: true,
      // Detached so the mount survives the HTTP request that created it.
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: params.env,
    });
  } catch (error) {
    return { ready: false, detail: String(error) };
  }
  let output = "";
  const collect = (chunk: unknown) => {
    output = (output + String(chunk)).slice(-4_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  let spawnError = "";
  child.on("error", (error) => { spawnError = String(error); });
  if (params.stdinText !== undefined) {
    try {
      child.stdin?.write(params.stdinText);
      child.stdin?.end();
    } catch { /* closed early */ }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) break;
    if (probe(params.driveLetter)) {
      // Keep the mount alive but stop pinning the event loop: the pipes keep
      // draining (so sshfs never blocks on a full buffer) yet must not keep the
      // server process referenced.
      output = output.slice(-4_000);
      child.stdin?.end();
      // Node's child stdio streams are sockets on Windows and expose unref().
      const unrefStream = (stream: unknown) => {
        const handle = stream as { unref?: () => void } | null;
        if (typeof handle?.unref === "function") handle.unref();
      };
      unrefStream(child.stdout);
      unrefStream(child.stderr);
      child.unref();
      return { ready: true, detail: output.trim() };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (child.pid) killProcessTree(child.pid);
  // Drop the pipes as well: a kill that did not take effect must not keep the
  // test runner (or the server) alive on an orphaned child.
  try {
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  } catch { /* already closed */ }
  child.unref();
  return {
    ready: false,
    detail: (spawnError || output).trim(),
  };
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
  extraOptions: string[] = [],
): string[] {
  const remote = parts.absolute
    ? `${host.user}@${host.host}:${parts.path || "/"}`
    : `${host.user}@${host.host}:${parts.path}`;
  const options = [
    "idmap=user",
    `port=${host.port}`,
    "reconnect",
    "password_stdin",
    "StrictHostKeyChecking=accept-new",
    ...extraOptions,
  ];
  return ["-o", options.join(","), remote, `${driveLetter}:`];
}

export function hasSshfsWinInstalled(
  installDirs: string[] = ["C:\\Program Files\\SSHFS-Win", "C:\\Program Files (x86)\\SSHFS-Win"],
): boolean {
  return installDirs.some((dir) => existsSync(dir));
}

/* ------------------------------------------------------------------ */
/* Remote directory browsing (for the SSH directory picker)            */
/* ------------------------------------------------------------------ */

export interface RemoteDirEntry {
  name: string;
  path: string;
}

export interface RemoteLsResult {
  ok: boolean;
  path?: string;
  parentPath?: string | null;
  directories?: RemoteDirEntry[];
  error?: string;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Convert a parseRemotePath-validated path into a shell word. Home-relative
 * paths must keep ~ expansion working, hence the "$HOME" prefix form.
 */
export function toShPath(remotePath: string): string {
  if (!remotePath || remotePath === "~") return '"$HOME"';
  if (remotePath.startsWith("~/")) return `"$HOME"/${shQuote(remotePath.slice(2))}`;
  return shQuote(remotePath);
}

/**
 * Remote command for directory browsing: cd into the directory, print the
 * resolved absolute path behind a marker, then list every entry that is a
 * directory. The `[ -d "$f" ]` test follows symlinks, so symlinked
 * directories ARE listed (unlike `ls -p`, which only marks real dirs).
 * `$PWD` after a plain `cd` keeps the logical path, so navigating into a
 * symlink shows the symlink path rather than its resolved target.
 */
export function buildSshLsArgs(
  host: Pick<SshHostEntry, "host" | "port" | "user" | "identityFile">,
  remotePath: string,
): string[] {
  const command = `cd -- ${toShPath(remotePath)} || exit $?; printf '__PI_PWD__%s\\n' "$PWD"; for f in .[!.]* ..?* *; do [ -d "$f" ] && printf '%s\\n' "$f"; done; true`;
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    "-p", String(host.port),
  ];
  if (host.identityFile) args.push("-i", host.identityFile, "-o", "IdentitiesOnly=yes");
  args.push(`${host.user}@${host.host}`, command);
  return args;
}

function joinRemotePath(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base}/${name}`;
}

export function remoteParentPath(path: string): string | null {
  if (!path || path === "/") return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

export function parseSshLsOutput(stdout: string): RemoteLsResult {
  const lines = stdout.split(/\r?\n/);
  const markerIdx = lines.findIndex((line) => line.startsWith("__PI_PWD__"));
  if (markerIdx < 0) return { ok: false, error: "Unexpected remote ls output (path marker missing)" };
  const path = lines[markerIdx].slice("__PI_PWD__".length).trim() || "/";
  const directories: RemoteDirEntry[] = [];
  for (const line of lines.slice(markerIdx + 1)) {
    // Every listed line is a directory; tolerate a legacy trailing slash.
    const name = line.endsWith("/") ? line.slice(0, -1) : line;
    if (!name || name === "." || name === "..") continue;
    directories.push({ name, path: joinRemotePath(path, name) });
  }
  return { ok: true, path, parentPath: remoteParentPath(path), directories };
}

/**
 * Normalize a user-entered remote path into an absolute LOGICAL path:
 * `~` and relative paths resolve against the login home, `.`/`..`/duplicate
 * slashes collapse textually, and symlink components are NOT resolved, so
 * the picker keeps showing the path the user navigated to.
 */
export function normalizeLogicalRemotePath(input: string, home: string): string {
  let p = input.trim();
  if (!p || p === "~") return home;
  if (p.startsWith("~/")) p = `${home}/${p.slice(2)}`;
  else if (!p.startsWith("/")) p = `${home}/${p}`;
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `/${out.join("/")}`;
}

/**
 * List one remote directory over SFTP for password-auth hosts (ssh2).
 * The entered path is normalized logically (symlinks stay as typed) — only
 * the login home itself is discovered via realpath("."). SFTP `readdir`
 * attributes come from lstat, so symlinked directories are detected with a
 * follow-up `stat` per symlink entry.
 */
export async function listRemotePasswordDir(
  host: Pick<SshHostEntry, "host" | "port" | "user">,
  password: string,
  remotePath: string,
  timeoutMs = 15_000,
): Promise<RemoteLsResult> {
  try {
    const { Client } = await import("ssh2");
    return await new Promise<RemoteLsResult>((resolve) => {
      const client = new Client();
      let settled = false;
      const finish = (result: RemoteLsResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end();
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, error: `Connection timed out (${Math.round(timeoutMs / 1000)}s)` }),
        timeoutMs,
      );
      client
        .on("ready", () => {
          client.sftp((sftpErr, sftp) => {
            if (sftpErr) {
              finish({ ok: false, error: sftpErr.message });
              return;
            }
            sftp.realpath(".", (homeErr, home) => {
              if (homeErr || !home) {
                finish({ ok: false, error: homeErr?.message ?? "Could not resolve the remote home directory" });
                return;
              }
              const abs = normalizeLogicalRemotePath(remotePath, home);
              sftp.readdir(abs, (readErr, list) => {
                if (readErr) {
                  finish({ ok: false, error: readErr.message });
                  return;
                }
                const names: string[] = [];
                const symlinks: string[] = [];
                for (const entry of list) {
                  if (entry.filename === "." || entry.filename === "..") continue;
                  if (entry.attrs.isDirectory()) names.push(entry.filename);
                  else if (entry.attrs.isSymbolicLink()) symlinks.push(entry.filename);
                }
                // A symlink that points at a directory counts as browsable.
                const checkSymlink = (index: number) => {
                  if (index >= symlinks.length) {
                    names.sort((a, b) => a.localeCompare(b));
                    finish({
                      ok: true,
                      path: abs,
                      parentPath: remoteParentPath(abs),
                      directories: names.map((name) => ({ name, path: joinRemotePath(abs, name) })),
                    });
                    return;
                  }
                  sftp.stat(joinRemotePath(abs, symlinks[index]), (statErr, stats) => {
                    if (!statErr && stats.isDirectory()) names.push(symlinks[index]);
                    checkSymlink(index + 1);
                  });
                };
                checkSymlink(0);
              });
            });
          });
        })
        .on("error", (error) => {
          const message = error instanceof Error ? error.message : String(error);
          finish({ ok: false, error: /authentication|auth methods|permission denied/i.test(message) ? `Authentication failed: ${message}` : message });
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
