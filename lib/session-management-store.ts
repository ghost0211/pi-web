import { randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path, { dirname, join } from "node:path";
import { projectIdentityKey } from "@/lib/project-identity";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import {
  emptySessionManagementState,
  type LegacySessionManagementMigration,
  type ManagedProjectState,
  type ManagedSessionState,
  type SessionManagementAction,
  type SessionManagementState,
} from "@/lib/session-management-types";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_MIGRATION_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_BYTES = 1024 * 1024;
const MAX_SESSIONS = 50_000;
const MAX_PROJECTS = 50_000;
const MAX_PROJECT_KEY_LENGTH = 4096;
const MAX_MIGRATION_IDS = 10_000;
const MAX_MIGRATION_ENTRIES = 10_000;
const MAX_PROJECT_ENTRIES = 5_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const LEGACY_STORAGE_KEYS = new Set([
  "pi-web:hidden-sessions",
  "pi-web:hidden-projects",
  "pi-web:archived-sessions",
  "pi-web:pinned-sessions",
  "pi-web:show-archived-sessions",
]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

type ReleaseLock = () => Promise<void>;

/** Injectable only so tests can isolate storage and simulate I/O failures. */
export interface SessionManagementStoreDependencies {
  readFile(path: string): string;
  ensureDirectory(path: string): void;
  initializeFile(path: string, contents: string): void;
  writeState(path: string, contents: string): void;
  writeBackup(path: string, contents: string): void;
  lock(path: string): Promise<ReleaseLock>;
}

export interface SessionManagementStoreOptions {
  /** Explicitly used by tests; production callers use the Pi Web-owned path. */
  filePath?: string;
  dependencies?: Partial<SessionManagementStoreDependencies>;
  /** Keeps legacy Windows/POSIX identity normalization testable on either OS. */
  platform?: NodeJS.Platform;
}

export class SessionManagementValidationError extends Error {
  override name = "SessionManagementValidationError";
}

export class SessionManagementCorruptionError extends Error {
  override name = "SessionManagementCorruptionError";
}

function invalid(message: string): never {
  throw new SessionManagementValidationError(message);
}

function defaultDependencies(): SessionManagementStoreDependencies {
  return {
    readFile: (path) => readFileSync(path, "utf8"),
    ensureDirectory: (path) => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    initializeFile: (path, contents) => {
      try {
        writeFileSync(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    },
    writeState: (path, contents) => writePrivateFileAtomicSync(path, contents),
    writeBackup: (path, contents) => {
      const tempPath = join(dirname(path), `.${randomUUID()}.migration.tmp`);
      try {
        writeFileSync(tempPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
        // link() creates the final name atomically and refuses to replace an
        // existing migration backup, including on retries after a failed state write.
        linkSync(tempPath, path);
      } finally {
        try { unlinkSync(tempPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
    lock: async (path) => {
      let compromised: Error | undefined;
      const release = await lockfile.lock(path, {
        retries: { retries: 10, factor: 2, minTimeout: 50, maxTimeout: 1_000, randomize: true },
        stale: 30_000,
        onCompromised: (error) => { compromised = error; },
      });
      return async () => {
        const lockError = compromised;
        try {
          await release();
        } catch (error) {
          if (!lockError) throw error;
        }
        if (lockError) throw lockError;
      };
    },
  };
}

function storagePath(options: SessionManagementStoreOptions = {}): string {
  return options.filePath ?? join(getAgentDir(), "pi-web", "session-management.json");
}

function dependencies(options: SessionManagementStoreOptions): SessionManagementStoreDependencies {
  return { ...defaultDependencies(), ...options.dependencies };
}

function ensureRegularFile(path: string): void {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Session management storage must be a regular file");
  }
}

function safeFileExists(path: string): boolean {
  try {
    ensureRegularFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const localQueues = new Map<string, Promise<void>>();

async function serializeLocally<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = localQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  localQueues.set(key, current);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (localQueues.get(key) === current) localQueues.delete(key);
  }
}

async function withStoreLock<T>(
  options: SessionManagementStoreOptions,
  task: (path: string, io: SessionManagementStoreDependencies) => Promise<T>,
): Promise<T> {
  const path = storagePath(options);
  const io = dependencies(options);
  const directory = dirname(path);
  io.ensureDirectory(directory);
  io.initializeFile(path, `${JSON.stringify(emptySessionManagementState())}\n`);
  ensureRegularFile(path);

  return serializeLocally(path, async () => {
    const release = await io.lock(path);
    let taskError: unknown;
    try {
      ensureRegularFile(path);
      return await task(path, io);
    } catch (error) {
      taskError = error;
      throw error;
    } finally {
      try {
        await release();
      } catch (error) {
        if (taskError === undefined) throw error;
      }
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateJsonTree(value: unknown, state: { nodes: number }, depth = 0, allowProjectKeys = false): void {
  state.nodes += 1;
  if (state.nodes > 200_000 || depth > 32) invalid("Session management data exceeds structural limits");
  if (typeof value === "string") {
    if (value.length > MAX_STATE_BYTES) invalid("Session management string is too large");
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) {
    if (value.length > 100_000) invalid("Session management array is too large");
    for (const item of value) validateJsonTree(item, state, depth + 1);
    return;
  }
  if (!isRecord(value)) invalid("Session management data must be JSON values");
  for (const [key, child] of Object.entries(value)) {
    const maxKeyLength = allowProjectKeys ? MAX_PROJECT_KEY_LENGTH : 256;
    if (UNSAFE_OBJECT_KEYS.has(key) || key.length > maxKeyLength || /[\u0000-\u001f\u007f]/.test(key)) {
      invalid("Session management data contains an unsafe object key");
    }
    // Canonical project paths are map keys and may be longer than arbitrary
    // JSON keys. Grant that larger bound only to the root `projects` map.
    validateJsonTree(child, state, depth + 1, depth === 0 && key === "projects");
  }
}

function validateSessionId(value: unknown, field = "session id"): string {
  if (typeof value !== "string" || value.length > 256 || !SESSION_ID_PATTERN.test(value) || UNSAFE_OBJECT_KEYS.has(value)) {
    invalid(`Invalid ${field}`);
  }
  return value;
}

function validateProjectKey(value: unknown, field = "project key"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROJECT_KEY_LENGTH
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)
    || UNSAFE_OBJECT_KEYS.has(value)) {
    invalid(`Invalid ${field}`);
  }
  return value;
}

function validateOptionalRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid("Invalid project root");
  }
  return value;
}

function parseStateInner(source: string): SessionManagementState {
  if (Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) invalid("Session management state is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid("Session management state is corrupt JSON");
  }
  validateJsonTree(parsed, { nodes: 0 });
  if (!isRecord(parsed)) invalid("Session management state must be an object");
  if (parsed.version !== 1 || !Number.isSafeInteger(parsed.revision) || (parsed.revision as number) < 0) {
    invalid("Unsupported or invalid session management state version");
  }
  if (!isRecord(parsed.sessions) || !isRecord(parsed.projects) || !Array.isArray(parsed.migrationIds)) {
    invalid("Session management state is missing required maps");
  }
  const sessionEntries = Object.entries(parsed.sessions);
  const projectEntries = Object.entries(parsed.projects);
  if (sessionEntries.length > MAX_SESSIONS || projectEntries.length > MAX_PROJECTS
    || parsed.migrationIds.length > MAX_MIGRATION_IDS) {
    invalid("Session management state exceeds entry limits");
  }
  for (const [id, value] of sessionEntries) {
    validateSessionId(id);
    if (!isRecord(value) || (value.status !== "active" && value.status !== "archived") || typeof value.pinned !== "boolean"
      || (value.status === "archived" && value.pinned)) {
      invalid(`Invalid session management entry for ${id}`);
    }
  }
  for (const [key, value] of projectEntries) {
    validateProjectKey(key);
    if (!isRecord(value) || typeof value.removed !== "boolean") invalid(`Invalid project management entry for ${key}`);
    validateOptionalRoot(value.root);
  }
  const migrationIds = parsed.migrationIds.map((id) => validateSessionId(id, "migration id"));
  if (new Set(migrationIds).size !== migrationIds.length) invalid("Duplicate migration IDs in session management state");
  return parsed as unknown as SessionManagementState;
}

function parseState(source: string): SessionManagementState {
  try {
    return parseStateInner(source);
  } catch (error) {
    if (error instanceof SessionManagementValidationError) {
      throw new SessionManagementCorruptionError(error.message);
    }
    throw error;
  }
}

function readLockedState(path: string, io: SessionManagementStoreDependencies): SessionManagementState {
  ensureRegularFile(path);
  return parseState(io.readFile(path));
}

function cloneState(state: SessionManagementState): SessionManagementState {
  return JSON.parse(JSON.stringify(state)) as SessionManagementState;
}

function writeNextState(
  path: string,
  io: SessionManagementStoreDependencies,
  next: SessionManagementState,
): SessionManagementState {
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Session management state exceeds the storage size limit");
  }
  parseState(serialized);
  io.writeState(path, serialized);
  return next;
}

function incrementRevision(revision: number): number {
  const next = revision + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Session management revision limit reached");
  return next;
}

/** Read validated state; absent storage is the empty v1 state. */
export function getSessionManagementState(
  options: SessionManagementStoreOptions = {},
): SessionManagementState {
  const path = storagePath(options);
  if (!safeFileExists(path)) return emptySessionManagementState();
  try {
    const source = dependencies(options).readFile(path);
    return parseState(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySessionManagementState();
    throw error;
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unexpected field: ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`Missing field: ${key}`);
}

function validateAction(value: unknown): SessionManagementAction {
  if (!isRecord(value)) invalid("Action must be an object");
  validateJsonTree(value, { nodes: 0 });
  if (value.type === "sessions") {
    exactKeys(value, ["type", "ids", "status", "pinned", "restoreProjects"], ["type", "ids"]);
    if (!Array.isArray(value.ids) || value.ids.length === 0 || value.ids.length > MAX_MIGRATION_ENTRIES) {
      invalid("Session action requires a bounded non-empty ids array");
    }
    const ids = value.ids.map((id) => validateSessionId(id));
    if (value.status !== undefined && value.status !== "active" && value.status !== "archived") {
      invalid("Invalid session status");
    }
    if (value.pinned !== undefined && typeof value.pinned !== "boolean") invalid("pinned must be a boolean");
    let restoreProjects: string[] | undefined;
    if (value.restoreProjects !== undefined) {
      if (!Array.isArray(value.restoreProjects) || value.restoreProjects.length > MAX_PROJECT_ENTRIES) {
        invalid("restoreProjects must be a bounded array");
      }
      restoreProjects = value.restoreProjects.map((key) => validateProjectKey(key));
    }
    if (value.status === undefined && value.pinned === undefined && restoreProjects === undefined) {
      invalid("Session action has no requested change");
    }
    return {
      type: "sessions",
      ids,
      ...(value.status !== undefined ? { status: value.status as "active" | "archived" } : {}),
      ...(value.pinned !== undefined ? { pinned: value.pinned as boolean } : {}),
      ...(restoreProjects !== undefined ? { restoreProjects } : {}),
    };
  }
  if (value.type === "project") {
    exactKeys(value, ["type", "key", "removed", "root"], ["type", "key", "removed"]);
    const key = validateProjectKey(value.key);
    if (typeof value.removed !== "boolean") invalid("removed must be a boolean");
    const root = validateOptionalRoot(value.root);
    return { type: "project", key, removed: value.removed as boolean, ...(root !== undefined ? { root } : {}) };
  }
  invalid("Unknown session management action type");
}

function applyAction(state: SessionManagementState, action: SessionManagementAction): { next: SessionManagementState; changed: boolean } {
  const next = cloneState(state);
  let changed = false;
  if (action.type === "sessions") {
    for (const id of new Set(action.ids)) {
      const previous = next.sessions[id];
      const status = action.status ?? previous?.status ?? "active";
      let pinned = action.pinned ?? previous?.pinned ?? false;
      if (status === "archived") pinned = false;
      if (previous && previous.status === status && previous.pinned === pinned) continue;
      const entry: ManagedSessionState = { ...(previous ?? {}), status, pinned };
      next.sessions[id] = entry;
      changed = true;
    }
    for (const key of new Set(action.restoreProjects ?? [])) {
      const previous = next.projects[key];
      if (previous?.removed === false) continue;
      next.projects[key] = { ...(previous ?? {}), removed: false } as ManagedProjectState;
      changed = true;
    }
  } else {
    const previous = next.projects[action.key];
    const root = action.root ?? previous?.root;
    if (previous?.removed === action.removed && previous?.root === root) return { next: state, changed: false };
    next.projects[action.key] = {
      ...(previous ?? {}),
      removed: action.removed,
      ...(root !== undefined ? { root } : {}),
    };
    changed = true;
  }
  if (!changed) return { next: state, changed: false };
  if (Object.keys(next.sessions).length > MAX_SESSIONS || Object.keys(next.projects).length > MAX_PROJECTS) {
    invalid("Session management entry limit reached");
  }
  next.revision = incrementRevision(state.revision);
  return { next, changed: true };
}

/** Apply an explicit session/project action while preserving unknown state fields. */
export async function applySessionManagementAction(
  input: unknown,
  options: SessionManagementStoreOptions = {},
): Promise<SessionManagementState> {
  const action = validateAction(input);
  return withStoreLock(options, async (path, io) => {
    const state = readLockedState(path, io);
    const result = applyAction(state, action);
    return result.changed ? writeNextState(path, io, result.next) : state;
  });
}

function legacyProjectIdentity(key: string, platform: NodeJS.Platform): string {
  // Do not reinterpret opaque ids (or synthetic POSIX keys on Windows) as
  // paths. Historical Windows entries used display paths before canonical
  // project keys were introduced; use the same lexical identity as the catalog.
  const absolute = platform === "win32"
    ? /^[a-zA-Z]:[\\/]/.test(key) || key.startsWith("\\\\") || key.startsWith("//")
    : path.posix.isAbsolute(key);
  return absolute ? projectIdentityKey(key, platform) : key;
}

function validateMigration(value: unknown, platform: NodeJS.Platform): LegacySessionManagementMigration {
  if (!isRecord(value)) invalid("Migration must be an object");
  validateJsonTree(value, { nodes: 0 });
  exactKeys(value, ["migrationId", "hiddenSessions", "hiddenProjects", "archivedSessionIds", "pinnedSessionIds", "rawBackup"], [
    "migrationId", "hiddenSessions", "hiddenProjects", "archivedSessionIds", "pinnedSessionIds", "rawBackup",
  ]);
  const migrationId = validateSessionId(value.migrationId, "migration ID");
  if (!Array.isArray(value.hiddenSessions) || value.hiddenSessions.length > MAX_MIGRATION_ENTRIES
    || !Array.isArray(value.hiddenProjects) || value.hiddenProjects.length > MAX_PROJECT_ENTRIES
    || !Array.isArray(value.archivedSessionIds) || value.archivedSessionIds.length > MAX_MIGRATION_ENTRIES
    || !Array.isArray(value.pinnedSessionIds) || value.pinnedSessionIds.length > MAX_MIGRATION_ENTRIES
    || !isRecord(value.rawBackup)) {
    invalid("Legacy migration payload exceeds limits or has invalid collections");
  }
  const hiddenSessions = value.hiddenSessions.map((entry) => {
    if (!isRecord(entry)) invalid("Invalid hidden session entry");
    exactKeys(entry, ["id", "projectKey"], ["id"]);
    const id = validateSessionId(entry.id);
    const projectKey = entry.projectKey === undefined ? undefined : validateProjectKey(entry.projectKey);
    return { id, ...(projectKey !== undefined ? { projectKey } : {}) };
  });
  const hiddenProjects = value.hiddenProjects.map((entry) => {
    if (!isRecord(entry)) invalid("Invalid hidden project entry");
    exactKeys(entry, ["key", "root"], ["key"]);
    const originalKey = validateProjectKey(entry.key);
    const key = legacyProjectIdentity(originalKey, platform);
    const root = validateOptionalRoot(entry.root) ?? (key !== originalKey ? originalKey : undefined);
    return { key, ...(root !== undefined ? { root } : {}) };
  });
  const archivedSessionIds = value.archivedSessionIds.map((id) => validateSessionId(id));
  const pinnedSessionIds = value.pinnedSessionIds.map((id) => validateSessionId(id));
  const rawBackup: Record<string, string | null> = {};
  let backupBytes = 0;
  for (const [key, raw] of Object.entries(value.rawBackup)) {
    if (!LEGACY_STORAGE_KEYS.has(key)) invalid(`Unsupported legacy backup key: ${key}`);
    if (raw !== null && typeof raw !== "string") invalid("Legacy backup values must be strings or null");
    backupBytes += Buffer.byteLength(raw ?? "", "utf8");
    if (backupBytes > MAX_BACKUP_BYTES) invalid("Legacy backup exceeds size limit");
    Object.defineProperty(rawBackup, key, { value: raw, enumerable: true, writable: true, configurable: true });
  }
  const normalized: LegacySessionManagementMigration = {
    migrationId,
    hiddenSessions,
    hiddenProjects,
    archivedSessionIds,
    pinnedSessionIds,
    rawBackup,
  };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_MIGRATION_BYTES) invalid("Legacy migration payload is too large");
  return normalized;
}

function migrationBackupContents(migration: LegacySessionManagementMigration): string {
  return `${JSON.stringify({
    version: 1,
    migrationId: migration.migrationId,
    rawBackup: migration.rawBackup,
    payload: migration,
  }, null, 2)}\n`;
}

function assertExistingBackupMatches(path: string, expected: string, io: SessionManagementStoreDependencies): void {
  ensureRegularFile(path);
  const actual = io.readFile(path);
  if (actual !== expected) throw new Error("Migration ID already has a different immutable backup");
}

/**
 * Import legacy browser records only when the server has no decision for that
 * record. The immutable backup is persisted before the migration marker/state.
 */
export async function migrateLegacySessionManagement(
  input: unknown,
  options: SessionManagementStoreOptions = {},
): Promise<SessionManagementState> {
  const migration = validateMigration(input, options.platform ?? process.platform);
  const backup = migrationBackupContents(migration);
  if (Buffer.byteLength(backup, "utf8") > MAX_MIGRATION_BYTES + MAX_BACKUP_BYTES) {
    invalid("Legacy migration backup is too large");
  }
  return withStoreLock(options, async (path, io) => {
    const state = readLockedState(path, io);
    if (state.migrationIds.includes(migration.migrationId)) return state;

    if (state.migrationIds.length >= MAX_MIGRATION_IDS) invalid("Legacy migration limit reached");
    const next = cloneState(state);
    const archived = new Set([...migration.hiddenSessions.map(({ id }) => id), ...migration.archivedSessionIds]);
    const pinned = new Set(migration.pinnedSessionIds);
    const sessionIds = new Set([...archived, ...pinned]);
    for (const id of sessionIds) {
      if (Object.hasOwn(next.sessions, id)) continue;
      next.sessions[id] = { status: archived.has(id) ? "archived" : "active", pinned: !archived.has(id) && pinned.has(id) };
    }
    for (const project of migration.hiddenProjects) {
      if (Object.hasOwn(next.projects, project.key)) continue;
      next.projects[project.key] = { removed: true, ...(project.root !== undefined ? { root: project.root } : {}) };
    }
    if (Object.keys(next.sessions).length > MAX_SESSIONS || Object.keys(next.projects).length > MAX_PROJECTS) {
      invalid("Session management entry limit reached");
    }
    next.migrationIds.push(migration.migrationId);
    next.revision = incrementRevision(state.revision);

    // Back up the exact accepted legacy payload before committing state. A
    // failed write leaves no marker, and retrying verifies any existing backup.
    const backupPath = join(dirname(path), `session-management-migration-${migration.migrationId}.json`);
    try {
      io.writeBackup(backupPath, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      assertExistingBackupMatches(backupPath, backup, io);
    }
    return writeNextState(path, io, next);
  });
}

/** Internal route helper: clear only session metadata after real deletion succeeds. */
export async function forgetDeletedSessionMetadata(
  id: string,
  options: SessionManagementStoreOptions = {},
): Promise<SessionManagementState> {
  const safeId = validateSessionId(id);
  return withStoreLock(options, async (path, io) => {
    const state = readLockedState(path, io);
    if (!Object.hasOwn(state.sessions, safeId)) return state;
    const next = cloneState(state);
    delete next.sessions[safeId];
    next.revision = incrementRevision(state.revision);
    return writeNextState(path, io, next);
  });
}
