import { existsSync } from "node:fs";
import { jsonResponse } from "@/lib/json-response";
import { allowFileRoot } from "@/lib/file-access";
import { loadSshHosts } from "@/lib/ssh-hosts";
import {
  buildPasswordNetUseArgs,
  buildSshfsArgs,
  buildSshfsPasswordArgs,
  buildUncRoot,
  findFreeDriveLetter,
  findSshfsBinary,
  hasSshfsWinInstalled,
  mappedDrivePath,
  parseNetUse,
  parseRemotePath,
  resolveRemoteHome,
  runCommand,
  startSshfsMount,
} from "@/lib/ssh-remote";

export const dynamic = "force-dynamic";

const NET_USE_TIMEOUT_MS = 40_000;
const SSHFS_TIMEOUT_MS = 20_000;
const DRIVE_POLL_MS = 400;
const DRIVE_WAIT_MS = 10_000;

const SSHFS_WIN_HINT = "SSHFS-Win not found. Install it first (winget install -e --id SSHFS-Win.SSHFS-Win), then retry.";

async function waitForDrive(letter: string): Promise<boolean> {
  const root = `${letter}:\\`;
  const deadline = Date.now() + DRIVE_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(root)) return true;
    await new Promise((resolve) => setTimeout(resolve, DRIVE_POLL_MS));
  }
  return existsSync(root);
}

/** A freshly mapped drive answers before its tree is walkable; poll the path. */
async function waitForPath(path: string, timeoutMs = DRIVE_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, DRIVE_POLL_MS));
  }
  return existsSync(path);
}

/** `net use` output is localized; keep the message, the code is in it too. */
function netUseDetail(stdout: string, stderr: string): string {
  return (stdout || stderr).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
}

function removeMapping(letter: string): void {
  void runCommand("net", ["use", `${letter}:`, "/delete", "/y"], 10_000);
}

/** POST { hostId, remotePath } → mount the remote dir via SSHFS, return the local path. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: "Invalid JSON body" }, { status: 400 });
  }
  const record = (body ?? {}) as Record<string, unknown>;
  const hostId = typeof record.hostId === "string" ? record.hostId : "";
  const host = loadSshHosts().find((entry) => entry.id === hostId);
  if (!host) return jsonResponse(request, { error: "Host not found" }, { status: 404 });
  if (host.identityFile && !existsSync(host.identityFile)) {
    return jsonResponse(request, { error: `Identity file not found: ${host.identityFile}` }, { status: 400 });
  }
  const parts = parseRemotePath(typeof record.remotePath === "string" ? record.remotePath : "");
  if (!parts) {
    return jsonResponse(request, { error: "Invalid remote path (no backslashes, commas or exclamation marks)" }, { status: 400 });
  }
  const passwordAuth = host.authType === "password";
  if (passwordAuth && !host.password) {
    return jsonResponse(request, { error: "No password stored for this host" }, { status: 400 });
  }
  // Mount root-relative: a `~` path is resolved against the real login home so a
  // symlinked component outside the home cannot break the mapping.
  let resolvedParts = parts;
  if (!parts.absolute) {
    const home = await resolveRemoteHome(host, passwordAuth ? (host.password as string) : undefined);
    if (home) {
      resolvedParts = { absolute: true, path: parts.path ? `${home}/${parts.path}` : home };
    }
  }

  const sshfsBinary = findSshfsBinary();
  if (!sshfsBinary && !hasSshfsWinInstalled()) {
    return jsonResponse(request, { error: SSHFS_WIN_HINT, needsSshfsWin: true }, { status: 400 });
  }

  // A per-host IdentityFile is only supported by sshfs.exe. Everything else goes
  // through the `\\sshfs*` UNC provider, which maps the *host root* and needs no
  // long-lived child process. Putting the remote path inside the UNC name itself
  // is rejected by Windows with "System error 67: The network name cannot be
  // found", which used to surface as a credential-looking failure.
  const uncRoot = buildUncRoot(host, resolvedParts, { keyAuth: !passwordAuth });
  const netUse = await runCommand("net", ["use"], 10_000);
  const existing = parseNetUse(netUse.stdout).filter((entry) => /^[A-Z]$/.test(entry.letter));
  const reused = existing.find((entry) => entry.remote.toLowerCase() === uncRoot.toLowerCase());
  if (reused && existsSync(`${reused.letter}:\\`)) {
    const localPath = mappedDrivePath(reused.letter, resolvedParts);
    if (await waitForPath(localPath)) {
      allowFileRoot(`${reused.letter}:\\`);
      return jsonResponse(request, { localPath, reused: true });
    }
    // The host root is already mapped: remounting would fail with a misleading
    // "network name no longer available", so report the path itself instead.
    return jsonResponse(request, {
      error: `Remote directory not found: ${resolvedParts.path || "/"} (host root is mounted on ${reused.letter}:)`,
      backend: "unc",
    }, { status: 502 });
  }

  const letter = findFreeDriveLetter(new Set(existing.map((entry) => entry.letter)));
  if (!letter) return jsonResponse(request, { error: "No free drive letter available" }, { status: 400 });

  if (sshfsBinary && host.identityFile) {
    const args = passwordAuth
      ? buildSshfsPasswordArgs(host, parts, letter)
      : buildSshfsArgs(host, parts, letter);
    const mount = await startSshfsMount({
      binary: sshfsBinary,
      args,
      driveLetter: letter,
      stdinText: passwordAuth ? `${host.password}\n` : undefined,
      timeoutMs: SSHFS_TIMEOUT_MS,
    });
    if (!mount.ready) {
      const detail = mount.detail.split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
      return jsonResponse(request, {
        error: detail
          ? `sshfs failed: ${detail}`
          : `sshfs failed to mount ${letter}: within ${Math.round(SSHFS_TIMEOUT_MS / 1000)}s. Check the host credentials with 测试连接 first.`,
        backend: "sshfs",
      }, { status: 502 });
    }
    const localPath = `${letter}:\\`;
    allowFileRoot(localPath);
    return jsonResponse(request, { localPath, reused: false, backend: "sshfs" });
  }

  const args = passwordAuth
    ? buildPasswordNetUseArgs(uncRoot, host.user, host.password as string, letter)
    : ["use", `${letter}:`, uncRoot, "/persistent:no"];
  const result = await runCommand("net", args, NET_USE_TIMEOUT_MS);
  const ready = await waitForDrive(letter);
  if (!ready) {
    const detail = netUseDetail(result.stdout, result.stderr);
    removeMapping(letter);
    return jsonResponse(request, {
      error: detail ? `net use failed: ${detail}` : `net use failed (code ${result.code ?? "?"})`,
      backend: "unc",
    }, { status: 502 });
  }

  const localPath = mappedDrivePath(letter, resolvedParts);
  if (!(await waitForPath(localPath))) {
    removeMapping(letter);
    return jsonResponse(request, {
      error: `Mounted ${uncRoot} on ${letter}: but the remote directory is not accessible: ${resolvedParts.path || "/"}`,
      backend: "unc",
    }, { status: 502 });
  }
  allowFileRoot(`${letter}:\\`);
  return jsonResponse(request, { localPath, reused: false, backend: "unc" });
}
