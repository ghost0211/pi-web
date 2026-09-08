import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

/**
 * Per-session system prompt customization, persisted as a versioned custom
 * entry in the session file (mirrors pi-web:tool-selection). Entries are
 * append-only, so clearing records a `{mode: "clear"}` tombstone and the
 * newest entry wins.
 */
export const SYSTEM_PROMPT_CUSTOM_TYPE = "pi-web:system-prompt";

export interface SessionSystemPromptCustomization {
  /** "append" adds text after the natural prompt; "replace" substitutes it. */
  mode: "append" | "replace";
  text: string;
}

interface SessionSystemPromptData {
  version: 1;
  mode: "append" | "replace" | "clear";
  text?: string;
}

function parseSystemPromptData(
  data: unknown,
): SessionSystemPromptCustomization | "clear" | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as { version?: unknown; mode?: unknown; text?: unknown };
  if (candidate.version !== 1) return undefined;
  if (candidate.mode === "clear") return "clear";
  if (
    (candidate.mode === "append" || candidate.mode === "replace")
    && typeof candidate.text === "string"
    && candidate.text.trim().length > 0
  ) {
    return { mode: candidate.mode, text: candidate.text };
  }
  return undefined;
}

/**
 * Return the newest valid persisted customization. Undefined means the session
 * uses the natural system prompt (no entry, or a trailing clear tombstone).
 */
export function readSessionSystemPrompt(
  entries: readonly SessionEntry[],
): SessionSystemPromptCustomization | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SYSTEM_PROMPT_CUSTOM_TYPE) continue;
    const parsed = parseSystemPromptData(entry.data);
    if (parsed === "clear") return undefined;
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function appendSessionSystemPrompt(
  sessionManager: SessionManager,
  customization: SessionSystemPromptCustomization | null,
): void {
  const data: SessionSystemPromptData = customization
    ? { version: 1, mode: customization.mode, text: customization.text }
    : { version: 1, mode: "clear" };
  sessionManager.appendCustomEntry(SYSTEM_PROMPT_CUSTOM_TYPE, data);
}
