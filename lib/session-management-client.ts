import {
  readArchivedSessionIds,
  readShowArchivedSessions,
} from "./archived-sessions";
import { readHiddenProjects } from "./hidden-projects";
import { readHiddenSessions } from "./hidden-sessions";
import { readPinnedSessionIds } from "./pinned-sessions";
import {
  type LegacySessionManagementMigration,
  type SessionManagementAction,
  type SessionManagementState,
} from "./session-management-types";

const LEGACY_STORAGE_KEYS = [
  "pi-web:hidden-sessions",
  "pi-web:hidden-projects",
  "pi-web:archived-sessions",
  "pi-web:pinned-sessions",
  "pi-web:show-archived-sessions",
] as const;
const MIGRATION_ID_KEY = "pi-web:session-management:migration-id";
const LEGACY_BACKUP_KEY_PREFIX = "pi-web:session-management:legacy-backup:";
const CROSS_TAB_STORAGE_KEY = "pi-web:session-management:changed";
const BROADCAST_CHANNEL_NAME = "pi-web:session-management";
const MAX_CROSS_TAB_MESSAGE_CHARS = 64 * 1024;
const MAX_CROSS_TAB_DELETED_IDS = 100;
const MAX_SESSION_ID_LENGTH = 2_048;
const MAX_REMEMBERED_EVENT_TOKENS = 512;
const DEFAULT_POLL_INTERVAL_MS = 60_000;

export const SESSION_CATALOG_CHANGED_EVENT = "pi-web:session-catalog-changed";

export interface SessionManagementSnapshot {
  /** Null until the server state and any required legacy migration are confirmed. */
  state: SessionManagementState | null;
  ready: boolean;
  loading: boolean;
  error: string | null;
}

