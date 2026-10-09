import { parseFallbackModel, type FallbackModelRef } from "@/lib/model-fallback";

const FALLBACK_MODEL_STORAGE_KEY = "pi-fallback-model-preference";

/** Read the optional fresh-composer fallback preference. Storage failures mean off. */
export function getFallbackModelPreference(): FallbackModelRef | null {
  try {
    if (typeof window === "undefined") return null;
    const stored = window.localStorage.getItem(FALLBACK_MODEL_STORAGE_KEY);
    if (stored === null) return null;
    const parsed = parseFallbackModel(JSON.parse(stored));
    return parsed ?? null;
  } catch {
    return null;
  }
}

/** Store only the public provider/model reference; storage failures are non-fatal. */
export function setFallbackModelPreference(model: FallbackModelRef | null): void {
  try {
    if (typeof window === "undefined") return;
    if (model === null) {
      window.localStorage.removeItem(FALLBACK_MODEL_STORAGE_KEY);
      return;
    }
    const parsed = parseFallbackModel(model);
    if (!parsed) return;
    window.localStorage.setItem(FALLBACK_MODEL_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Private browsing, disabled storage, or quota errors leave the UI usable.
  }
}
