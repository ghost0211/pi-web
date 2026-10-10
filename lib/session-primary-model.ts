import type { SessionEntry } from "./types";
import { parseFallbackModel, parseModelFallbackNotice, sameFallbackModel, type FallbackModelRef } from "./model-fallback";
import { MODEL_FALLBACK_EVENT_TYPE } from "./session-model-fallback";
import { isThinkingLevelOption } from "./thinking-level-options";

/** Written before automatic SDK model/thinking mutations, cleared only after restoration. */
export const PRIMARY_MODEL_SNAPSHOT_TYPE = "pi-web:primary-model-snapshot";
export interface TemporaryModelFallback {
  primary: FallbackModelRef;
  backup: FallbackModelRef;
}

function selectedModel(entries: readonly SessionEntry[]): FallbackModelRef | null {
  let model: FallbackModelRef | null = null;
  let thinkingLevel: FallbackModelRef["thinkingLevel"];
  for (const entry of entries) {
    if (entry.type === "model_change") model = { provider: entry.provider, modelId: entry.modelId };
    if (entry.type === "thinking_level_change" && isThinkingLevelOption(entry.thinkingLevel)) thinkingLevel = entry.thinkingLevel;
  }
  return model ? { ...model, ...(thinkingLevel !== undefined ? { thinkingLevel } : {}) } : null;
}

/** Input must be one active branch in root-to-leaf order, never the session forest. */
export function readSessionTemporaryFallback(entries: readonly SessionEntry[]): TemporaryModelFallback | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== PRIMARY_MODEL_SNAPSHOT_TYPE) continue;
    const data = entry.data as { version?: unknown; primary?: unknown; backup?: unknown } | null;
    if (!data || data.version !== 1 || data.primary === null) return null;
    const primary = parseFallbackModel(data.primary);
    const backup = parseFallbackModel(data.backup);
    return primary && backup && !sameFallbackModel(primary, backup) ? { primary, backup } : null;
  }

  // v0.9.49–51 wrote the automatic selection but no primary checkpoint. Infer
  // only the unambiguous latest switch, never override subsequent user edits.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "model_change" || entry.type === "thinking_level_change") return null;
    if (entry.type !== "custom" || entry.customType !== MODEL_FALLBACK_EVENT_TYPE) continue;
    const data = entry.data as { version?: unknown; notice?: unknown } | null;
    const notice = data?.version === 1 ? parseModelFallbackNotice(data.notice) : null;
    if (!notice) return null;
    for (let j = i - 1; j >= 0; j--) {
      const change = entries[j];
      if (change.type !== "model_change") continue;
      if (!sameFallbackModel({ provider: change.provider, modelId: change.modelId }, notice.to)) return null;
      const before = selectedModel(entries.slice(0, j));
      if (!before || !sameFallbackModel(before, notice.from)) return null;
      return { primary: before, backup: notice.to };
    }
    return null;
  }
  return null;
}

/** Configuration, not the model physically attributed to an assistant reply. */
export function readSessionPrimaryModel(entries: readonly SessionEntry[]): FallbackModelRef | null {
  return readSessionTemporaryFallback(entries)?.primary ?? selectedModel(entries);
}