export interface SessionManagementDeleteResult {
  deletedIds: string[];
  failures: { id: string; error: string }[];
  warnings?: string[];
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SessionManagementClientOptions {
  /** Dependency overrides make the client testable without a real backend. */
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getStorage?: () => StorageLike;
  getOrigin?: () => string | null;
  generateMigrationId?: () => string;
  pollIntervalMs?: number;
  dispatchCatalogChanged?: (deletedIds: string[]) => void;
}

export interface SessionManagementClient {
  load(options?: { force?: boolean }): Promise<SessionManagementState>;
  refresh(): Promise<SessionManagementState>;
  update(action: SessionManagementAction): Promise<SessionManagementState>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionManagementSnapshot;
  getServerSnapshot(): SessionManagementSnapshot;
  deleteManagedSessions(ids: string[]): Promise<SessionManagementDeleteResult>;
}

const INITIAL_SNAPSHOT: SessionManagementSnapshot = Object.freeze({
  state: null,
  ready: false,
  loading: false,
  error: null,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateState(value: unknown): SessionManagementState {
  if (!isRecord(value)
    || value.version !== 1
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !isRecord(value.sessions)
    || !isRecord(value.projects)
    || !Array.isArray(value.migrationIds)
    || !value.migrationIds.every((id) => typeof id === "string")) {
    throw new Error("The session-management API returned an invalid state.");
  }

  const sessions: SessionManagementState["sessions"] = {};
  for (const [id, session] of Object.entries(value.sessions)) {
    if (!isRecord(session)
      || (session.status !== "active" && session.status !== "archived")
      || typeof session.pinned !== "boolean") {
      throw new Error("The session-management API returned an invalid session entry.");
    }
    sessions[id] = { status: session.status, pinned: session.pinned };
  }

  const projects: SessionManagementState["projects"] = {};
  for (const [key, project] of Object.entries(value.projects)) {
    if (!isRecord(project)
      || typeof project.removed !== "boolean"
      || (project.root !== undefined && typeof project.root !== "string")) {
      throw new Error("The session-management API returned an invalid project entry.");
    }
    projects[key] = {
      removed: project.removed,
      ...(typeof project.root === "string" ? { root: project.root } : {}),
    };
  }

  return {
    version: 1,
    revision: value.revision as number,
    sessions,
    projects,
    migrationIds: [...value.migrationIds] as string[],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_SESSION_ID_LENGTH
    && value.trim().length > 0;
}

interface CrossTabMessage {
  type: "changed";
  revision?: number;
  eventToken?: string;
  deletedIds: string[];
}

function parseCrossTabMessage(value: unknown): CrossTabMessage | null {
  if (!isRecord(value)) return null;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (typeof serialized !== "string"
    || serialized.length > MAX_CROSS_TAB_MESSAGE_CHARS
    || value.type !== "changed") return null;
  if (value.revision !== undefined
    && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)) return null;

  let eventToken: string | undefined;
  if (value.eventToken !== undefined) {
    if (typeof value.eventToken !== "string"
      || !value.eventToken.trim()
      || value.eventToken.length > 128) return null;
    eventToken = value.eventToken;
  }

  let deletedIds: string[] = [];
  if (value.deletedIds !== undefined) {
    if (!Array.isArray(value.deletedIds) || value.deletedIds.length > MAX_CROSS_TAB_DELETED_IDS) return null;
    if (!value.deletedIds.every(isValidSessionId)) return null;
    deletedIds = [...new Set(value.deletedIds as string[])];
    if (deletedIds.length > 0 && !eventToken) return null;
  }

  return {
    type: "changed",
    ...(typeof value.revision === "number" ? { revision: value.revision } : {}),
    ...(eventToken ? { eventToken } : {}),
    deletedIds,
  };
}

function createCrossTabEventToken(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Use the local fallback if the browser crypto API is unavailable.
  }
  return `event-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function parseResponseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function responseDetail(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  return null;
}

async function readResponseBody(response: Response): Promise<{ text: string; body: unknown }> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new Error(`Unable to read the API response: ${errorMessage(error)}`);
  }
  return { text, body: parseResponseText(text) };
}

function httpError(response: Response, body: unknown): Error {
  const detail = responseDetail(body);
  return new Error(
    detail
      ? `Session-management request failed (HTTP ${response.status}): ${detail}`
      : `Session-management request failed (HTTP ${response.status}).`,
  );
}

function defaultOrigin(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.location.origin;
  } catch {
    return null;
  }
}

function defaultStorage(): StorageLike {
  if (typeof window === "undefined") {
    throw new Error("Browser storage is unavailable outside the browser.");
  }
  try {
    return window.localStorage;
  } catch (error) {
    throw new Error(`Unable to access browser storage: ${errorMessage(error)}`);
  }
}

function defaultMigrationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `migration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function defaultDispatchCatalogChanged(deletedIds: string[]): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SESSION_CATALOG_CHANGED_EVENT, {
    detail: { deletedIds: [...deletedIds] },
  }));
}

function emptyRawBackup(): Record<(typeof LEGACY_STORAGE_KEYS)[number], string | null> {
  return {
    "pi-web:hidden-sessions": null,
    "pi-web:hidden-projects": null,
    "pi-web:archived-sessions": null,
    "pi-web:pinned-sessions": null,
    "pi-web:show-archived-sessions": null,
  };
}

function readRawBackup(storage: StorageLike): Record<(typeof LEGACY_STORAGE_KEYS)[number], string | null> {
  const rawBackup = emptyRawBackup();
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      rawBackup[key] = storage.getItem(key);
    } catch (error) {
      throw new Error(`Unable to read legacy session-management storage (${key}): ${errorMessage(error)}`);
    }
  }
  return rawBackup;
}

function parseSavedRawBackup(serialized: string, key: string): Record<(typeof LEGACY_STORAGE_KEYS)[number], string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`The saved legacy session-management backup (${key}) is malformed.`);
  }
  if (!isRecord(parsed)
    || !LEGACY_STORAGE_KEYS.every((legacyKey) => (
      Object.prototype.hasOwnProperty.call(parsed, legacyKey)
      && (parsed[legacyKey] === null || typeof parsed[legacyKey] === "string")
    ))) {
    throw new Error(`The saved legacy session-management backup (${key}) is incomplete.`);
  }
  const rawBackup = emptyRawBackup();
  for (const legacyKey of LEGACY_STORAGE_KEYS) {
    rawBackup[legacyKey] = parsed[legacyKey] as string | null;
  }
  return rawBackup;
}

