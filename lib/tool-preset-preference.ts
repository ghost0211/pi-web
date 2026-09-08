import { BUILTIN_TOOL_NAMES, isToolPreset, type ToolPreset, type ToolPresetSelection } from "./tool-presets";

const STORAGE_KEY = "pi-tool-preset";
const CUSTOM_NAMES_KEY = "pi-tool-custom-names";

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

export function getPreferredToolPreset(
  storage: StorageLike | null = getBrowserStorage(),
): ToolPreset {
  if (!storage) return "default";
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : "default";
  } catch {
    return "default";
  }
}

export function setPreferredToolPreset(
  preset: ToolPreset,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Browser storage is best-effort.
  }
}

/**
 * Full selection preferred for fresh composers: one of the four presets, or
 * "custom" plus the remembered custom tool names.
 */
export function getPreferredToolSelection(
  storage: StorageLike | null = getBrowserStorage(),
): { preset: ToolPresetSelection; customNames: string[] } {
  if (!storage) return { preset: "default", customNames: [] };
  try {
    const value = storage.getItem(STORAGE_KEY);
    if (value === "custom") {
      return { preset: "custom", customNames: getPreferredCustomToolNames(storage) };
    }
    return { preset: isToolPreset(value) ? value : "default", customNames: getPreferredCustomToolNames(storage) };
  } catch {
    return { preset: "default", customNames: [] };
  }
}

export function setPreferredToolSelection(
  preset: ToolPresetSelection,
  customNames?: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
    if (preset === "custom" && customNames) {
      storage.setItem(CUSTOM_NAMES_KEY, JSON.stringify([...new Set(customNames)]));
    }
  } catch {
    // Browser storage is best-effort.
  }
}

export function getPreferredCustomToolNames(
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(CUSTOM_NAMES_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((name): name is string => (
      typeof name === "string" && BUILTIN_TOOL_NAMES.has(name)
    ));
  } catch {
    return [];
  }
}
