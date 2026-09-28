/**
 * Cross-session full-text search.
 *
 * The chat sidebar's "search sessions…" box only matches session metadata
 * (name / first message). This module searches the conversational body of every
 * session's *active branch* so a user can find the message a phrase appeared in
 * and jump the chat to the turn that contains it.
 *
 * Scope of a scan:
 *   - only the active branch (root -> current leaf), so abandoned branches and
 *     pre-branch forks never leak matches into the results;
 *   - only plain, user-visible text from `user`, `assistant`, `custom_message`,
 *     `compaction` and `branch_summary` entries;
 *   - never tool results, tool-call arguments, thinking blocks or base64 image
 *     payloads.
 *
 * Resource control (a scan runs on the shared Next.js server):
 *   - bounded query length, result cap and limit clamp;
 *   - a file-size gate before any parsing, so a session with huge attachments is
 *     skipped instead of being loaded into memory;
 *   - a session-count and entry-count budget;
 *   - sessions are scanned sequentially, so at most one session's entries are in
 *     memory at a time;
 *   - the event loop is yielded between sessions; the request's AbortSignal stops
 *     a scan whose client went away.
 *
 * Every omission is reported back through `truncated` / `partial` / `skipped`
 * instead of silently returning a short list.
 */

import { statSync } from "node:fs";
import { getSessionEntries, listAllSessions, sliceActiveBranch } from "./session-reader";
import type { SessionEntry, SessionInfo } from "./types";

/** Role reported for a match. Mirrors the entry kind that produced it. */
export type SessionSearchRole =
  | "user"
  | "assistant"
  | "custom_message"
  | "compaction"
  | "branch_summary";

/** One matching entry. Exported so the UI can `import type` the API shape. */
export interface SessionSearchResult {
  sessionId: string;
  /** Id of the matching entry, used to scroll/highlight the message. */
  entryId: string;
  role: SessionSearchRole;
  /** Bounded, single-line excerpt around the first match. */
  snippet: string;
  /** Entry timestamp when the file carried one. */
  timestamp?: string;
  /**
   * Entry id of the nearest turn anchor at or before the match: the closest
   * preceding `user` message or `compaction` entry (a `branch_summary` renders
   * as a user turn too, so it anchors as well). Falls back to `entryId` when the
   * match has no anchor above it, so the value is always a scrollable target.
   */
  turnEntryId: string;
}

/** Why sessions/files were left out of a scan. */
export interface SessionSearchSkipSummary {
  /** Files whose size exceeded the per-file cap. */
  oversized: number;
  /** Files that could not be stat'ed or parsed. */
  unreadable: number;
  /** Sessions not reached because a scan/result budget was exhausted. */
  budget: number;
}

/** Response body of `GET /api/sessions/search`. */
export interface SessionSearchResponse {
  results: SessionSearchResult[];
  /** True when the result cap was reached and scanning stopped early. */
  truncated: boolean;
  /** True when any session/file was skipped or a budget cut the scan short. */
  partial: boolean;
  scannedSessions: number;
  scannedEntries: number;
  skipped: SessionSearchSkipSummary;
}