function normalizeLegacyMigration(
  migrationId: string,
  rawBackup: Record<(typeof LEGACY_STORAGE_KEYS)[number], string | null>,
): LegacySessionManagementMigration {
  const memoryStorage: StorageLike = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(rawBackup, key)
        ? rawBackup[key as (typeof LEGACY_STORAGE_KEYS)[number]]
        : null;
    },
    setItem() {
      // The existing readers only read; never write legacy keys during migration.
    },
  };

  const hiddenSessions = readHiddenSessions(memoryStorage).map(({ id, projectKey }) => ({
    id,
    ...(projectKey ? { projectKey } : {}),
  }));
  const hiddenProjects = readHiddenProjects(memoryStorage).map(({ key, root }) => ({
    key,
    ...(root ? { root } : {}),
  }));
  const archivedSessionIds = readArchivedSessionIds(memoryStorage);
  const pinnedSessionIds = readPinnedSessionIds(memoryStorage);
  // This is a legacy display preference, not session-management state. Read it
  // with the legacy parser, but preserve it only in rawBackup for rollback.
  readShowArchivedSessions(memoryStorage);

  return {
    migrationId,
    hiddenSessions,
    hiddenProjects,
    archivedSessionIds,
    pinnedSessionIds,
    rawBackup: { ...rawBackup },
  };
}

function hasMeaningfulLegacyContent(migration: LegacySessionManagementMigration): boolean {
  return migration.hiddenSessions.length > 0
    || migration.hiddenProjects.length > 0
    || migration.archivedSessionIds.length > 0
    || migration.pinnedSessionIds.length > 0;
}

function isCurrentStateNewer(
  candidate: SessionManagementState,
  current: SessionManagementState | null,
): boolean {
  return current === null || candidate.revision > current.revision;
}

/**
 * Create an isolated store. The exported module-level functions below use one
 * shared instance so sidebar/settings consumers share cache and in-flight work.
 */
