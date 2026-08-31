/**
 * Browser-local hidden-projects store shared by the session sidebar and the
 * settings panel. A hidden project's sessions are filtered from the sidebar
 * list; the settings panel lists them so the user can restore them.
 *
 * Legacy format was a bare array of project keys (strings); entries are
 * normalized to { key, root? } refs so the settings panel can show paths.
 */

const STORAGE_KEY = "pi-web:hidden-projects";

export interface RichProjectRef {
  key: string;
  root?: string;
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

export function readHiddenProjects(
  storage: StorageLike | null = getBrowserStorage(),
): RichProjectRef[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): RichProjectRef | null => {
        if (typeof entry === "string" && entry.trim()) return { key: entry };
        if (typeof entry === "object" && entry !== null
          && typeof (entry as RichProjectRef).key === "string"
          && (entry as RichProjectRef).key.trim()) {
          const root = typeof (entry as RichProjectRef).root === "string"
            ? (entry as RichProjectRef).root
            : undefined;
          return root
            ? { key: (entry as RichProjectRef).key, root }
            : { key: (entry as RichProjectRef).key };
        }
        return null;
      })
      .filter((entry): entry is RichProjectRef => entry !== null)
      .filter((entry, index, list) => list.findIndex((other) => other.key === entry.key) === index);
  } catch {
    return [];
  }
}

export function writeHiddenProjects(
  projects: RichProjectRef[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(projects.map(({ key, root }) => ({ key, ...(root ? { root } : {}) }))));
  } catch {
    // Browser storage is best-effort.
  }
}

export function addHiddenProject(
  project: RichProjectRef,
  storage: StorageLike | null = getBrowserStorage(),
): RichProjectRef[] {
  const current = readHiddenProjects(storage);
  if (current.some((entry) => entry.key === project.key)) return current;
  const next = [...current, project];
  writeHiddenProjects(next, storage);
  return next;
}

export function removeHiddenProject(
  key: string,
  storage: StorageLike | null = getBrowserStorage(),
): RichProjectRef[] {
  const next = readHiddenProjects(storage).filter((entry) => entry.key !== key);
  writeHiddenProjects(next, storage);
  return next;
}