export interface SessionSearchOptions {
  query: string;
  /** Max matches returned. Clamped to [1, SESSION_SEARCH_MAX_LIMIT]. */
  limit?: number;
  /**
   * Pre-listed catalogue. Defaults to `listAllSessions()`. Callers that already
   * listed sessions (or tests) can pass it to avoid a second disk scan.
   */
  sessions?: readonly SessionInfo[];
  maxSessions?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

/** Queries longer than this are rejected by the route before any file is read. */
export const SESSION_SEARCH_MAX_QUERY_LENGTH = 200;
export const SESSION_SEARCH_DEFAULT_LIMIT = 50;
export const SESSION_SEARCH_MAX_LIMIT = 200;
/** Files larger than this are skipped (large base64 attachments). */
export const SESSION_SEARCH_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Upper bound on sessions visited by one request. */
export const SESSION_SEARCH_MAX_SESSION_SCAN = 400;
/** Upper bound on entries visited by one request. */
export const SESSION_SEARCH_MAX_ENTRY_SCAN = 120_000;
/** Bounded snippet length (excluding the two ellipsis characters). */
export const SESSION_SEARCH_MAX_SNIPPET_LENGTH = 240;

/**
 * Plain text of one entry, or null when the entry is not searchable. Unknown /
 * malformed entries return null rather than throwing: session files may come
 * from newer pi versions with entry kinds this build does not know.
 */
export function extractEntrySearchText(
  entry: SessionEntry,
): { role: SessionSearchRole; text: string } | null {
  const record = entry as unknown as Record<string, unknown>;
  switch (record.type) {
    case "message": {
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role === "user") return { role: "user", text: textFromContent(message.content) };
      if (message?.role === "assistant") {
        return { role: "assistant", text: textFromContent(message.content) };
      }
      // toolResult, bashExecution and any other role are intentionally excluded.
      return null;
    }
    case "compaction":
      return { role: "compaction", text: stringValue(record.summary) };
    case "branch_summary":
      return { role: "branch_summary", text: stringValue(record.summary) };
    case "custom_message":
      return { role: "custom_message", text: textFromContent(record.content) };
    default:
      return null;
  }
}

/**
 * Whether an entry starts a turn in the chat. Mirrors `isTurnAnchor` in
 * `lib/turn-index.ts` at the entry level: a user message or a compaction root.
 * A `branch_summary` is rendered as a user message by the history builder, so it
 * anchors a turn too — otherwise a match under a branch summary would not have a
 * scroll target.
 */
export function isSessionSearchTurnAnchor(entry: SessionEntry): boolean {
  const record = entry as unknown as Record<string, unknown>;
  if (record.type === "compaction" || record.type === "branch_summary") return true;
  if (record.type !== "message") return false;
  const message = record.message as Record<string, unknown> | undefined;
  return message?.role === "user";
}

/**
 * Bounded, single-line excerpt around the first match. Whitespace is collapsed
 * so the result renders as one line; a `…` marks a clipped side. The snippet is
 * guaranteed to contain the (whitespace-collapsed) query when it is present.
 */
export function buildSearchSnippet(
  text: string,
  query: string,
  maxLength = SESSION_SEARCH_MAX_SNIPPET_LENGTH,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const needle = query.trim().replace(/\s+/g, " ").toLowerCase();
  const index = needle ? collapsed.toLowerCase().indexOf(needle) : -1;
  if (index < 0) {
    // The raw text matched but not its whitespace-collapsed form (e.g. the query
    // spanned a line break). Fall back to the head so the caller still gets
    // context instead of an empty snippet.
    if (collapsed.length <= maxLength) return collapsed;
    return `${collapsed.slice(0, maxLength).trimEnd()}…`;
  }
  const budget = Math.max(needle.length, maxLength);
  const start = Math.max(0, index - Math.floor((budget - needle.length) / 2));
  const end = Math.min(collapsed.length, start + budget);
  const body = collapsed.slice(start, end);
  return `${start > 0 ? "…" : ""}${body}${end < collapsed.length ? "…" : ""}`;
}

/**
 * Scans the active branch of every session for `query` (case-insensitive
 * substring match) and returns matches newest-session-first.
 */