export function createSessionManagementClient(
  options: SessionManagementClientOptions = {},
): SessionManagementClient {
  const fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const getStorage = options.getStorage ?? defaultStorage;
  const getOrigin = options.getOrigin ?? defaultOrigin;
  const generateMigrationId = options.generateMigrationId ?? defaultMigrationId;
  const dispatchCatalogChanged = options.dispatchCatalogChanged ?? defaultDispatchCatalogChanged;
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  let snapshot = INITIAL_SNAPSHOT;
  let generation = 0;
  let activeOrigin: string | null | undefined;
  let pendingOperations = 0;
  let mutationEpoch = 0;
  let loadPromise: Promise<SessionManagementState> | null = null;
  let refreshPromise: Promise<SessionManagementState> | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();
  let deletionQueue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const receivedEventTokens = new Set<string>();
  const receivedEventTokenOrder: string[] = [];
  let lifecycleCleanup: (() => void) | null = null;

  function emit(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A subscriber cannot prevent the remaining subscribers from updating.
      }
    }
  }

  function publish(patch: Partial<SessionManagementSnapshot>): void {
    snapshot = { ...snapshot, ...patch };
    emit();
  }

  function ensureOrigin(): number {
    let nextOrigin: string | null;
    try {
      nextOrigin = getOrigin();
    } catch (error) {
      throw new Error(`Unable to determine the session-management origin: ${errorMessage(error)}`);
    }
    if (!nextOrigin) throw new Error("Session management is only available in a browser origin.");

    if (activeOrigin !== nextOrigin) {
      activeOrigin = nextOrigin;
      generation += 1;
      pendingOperations = 0;
      mutationEpoch = 0;
      loadPromise = null;
      refreshPromise = null;
      mutationQueue = Promise.resolve();
      deletionQueue = Promise.resolve();
      receivedEventTokens.clear();
      receivedEventTokenOrder.length = 0;
      snapshot = INITIAL_SNAPSHOT;
      emit();
    }
    return generation;
  }

  function assertGeneration(expected: number): void {
    if (expected !== generation) {
      throw new Error("Session-management response discarded after the browser origin changed.");
    }
  }

  function beginOperation(expected: number): void {
    assertGeneration(expected);
    pendingOperations += 1;
    publish({ loading: true, error: null });
  }

  function endOperation(expected: number): void {
    if (expected !== generation) return;
    pendingOperations = Math.max(0, pendingOperations - 1);
    publish({ loading: pendingOperations > 0 });
  }

  function captureError(expected: number, error: unknown): void {
    if (expected !== generation) return;
    publish({ error: errorMessage(error) });
  }

  function currentState(): SessionManagementState {
    if (!snapshot.state) throw new Error("Session-management state is not ready.");
    return snapshot.state;
  }

  async function requestState(
    method: "GET" | "PATCH" | "POST",
    expected: number,
    body?: SessionManagementAction | LegacySessionManagementMigration,
  ): Promise<SessionManagementState> {
    assertGeneration(expected);
    let response: Response;
    try {
      response = await fetcher("/api/session-management", {
        method,
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      throw new Error(`Unable to reach session-management API: ${errorMessage(error)}`);
    }
    assertGeneration(expected);

    const { body: responseBody } = await readResponseBody(response);
    assertGeneration(expected);
    if (!response.ok) throw httpError(response, responseBody);
    if (!isRecord(responseBody) || !Object.prototype.hasOwnProperty.call(responseBody, "state")) {
      throw new Error("The session-management API response is missing state.");
    }
    return validateState(responseBody.state);
  }

  function readStorage(): StorageLike {
    try {
      return getStorage();
    } catch (error) {
      throw new Error(`Unable to access browser storage required for legacy migration: ${errorMessage(error)}`);
    }
  }

  function readMigrationId(storage: StorageLike): string | null {
    let value: string | null;
    try {
      value = storage.getItem(MIGRATION_ID_KEY);
    } catch (error) {
      throw new Error(`Unable to read the session-management migration id: ${errorMessage(error)}`);
    }
    if (value !== null && !value.trim()) {
      throw new Error("The saved session-management migration id is empty; refusing to replace it.");
    }
    return value;
  }

  function readSavedBackup(
    storage: StorageLike,
    migrationId: string,
  ): Record<(typeof LEGACY_STORAGE_KEYS)[number], string | null> | null {
    const backupKey = `${LEGACY_BACKUP_KEY_PREFIX}${migrationId}`;
    let serialized: string | null;
    try {
      serialized = storage.getItem(backupKey);
    } catch (error) {
      throw new Error(`Unable to read the saved legacy session-management backup: ${errorMessage(error)}`);
    }
    return serialized === null ? null : parseSavedRawBackup(serialized, backupKey);
  }

  function persistMigrationId(storage: StorageLike, migrationId: string): void {
    try {
      storage.setItem(MIGRATION_ID_KEY, migrationId);
      if (storage.getItem(MIGRATION_ID_KEY) !== migrationId) {
        throw new Error("The migration id was not retained by browser storage.");
      }
    } catch (error) {
      throw new Error(`Unable to save the session-management migration id: ${errorMessage(error)}`);
    }
  }

  function persistBackup(
    storage: StorageLike,
    migrationId: string,
    rawBackup: Record<(typeof LEGACY_STORAGE_KEYS)[number], string | null>,
  ): void {
    const backupKey = `${LEGACY_BACKUP_KEY_PREFIX}${migrationId}`;
    const serialized = JSON.stringify(rawBackup);
    try {
      storage.setItem(backupKey, serialized);
      if (storage.getItem(backupKey) !== serialized) {
        throw new Error("The exact legacy backup was not retained by browser storage.");
      }
    } catch (error) {
      throw new Error(`Unable to save the legacy session-management backup before migration: ${errorMessage(error)}`);
    }
  }

  async function migrateIfNeeded(
    serverState: SessionManagementState,
    expected: number,
  ): Promise<SessionManagementState> {
    assertGeneration(expected);
    const storage = readStorage();
    // Always read the original keys strictly. A failed read must never be
    // mistaken for an empty legacy state by the legacy readers' tolerant API.
    const currentRawBackup = readRawBackup(storage);
    let migrationId = readMigrationId(storage);

    if (migrationId && serverState.migrationIds.includes(migrationId)) return serverState;

    const savedBackup = migrationId ? readSavedBackup(storage, migrationId) : null;
    const rawBackup = savedBackup ?? currentRawBackup;
    let migration = normalizeLegacyMigration(migrationId ?? "", rawBackup);
    if (!hasMeaningfulLegacyContent(migration)) return serverState;

    if (!migrationId) {
      try {
        migrationId = generateMigrationId();
      } catch (error) {
        throw new Error(`Unable to generate a stable session-management migration id: ${errorMessage(error)}`);
      }
      if (!migrationId || !migrationId.trim()) {
        throw new Error("Unable to generate a non-empty session-management migration id.");
      }
      persistMigrationId(storage, migrationId);
      migration = normalizeLegacyMigration(migrationId, rawBackup);
    }

    if (serverState.migrationIds.includes(migrationId)) return serverState;

    if (!savedBackup) persistBackup(storage, migrationId, rawBackup);
    migration = normalizeLegacyMigration(migrationId, rawBackup);

    const migratedState = await requestState("POST", expected, migration);
    assertGeneration(expected);
    if (!migratedState.migrationIds.includes(migrationId)) {
      throw new Error("The session-management migration response did not acknowledge the migration id.");
    }
    if (migratedState.revision < serverState.revision) {
      throw new Error("The session-management migration response is older than the initial server state.");
    }
    return migratedState;
  }

  function applyCandidate(candidate: SessionManagementState, expected: number): SessionManagementState {
    assertGeneration(expected);
    const existing = snapshot.state;
    if (isCurrentStateNewer(candidate, existing)) {
      publish({ state: candidate, ready: true, error: null });
      return candidate;
    }
    return existing ?? candidate;
  }

  async function load(loadOptions: { force?: boolean } = {}): Promise<SessionManagementState> {
    const expected = ensureOrigin();
    if (snapshot.ready && !loadOptions.force) return currentState();
    if (snapshot.ready && loadOptions.force) return refresh();
    if (loadPromise) return loadPromise;

    beginOperation(expected);
    const operation = (async () => {
      try {
        const serverState = await requestState("GET", expected);
        assertGeneration(expected);
        const readyState = await migrateIfNeeded(serverState, expected);
        assertGeneration(expected);
        const committed = applyCandidate(readyState, expected);
        if (!snapshot.ready) publish({ state: committed, ready: true, error: null });
        if (readyState.migrationIds.some((id) => !serverState.migrationIds.includes(id))) {
          broadcastChanged(committed.revision);
        }
        return currentState();
      } catch (error) {
        captureError(expected, error);
        throw error;
      } finally {
        endOperation(expected);
      }
    })();
    loadPromise = operation;
    try {
      return await operation;
    } finally {
      if (loadPromise === operation) loadPromise = null;
    }
  }

  async function refresh(): Promise<SessionManagementState> {
    const expected = ensureOrigin();
    if (!snapshot.ready) return load();
    if (refreshPromise) return refreshPromise;

    const epochAtStart = mutationEpoch;
    beginOperation(expected);
    const operation = (async () => {
      try {
        const candidate = await requestState("GET", expected);
        assertGeneration(expected);
        // A GET begun before a local mutation must not publish even if it
        // completes later with a higher-looking stale snapshot.
        if (epochAtStart === mutationEpoch) applyCandidate(candidate, expected);
        publish({ error: null });
        return currentState();
      } catch (error) {
        captureError(expected, error);
        throw error;
      } finally {
        endOperation(expected);
      }
    })();
    refreshPromise = operation;
    try {
      return await operation;
    } finally {
      if (refreshPromise === operation) refreshPromise = null;
    }
  }

  function broadcastChanged(revision: number, deletedIds: string[] = []): void {
    const validIds = [...new Set(deletedIds.filter(isValidSessionId))];
    const chunks: string[][] = [];
    let currentChunk: string[] = [];
    for (const id of validIds) {
      const candidate = [...currentChunk, id];
      const worstCaseMessage = JSON.stringify({
        type: "changed",
        revision,
        eventToken: "x".repeat(128),
        deletedIds: candidate,
      });
      if (currentChunk.length > 0
        && (candidate.length > MAX_CROSS_TAB_DELETED_IDS
          || worstCaseMessage.length > MAX_CROSS_TAB_MESSAGE_CHARS)) {
        chunks.push(currentChunk);
        currentChunk = [id];
      } else {
        currentChunk = candidate;
      }
    }
    if (currentChunk.length > 0 || chunks.length === 0) chunks.push(currentChunk);

    for (const ids of chunks) {
      const message = {
        type: "changed",
        revision,
        eventToken: createCrossTabEventToken(),
        deletedIds: ids,
      };
      const serialized = JSON.stringify(message);
      if (serialized.length > MAX_CROSS_TAB_MESSAGE_CHARS) continue;
      try {
        if (typeof BroadcastChannel !== "undefined") {
          // Lifecycle listeners own the long-lived channel. This one-shot message
          // is not needed when there are no active subscribers.
          lifecycleChannel?.postMessage(message);
        }
      } catch {
        // The localStorage event below remains a best-effort fallback.
      }
      try {
        const storage = getStorage();
        storage.setItem(CROSS_TAB_STORAGE_KEY, serialized);
      } catch {
        // Notifications must not make a confirmed server write look like failure.
      }
    }
  }

  let lifecycleChannel: BroadcastChannel | null = null;

  function refreshFromBrowserSignal(): void {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    void refresh().catch(() => undefined);
  }

  function rememberEventToken(token: string): boolean {
    if (receivedEventTokens.has(token)) return false;
    receivedEventTokens.add(token);
    receivedEventTokenOrder.push(token);
    if (receivedEventTokenOrder.length > MAX_REMEMBERED_EVENT_TOKENS) {
      const oldest = receivedEventTokenOrder.shift();
      if (oldest) receivedEventTokens.delete(oldest);
    }
    return true;
  }

  function handleCrossTabMessage(value: unknown): void {
    const message = parseCrossTabMessage(value);
    if (!message) return;
    if (message.eventToken && !rememberEventToken(message.eventToken)) return;
    if (message.deletedIds.length > 0) emitCatalogChanged(message.deletedIds);
    // A remote signal updates metadata only. Never rebroadcast a received event.
    refreshFromBrowserSignal();
  }

  function startLifecycle(): void {
    if (lifecycleCleanup || typeof window === "undefined") return;
    const onFocus = () => refreshFromBrowserSignal();
    const onOnline = () => refreshFromBrowserSignal();
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        refreshFromBrowserSignal();
      }
    };
    const onStorage = (event: Event) => {
      const storageEvent = event as StorageEvent;
      if (storageEvent.key !== CROSS_TAB_STORAGE_KEY || typeof storageEvent.newValue !== "string") return;
      if (storageEvent.newValue.length > MAX_CROSS_TAB_MESSAGE_CHARS) return;
      let value: unknown;
      try {
        value = JSON.parse(storageEvent.newValue) as unknown;
      } catch {
        return;
      }
      handleCrossTabMessage(value);
    };
    const onBroadcast = (event: MessageEvent) => handleCrossTabMessage(event.data);

    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    window.addEventListener("storage", onStorage);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

    let interval: ReturnType<typeof setInterval> | null = null;
    if (pollIntervalMs > 0) {
      interval = setInterval(() => {
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          refreshFromBrowserSignal();
        }
      }, pollIntervalMs);
    }

    try {
      if (typeof BroadcastChannel !== "undefined") {
        lifecycleChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
        lifecycleChannel.addEventListener("message", onBroadcast);
      }
    } catch {
      lifecycleChannel = null;
    }

    lifecycleCleanup = () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("storage", onStorage);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      if (interval !== null) clearInterval(interval);
      if (lifecycleChannel) {
        lifecycleChannel.removeEventListener("message", onBroadcast);
        lifecycleChannel.close();
        lifecycleChannel = null;
      }
      lifecycleCleanup = null;
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) startLifecycle();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) lifecycleCleanup?.();
    };
  }

  function update(action: SessionManagementAction): Promise<SessionManagementState> {
    const operation = mutationQueue.then(async () => {
      const expected = ensureOrigin();
      await load();
      assertGeneration(expected);
      mutationEpoch += 1;
      beginOperation(expected);
      try {
        const candidate = await requestState("PATCH", expected, action);
        assertGeneration(expected);
        const committed = applyCandidate(candidate, expected);
        publish({ ready: true, error: null });
        broadcastChanged(committed.revision);
        return currentState();
      } catch (error) {
        captureError(expected, error);
        throw error;
      } finally {
        endOperation(expected);
      }
    });
    mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function emitCatalogChanged(deletedIds: string[]): void {
    try {
      dispatchCatalogChanged([...deletedIds]);
    } catch {
      // The DELETE acknowledgement remains authoritative if event delivery fails.
    }
  }

  async function refreshAfterCatalogMutation(): Promise<SessionManagementState> {
    const inFlight = refreshPromise;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // Its failure is recorded; start a fresh GET after the catalog writes.
      }
      if (refreshPromise === inFlight) refreshPromise = null;
    }
    return refresh();
  }

  async function performDeleteBatch(ids: string[]): Promise<SessionManagementDeleteResult> {
    const expected = ensureOrigin();
    mutationEpoch += 1;
    const deletedIds: string[] = [];
    const failures: { id: string; error: string }[] = [];
    const warnings: string[] = [];

    // Deliberately sequential: deletes may cascade-reparent session children.
    for (const id of [...new Set(ids)]) {
      if (!isValidSessionId(id)) {
        failures.push({
          id: String(id),
          error: `A non-empty session id of at most ${MAX_SESSION_ID_LENGTH} characters is required.`,
        });
        continue;
      }

      let response: Response;
      let body: unknown = null;
      try {
        assertGeneration(expected);
        response = await fetcher(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "DELETE",
          cache: "no-store",
          credentials: "same-origin",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        });
        assertGeneration(expected);
        const result = await readResponseBody(response);
        body = result.body;
        if (!response.ok) throw httpError(response, body);
        if (!isRecord(body) || body.ok !== true) {
          throw new Error(responseDetail(body) ?? "The session delete response did not confirm success.");
        }
        deletedIds.push(id);
        if (Array.isArray(body.warnings)) {
          warnings.push(...body.warnings.filter((warning): warning is string => typeof warning === "string"));
        } else if (typeof body.warning === "string") {
          // Older servers returned a single warning; accept it during rollout.
          warnings.push(body.warning);
        }
      } catch (error) {
        failures.push({ id, error: errorMessage(error) });
      }
    }

    if (deletedIds.length > 0) emitCatalogChanged(deletedIds);
    try {
      await refreshAfterCatalogMutation();
      if (deletedIds.length > 0) broadcastChanged(snapshot.state?.revision ?? 0, deletedIds);
    } catch (error) {
      warnings.push(`Session management could not be refreshed after deletion: ${errorMessage(error)}`);
      if (deletedIds.length > 0) broadcastChanged(snapshot.state?.revision ?? 0, deletedIds);
    }

    return {
      deletedIds,
      failures,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  function deleteManagedSessions(ids: string[]): Promise<SessionManagementDeleteResult> {
    const operation = deletionQueue.then(() => performDeleteBatch(ids));
    deletionQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  return {
    load,
    refresh,
    update,
    subscribe,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => INITIAL_SNAPSHOT,
    deleteManagedSessions,
  };
}

const sessionManagementClient = createSessionManagementClient();

/** Load the shared browser snapshot; `force` revalidates an already-ready cache. */
export function loadSessionManagement(
  options: { force?: boolean } = {},
): Promise<SessionManagementState> {
  return sessionManagementClient.load(options);
}

/** Explicit foreground refresh entry point, also used after catalog deletion. */
export function refreshSessionManagement(): Promise<SessionManagementState> {
  return sessionManagementClient.refresh();
}

/** Serialize a server-side action; no whole-state replacement or optimistic state. */
export function updateSessionManagement(
  action: SessionManagementAction,
): Promise<SessionManagementState> {
  return sessionManagementClient.update(action);
}

export function subscribeSessionManagement(listener: () => void): () => void {
  return sessionManagementClient.subscribe(listener);
}

export function getSessionManagementSnapshot(): SessionManagementSnapshot {
  return sessionManagementClient.getSnapshot();
}

export function getSessionManagementServerSnapshot(): SessionManagementSnapshot {
  return sessionManagementClient.getServerSnapshot();
}

/** Sequentially delete sessions and retain a result for each confirmed failure. */
export function deleteManagedSessions(ids: string[]): Promise<SessionManagementDeleteResult> {
  return sessionManagementClient.deleteManagedSessions(ids);
}
