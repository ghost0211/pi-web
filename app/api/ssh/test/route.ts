import { jsonResponse } from "@/lib/json-response";
import { loadSshHosts, validateSshHostInput, type SshHostEntry } from "@/lib/ssh-hosts";
import { buildSshTestArgs, runCommand, SSH_TEST_MARKER } from "@/lib/ssh-remote";

export const dynamic = "force-dynamic";

const TEST_TIMEOUT_MS = 15_000;

/** POST { hostId } or { host: {...} } → probe the host with key-only ssh auth. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: "Invalid JSON body" }, { status: 400 });
  }
  const record = (body ?? {}) as Record<string, unknown>;
  let host: SshHostEntry | null = null;
  if (typeof record.hostId === "string") {
    host = loadSshHosts().find((entry) => entry.id === record.hostId) ?? null;
    if (!host) return jsonResponse(request, { error: "Host not found" }, { status: 404 });
  } else {
    const candidate = record.host ?? record;
    if (validateSshHostInput(candidate) !== null) {
      return jsonResponse(request, { error: validateSshHostInput(candidate) }, { status: 400 });
    }
    const c = candidate as Record<string, unknown>;
    host = {
      id: "probe",
      name: String(c.name),
      host: String(c.host).trim(),
      user: String(c.user).trim(),
      port: Number(c.port),
      identityFile: typeof c.identityFile === "string" && c.identityFile.trim() ? c.identityFile.trim() : null,
      createdAt: "",
      updatedAt: "",
    };
  }
  if (host.identityFile) {
    const { existsSync } = await import("node:fs");
    if (!existsSync(host.identityFile)) {
      return jsonResponse(request, { ok: false, error: `Identity file not found: ${host.identityFile}` });
    }
  }
  const result = await runCommand("ssh", buildSshTestArgs(host), TEST_TIMEOUT_MS);
  if (result.spawnError) {
    return jsonResponse(request, { ok: false, error: `ssh not available: ${result.spawnError}` });
  }
  if (result.timedOut) {
    return jsonResponse(request, { ok: false, error: "Connection timed out (15s)" });
  }
  if (result.stdout.includes(SSH_TEST_MARKER)) {
    return jsonResponse(request, { ok: true });
  }
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-3).join("\n");
  return jsonResponse(request, {
    ok: false,
    error: detail || `ssh exited with code ${result.code ?? "?"}`,
    hint: "key-auth",
  });
}