export async function searchSessions(
  options: SessionSearchOptions,
): Promise<SessionSearchResponse> {
  const empty = (
    scannedSessions = 0,
    scannedEntries = 0,
  ): SessionSearchResponse => ({
    results: [],
    truncated: false,
    partial: false,
    scannedSessions,
    scannedEntries,
    skipped: { oversized: 0, unreadable: 0, budget: 0 },
  });

  const query = options.query.trim();
  if (query === "" || query.length > SESSION_SEARCH_MAX_QUERY_LENGTH) return empty();

  const limit = normalizeLimit(options.limit);
  const maxSessions = options.maxSessions ?? SESSION_SEARCH_MAX_SESSION_SCAN;
  const maxEntries = options.maxEntries ?? SESSION_SEARCH_MAX_ENTRY_SCAN;
  const maxFileBytes = options.maxFileBytes ?? SESSION_SEARCH_MAX_FILE_BYTES;
  const signal = options.signal;

  const needle = query.toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(needle);

  const catalogue = options.sessions ?? (await listAllSessions());
  // Newest sessions first: the result list (and the early-stop order) follows
  // "most recently active session" rather than filesystem order.
  const ordered = [...catalogue].sort((a, b) =>
    String(b.modified ?? "").localeCompare(String(a.modified ?? "")),
  );

  const results: SessionSearchResult[] = [];
  const skipped: SessionSearchSkipSummary = { oversized: 0, unreadable: 0, budget: 0 };
  let scannedSessions = 0;
  let visitedSessions = 0;
  let scannedEntries = 0;
  let truncated = false;

  for (const session of ordered) {
    if (results.length >= limit) {
      truncated = true;
      break;
    }
    if (scannedSessions >= maxSessions || scannedEntries >= maxEntries) break;
    if (signal?.aborted) break;
    visitedSessions += 1;

    const filePath = session.path;
    if (!filePath) {
      skipped.unreadable += 1;
      continue;
    }

    // Size gate before parsing: an oversized session is skipped without ever
    // being read into memory. This is what keeps large base64 attachments from
    // turning a search into a multi-hundred-MB allocation.
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    if (size > maxFileBytes) {
      skipped.oversized += 1;
      continue;
    }

    scannedSessions += 1;

    let entries: SessionEntry[];
    try {
      entries = getSessionEntries(filePath);
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    if (entries.length === 0) {
      await yieldToEventLoop();
      continue;
    }

    // Walk the active branch only. `leafId = null` uses the last written entry
    // as the leaf, which is what pi restores on open.
    const branch = sliceActiveBranch(entries, null, Number.MAX_SAFE_INTEGER);
    let turnEntryId = "";
    let entryBudgetExhausted = false;
    for (const entry of branch) {
      // In-loop entry budget: a single huge session cannot overshoot the scan
      // budget just because its file fit under the size cap.
      if (scannedEntries >= maxEntries) {
        entryBudgetExhausted = true;
        break;
      }
      scannedEntries += 1;

      if (isSessionSearchTurnAnchor(entry)) turnEntryId = entry.id;
      const entryId = typeof entry.id === "string" ? entry.id : "";
      if (!entryId) continue;

      const extracted = extractEntrySearchText(entry);
      if (!extracted || extracted.text === "" || !matches(extracted.text)) continue;

      results.push({
        sessionId: session.id,
        entryId,
        role: extracted.role,
        snippet: buildSearchSnippet(extracted.text, query),
        turnEntryId: turnEntryId || entryId,
        ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
      });
      if (results.length >= limit) {
        truncated = true;
        break;
      }
    }

    // Sequential scan keeps at most one session's entries in memory, and the
    // yield keeps a large catalogue from blocking the server's event loop.
    await yieldToEventLoop();
    if (entryBudgetExhausted) break;
  }

  const remaining = ordered.length - visitedSessions;
  if (remaining > 0) skipped.budget = remaining;
  const partial = skipped.oversized > 0 || skipped.unreadable > 0 || skipped.budget > 0;

  return { results, truncated, partial, scannedSessions, scannedEntries, skipped };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SESSION_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(limit)), SESSION_SEARCH_MAX_LIMIT);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Collects plain text blocks. Strings (legacy content) pass through; arrays
 * contribute only `text` blocks, dropping `image` (base64), `thinking` and
 * `toolCall` (arguments) content.
 */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
