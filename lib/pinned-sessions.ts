/**
 * Legacy pin readers/writers retained for migration compatibility, plus the
 * pure family-ordering helper. New UI stores pins via session-management-client.
 */

const STORAGE_KEY = "pi-web:pinned-sessions";
export const PINNED_SESSIONS_CHANGED_EVENT = "pi-web:pinned-sessions-changed";

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
    window.dispatchEvent(new Event(PINNED_SESSIONS_CHANGED_EVENT));
  }
}

export function readPinnedSessionIds(
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

export function writePinnedSessionIds(
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

export function isSessionPinned(
  id: string,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  return readPinnedSessionIds(storage).includes(id);
}

/** Toggles the pin; returns the new pinned state. */
export function togglePinnedSession(
  id: string,
  storage: StorageLike | null = getBrowserStorage(),
): boolean {
  const current = readPinnedSessionIds(storage);
  const next = current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
  writePinnedSessionIds(next, storage);
  return next.includes(id);
}

export function removePinnedSession(
  id: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  const next = readPinnedSessionIds(storage).filter((entry) => entry !== id);
  writePinnedSessionIds(next, storage);
  return next;
}

interface PinnableFamily {
  root: { id: string };
}

/**
 * Stable partition: pinned families first (relative order preserved), then
 * unpinned. Pinning a subagent row pins its family root.
 */
export function orderFamiliesWithPinned<T extends PinnableFamily>(
  families: readonly T[],
  pinnedIds: ReadonlySet<string>,
): T[] {
  if (pinnedIds.size === 0) return [...families];
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const family of families) {
    (pinnedIds.has(family.root.id) ? pinned : unpinned).push(family);
  }
  return [...pinned, ...unpinned];
}
