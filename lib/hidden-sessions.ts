/**
 * Browser-local hidden-sessions store. Hiding removes a session from the
 * sidebar list; the Settings → Sessions panel lists all sessions (including
 * hidden ones) so they can be restored or permanently deleted.
 */

const STORAGE_KEY = "pi-web:hidden-sessions";

export interface HiddenSessionRef {
  id: string;
  projectKey?: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readHiddenSessions(
  storage: StorageLike | null = getBrowserStorage(),
): HiddenSessionRef[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): HiddenSessionRef | null => {
        if (typeof entry === "string" && entry.trim()) return { id: entry };
        if (typeof entry === "object" && entry !== null
          && typeof (entry as HiddenSessionRef).id === "string"
          && (entry as HiddenSessionRef).id.trim()) {
          const projectKey = typeof (entry as HiddenSessionRef).projectKey === "string"
            ? (entry as HiddenSessionRef).projectKey
            : undefined;
          return projectKey
            ? { id: (entry as HiddenSessionRef).id, projectKey }
            : { id: (entry as HiddenSessionRef).id };
        }
        return null;
      })
      .filter((entry): entry is HiddenSessionRef => entry !== null)
      .filter((entry, index, list) => (
        list.findIndex((other) => other.id === entry.id) === index
      ));
  } catch {
    return [];
  }
}

export function writeHiddenSessions(
  sessions: HiddenSessionRef[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(
      sessions.map(({ id, projectKey }) => ({ id, ...(projectKey ? { projectKey } : {}) })),
    ));
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("pi-web:hidden-state-changed"));
    }
  } catch {
    // Browser storage is best-effort.
  }
}

export function addHiddenSession(
  session: HiddenSessionRef,
  storage: StorageLike | null = getBrowserStorage(),
): HiddenSessionRef[] {
  const current = readHiddenSessions(storage);
  if (current.some((entry) => entry.id === session.id)) return current;
  const next = [...current, session];
  writeHiddenSessions(next, storage);
  return next;
}

/** Mark several sessions hidden at once (e.g. when hiding a whole project). */
export function addHiddenSessions(
  sessions: HiddenSessionRef[],
  storage: StorageLike | null = getBrowserStorage(),
): HiddenSessionRef[] {
  const current = readHiddenSessions(storage);
  const known = new Set(current.map((entry) => entry.id));
  const next = [...current];
  for (const session of sessions) {
    if (known.has(session.id)) continue;
    known.add(session.id);
    next.push(session);
  }
  writeHiddenSessions(next, storage);
  return next;
}

export function removeHiddenSession(
  id: string,
  storage: StorageLike | null = getBrowserStorage(),
): HiddenSessionRef[] {
  const next = readHiddenSessions(storage).filter((entry) => entry.id !== id);
  writeHiddenSessions(next, storage);
  return next;
}

export function removeHiddenSessionsForProject(
  projectKey: string,
  storage: StorageLike | null = getBrowserStorage(),
): HiddenSessionRef[] {
  const next = readHiddenSessions(storage).filter((entry) => entry.projectKey !== projectKey);
  writeHiddenSessions(next, storage);
  return next;
}
