/**
 * Browser-local archived-sessions store. Archiving removes a session from the
 * sidebar list without deleting data; the section "..." menu's "show archived"
 * toggle lists them again so they can be unarchived. Unlike hidden sessions
 * (managed in Settings → Sessions), archive state is meant for everyday
 * decluttering with quick restore from the sidebar itself.
 */

const STORAGE_KEY = "pi-web:archived-sessions";
export const ARCHIVED_SESSIONS_CHANGED_EVENT = "pi-web:archived-sessions-changed";
const SHOW_ARCHIVED_KEY = "pi-web:show-archived-sessions";

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

function notifyChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ARCHIVED_SESSIONS_CHANGED_EVENT));
  }
}

export function readArchivedSessionIds(
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string" || !entry.trim() || ids.includes(entry)) continue;
      ids.push(entry);
    }
    return ids;
  } catch {
    return [];
  }
}

export function writeArchivedSessionIds(
  ids: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...new Set(ids)]));
    notifyChanged();
  } catch {
    // Browser storage is best-effort.
  }
}

export function isSessionArchived(
  id: string,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  return readArchivedSessionIds(storage).includes(id);
}

/** Toggles the archive flag; returns the new archived state. */
export function toggleArchivedSession(
  id: string,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  const current = readArchivedSessionIds(storage);
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
  writeArchivedSessionIds(next, storage);
  return next.includes(id);
}

export function removeArchivedSession(
  id: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  const next = readArchivedSessionIds(storage).filter((entry) => entry !== id);
  writeArchivedSessionIds(next, storage);
  return next;
}

/** Whether the sidebar lists archived sessions (dimmed, restorable). */
export function readShowArchivedSessions(
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(SHOW_ARCHIVED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeShowArchivedSessions(
  show: boolean,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(SHOW_ARCHIVED_KEY, show ? "1" : "0");
    notifyChanged();
  } catch {
    // Browser storage is best-effort.
  }
}
