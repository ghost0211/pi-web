import { jsonResponse } from "@/lib/json-response";
import { loadSshHosts } from "@/lib/ssh-hosts";
import { buildSshLsArgs, listRemotePasswordDir, parseRemotePath, parseSshLsOutput, runCommand } from "@/lib/ssh-remote";

export const dynamic = "force-dynamic";

/**
 * List one remote directory for the SSH directory picker.
 * Key-auth hosts go through the system ssh client (BatchMode); password-auth
 * hosts go through ssh2/SFTP so no system ssh is required.
 */
export async function POST(request: Request) {
  let body: { hostId?: string; path?: string };
  try {
    body = (await request.json()) as { hostId?: string; path?: string };
  } catch {
    return jsonResponse(request, { error: "Invalid JSON body" }, { status: 400 });
  }
  const hostId = typeof body.hostId === "string" ? body.hostId : "";
  const host = loadSshHosts().find((entry) => entry.id === hostId);
  if (!host) return jsonResponse(request, { error: "SSH host not found" }, { status: 404 });

  const rawPath = typeof body.path === "string" ? body.path : "";
  const parts = parseRemotePath(rawPath);
  if (!parts) {
    return jsonResponse(request, { error: "Invalid remote path (no \\ , or ! characters)" }, { status: 400 });
  }
  // For ls we keep the raw form (with ~) because the remote shell expands it.
  const remotePath = rawPath.trim();

  if (host.authType === "password") {
    if (!host.password) return jsonResponse(request, { error: "No password saved for this host" }, { status: 400 });
    const result = await listRemotePasswordDir(host, host.password, remotePath);
    return jsonResponse(request, result, { status: result.ok ? 200 : 502 });
  }

  const result = await runCommand("ssh", buildSshLsArgs(host, remotePath), 20000);
  if (result.spawnError) {
    return jsonResponse(
      request,
      { ok: false, error: `ssh client not available: ${result.spawnError}` },
      { status: 502 },
    );
  }
  if (result.timedOut) {
    return jsonResponse(request, { ok: false, error: "ssh ls timed out (20s)" }, { status: 502 });
  }
  if (result.code !== 0) {
    return jsonResponse(
      request,
      { ok: false, error: (result.stderr || result.stdout || "remote ls failed").trim().slice(0, 400) },
      { status: 502 },
    );
  }
  const parsed = parseSshLsOutput(result.stdout);
  return jsonResponse(request, parsed, { status: parsed.ok ? 200 : 502 });
}
