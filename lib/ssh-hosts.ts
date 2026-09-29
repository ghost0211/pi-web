import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * SSH remote host registry ("设置 → 远程主机"). Hosts are used to mount a
 * remote directory over SSHFS so a pi session can work on it as a local cwd.
 * Auth is always the system OpenSSH configuration (default keys / ssh-agent /
 * an optional per-host identity file); passwords are never stored here.
 */

export interface SshHostEntry {
  id: string;
  /** Display name, e.g. "dev-box". */
  name: string;
  host: string;
  port: number;
  user: string;
  /** Optional absolute path to a private key; null = ssh default/agent. */
  identityFile: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SshHostInput = Omit<SshHostEntry, "id" | "createdAt" | "updatedAt">;

const HOST_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getSshHostsPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "ssh-hosts.json");
}

/** Returns an error string, or null when the entry is valid. */
export function validateSshHostInput(input: unknown): string | null {
  if (!isRecord(input)) return "host entry must be an object";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length === 0 || name.length > 64) return "name must be 1-64 characters";
  const host = typeof input.host === "string" ? input.host.trim() : "";
  if (!HOST_NAME_RE.test(host)) return "host must be a hostname or IP address";
  const user = typeof input.user === "string" ? input.user.trim() : "";
  if (!USER_RE.test(user)) return "user may only contain letters, digits, . _ -";
  const port = typeof input.port === "number" ? input.port : Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return "port must be an integer between 1 and 65535";
  if (input.identityFile !== null && input.identityFile !== undefined) {
    if (typeof input.identityFile !== "string") return "identityFile must be a path string";
    const trimmed = input.identityFile.trim();
    if (trimmed.length > 0 && /["\r\n]/.test(trimmed)) return "identityFile contains invalid characters";
  }
  return null;
}

export function normalizeSshHostInput(input: SshHostInput): SshHostInput {
  return {
    name: input.name.trim(),
    host: input.host.trim(),
    user: input.user.trim(),
    port: Number(input.port),
    identityFile: input.identityFile?.trim() ? input.identityFile.trim() : null,
  };
}

function parseHostEntry(value: unknown): SshHostEntry | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (validateSshHostInput(value) !== null) return null;
  const identity = typeof value.identityFile === "string" && value.identityFile.trim()
    ? value.identityFile.trim()
    : null;
  return {
    id: value.id,
    name: (value.name as string).trim(),
    host: (value.host as string).trim(),
    user: (value.user as string).trim(),
    port: Number(value.port),
    identityFile: identity,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

/** Malformed files fail closed to an empty list; unknown top-level fields are dropped. */
export function loadSshHosts(path: string = getSshHostsPath()): SshHostEntry[] {
  try {
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.hosts)) return [];
    return parsed.hosts
      .map(parseHostEntry)
      .filter((entry): entry is SshHostEntry => entry !== null);
  } catch {
    return [];
  }
}

export function saveSshHosts(hosts: SshHostEntry[], path: string = getSshHostsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ hosts }, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function upsertSshHost(
  input: SshHostInput,
  existingId?: string,
  path: string = getSshHostsPath(),
): SshHostEntry {
  const hosts = loadSshHosts(path);
  const normalized = normalizeSshHostInput(input);
  const now = new Date().toISOString();
  const index = existingId ? hosts.findIndex((host) => host.id === existingId) : -1;
  const entry: SshHostEntry = index >= 0
    ? { ...hosts[index], ...normalized, updatedAt: now }
    : { id: randomUUID(), ...normalized, createdAt: now, updatedAt: now };
  if (index >= 0) hosts[index] = entry;
  else hosts.push(entry);
  saveSshHosts(hosts, path);
  return entry;
}

export function deleteSshHost(id: string, path: string = getSshHostsPath()): boolean {
  const hosts = loadSshHosts(path);
  const next = hosts.filter((host) => host.id !== id);
  if (next.length === hosts.length) return false;
  saveSshHosts(next, path);
  return true;
}
