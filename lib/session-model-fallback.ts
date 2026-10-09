import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";
import {
  parseFallbackModel,
  parseModelFallbackNotice,
  type FallbackModelRef,
  type ModelFallbackNotice,
} from "./model-fallback";

export const MODEL_FALLBACK_SELECTION_TYPE = "pi-web:model-fallback";
export const MODEL_FALLBACK_EVENT_TYPE = "pi-web:model-fallback-event";

export function validateFallbackModel(value: unknown): FallbackModelRef | null {
  const parsed = parseFallbackModel(value);
  if (parsed === undefined) throw new Error("fallbackModel must be null or a provider/modelId reference");
  return parsed;
}

/** Session-level configuration; missing legacy entries stay off. Corruption fails closed. */
export function readSessionModelFallback(entries: readonly SessionEntry[]): FallbackModelRef | null | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== MODEL_FALLBACK_SELECTION_TYPE) continue;
    const data = entry.data as { version?: unknown; model?: unknown } | null;
    if (!data || typeof data !== "object" || data.version !== 1) return null;
    return parseFallbackModel(data.model) ?? null;
  }
  return undefined;
}

export function appendSessionModelFallback(manager: SessionManager, model: FallbackModelRef | null): void {
  manager.appendCustomEntry(MODEL_FALLBACK_SELECTION_TYPE, { version: 1, model });
}

export function readSessionModelFallbackNotice(entries: readonly SessionEntry[]): ModelFallbackNotice | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== MODEL_FALLBACK_EVENT_TYPE) continue;
    const data = entry.data as { version?: unknown; notice?: unknown } | null;
    if (!data || typeof data !== "object" || data.version !== 1) return null;
    return parseModelFallbackNotice(data.notice);
  }
  return null;
}

export function appendSessionModelFallbackNotice(manager: SessionManager, notice: ModelFallbackNotice): void {
  manager.appendCustomEntry(MODEL_FALLBACK_EVENT_TYPE, { version: 1, notice });
}
