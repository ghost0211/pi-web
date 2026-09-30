import { existsSync } from "node:fs";
import { jsonResponse } from "@/lib/json-response";
import { allowFileRoot } from "@/lib/file-access";
import { loadSshHosts } from "@/lib/ssh-hosts";
import {
  buildPasswordNetUseArgs,
  buildPasswordUncTarget,
  buildSshfsArgs,
  buildSshfsPasswordArgs,
  buildUncTarget,
  findFreeDriveLetter,
  findSshfsBinary,
  hasSshfsWinInstalled,
  parseNetUse,
  parseRemotePath,
  runCommand,
} from "@/lib/ssh-remote";

export const dynamic = "force-dynamic";

const NET_USE_TIMEOUT_MS = 30_000;
const SSHFS_TIMEOUT_MS = 30_000;
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

/** POST { hostId, remotePath } → mount the remote dir via SSHFS, return the local drive. */
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

  const sshfsBinary = findSshfsBinary();
  if (!sshfsBinary && !hasSshfsWinInstalled()) {
    return jsonResponse(request, { error: SSHFS_WIN_HINT, needsSshfsWin: true }, { status: 400 });
  }

  // Reuse an existing mount for the same UNC target when possible (sshfs.exe
  // mounts are registered under the same sshfs UNC prefix by WinFsp).
  const uncTarget = passwordAuth ? buildPasswordUncTarget(host, parts) : buildUncTarget(host, parts);
  const netUse = await runCommand("net", ["use"], 10_000);
  const existing = parseNetUse(netUse.stdout).filter((entry) => /^[A-Z]$/.test(entry.letter));
  const reused = existing.find((entry) => entry.remote.toLowerCase() === uncTarget.toLowerCase());
  if (reused && existsSync(`${reused.letter}:\\`)) {
    const localPath = `${reused.letter}:\\`;
    allowFileRoot(localPath);
    return jsonResponse(request, { localPath, reused: true });
  }

  const letter = findFreeDriveLetter(new Set(existing.map((entry) => entry.letter)));
  if (!letter) return jsonResponse(request, { error: "No free drive letter available" }, { status: 400 });

  if (sshfsBinary) {
    const args = passwordAuth
      ? buildSshfsPasswordArgs(host, parts, letter)
      : buildSshfsArgs(host, parts, letter);
    const result = await runCommand(
      sshfsBinary,
      args,
      SSHFS_TIMEOUT_MS,
      passwordAuth ? `${host.password}\n` : undefined,
    );
    const ready = await waitForDrive(letter);
    if (!ready) {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join("\n");
      return jsonResponse(request, {
        error: detail
          ? `sshfs failed: ${detail}`
          : `sshfs failed (code ${result.code ?? "?"}${result.timedOut ? ", timed out" : ""}). Check the host credentials with 测试连接 first.`,
      }, { status: 502 });
    }
  } else {
    const args = passwordAuth
      ? buildPasswordNetUseArgs(uncTarget, host.user, host.password as string, letter)
      : ["use", `${letter}:`, uncTarget, "/persistent:no"];
    const result = await runCommand("net", args, NET_USE_TIMEOUT_MS);
    const ready = await waitForDrive(letter);
    if (!ready) {
      const detail = (result.stdout || result.stderr).trim().split(/\r?\n/).slice(-3).join("\n");
      return jsonResponse(request, {
        error: detail
          ? `net use failed: ${detail}`
          : `net use failed (code ${result.code ?? "?"})`,
      }, { status: 502 });
    }
  }

  const localPath = `${letter}:\\`;
  allowFileRoot(localPath);
  return jsonResponse(request, { localPath, reused: false, backend: sshfsBinary ? "sshfs" : "unc" });
}
