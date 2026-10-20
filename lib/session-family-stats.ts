/**
 * Bounded family-stats collection behind `POST /api/sessions/stats`.
 *
 * Kept out of the route module on purpose: Next.js validates a route's exports
 * against the route contract (`GET`/`POST`/`runtime`/…), so a route may not
 * export helpers or constants. Everything testable lives here.
 *
 * Read-only by design: session files are opened through `SessionManager`, never
 * through a live wrapper, so a stats request cannot start an agent run. Cost is
 * summed from what each request recorded; nothing is re-priced here.
 */
import { statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { computeSessionStats } from "./session-stats";
import { resolveSessionPath } from "./session-reader";
import { sessionPathKey } from "./session-path";
import { buildMemberUsage, type FamilyMemberUsage, type FamilyRole } from "./agent-family-usage";
import type { SessionEntry } from "./types";

export const MAX_STATS_SESSIONS = 32;
export const MAX_STATS_BODY_BYTES = 8 * 1024;
const CACHE_MAX_ENTRIES = 200;

type ResolvePath = (sessionId: string) => Promise<string | null>;

interface CacheEntry {
  size: number;
  mtimeMs: number;
  role: FamilyRole;
  usage: FamilyMemberUsage;
}

declare global {
  // Survives hot reload, like the other caches in this app.
  var __piWebFamilyStatsCache: Map<string, CacheEntry> | undefined;
}

function getCache(): Map<string, CacheEntry> {
  if (!globalThis.__piWebFamilyStatsCache) globalThis.__piWebFamilyStatsCache = new Map();
  return globalThis.__piWebFamilyStatsCache;
}

function touch(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
  // Cheap LRU: delete + set moves the key to the end.
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function unreadable(sessionId: string, role: FamilyRole): FamilyMemberUsage {
  return {
    sessionId,
    role,
    tokens: 0,
    cost: 0,
    costIncomplete: false,
    turns: 0,
    measuredDurationMs: 0,
    estimatedDurationMs: 0,
    durationEstimated: true,
    unreadable: true,
  };
}

/**
 * Aggregate one family.
 *
 * `resolvePath` is injectable so tests can point at a fixture file; production
 * callers leave it out and get the real session lookup.
 */
export async function collectFamilyStats(
  requests: readonly { sessionId: string; role: FamilyRole }[],
  resolvePath: ResolvePath = resolveSessionPath,
): Promise<Record<string, FamilyMemberUsage>> {
  const cache = getCache();
  const stats: Record<string, FamilyMemberUsage> = {};

  for (const { sessionId, role } of requests) {
    let filePath: string | null = null;
    try {
      filePath = await resolvePath(sessionId);
    } catch {
      filePath = null;
    }
    if (!filePath) {
      stats[sessionId] = unreadable(sessionId, role);
      continue;
    }

    let size = 0;
    let mtimeMs = 0;
    try {
      const fileStat = statSync(filePath);
      size = fileStat.size;
      mtimeMs = fileStat.mtimeMs;
    } catch {
      stats[sessionId] = unreadable(sessionId, role);
      continue;
    }

    const key = sessionPathKey(filePath);
    const cached = cache.get(key);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.role === role) {
      touch(cache, key, cached);
      stats[sessionId] = { ...cached.usage, sessionId };
      continue;
    }

    try {
      const entries = SessionManager.open(filePath).getEntries() as unknown as SessionEntry[];
      const usage = buildMemberUsage({
        sessionId,
        role,
        entries,
        stats: computeSessionStats(entries),
      });
      touch(cache, key, { size, mtimeMs, role, usage });
      stats[sessionId] = usage;
    } catch {
      stats[sessionId] = unreadable(sessionId, role);
    }
  }

  return stats;
}
