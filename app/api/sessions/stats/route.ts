/**
 * POST /api/sessions/stats — usage for a bounded set of session ids.
 *
 * The agent switcher needs tokens/cost/duration for the main session and each
 * of its subagents. Reusing `GET /api/sessions/[id]` per member would download
 * full transcripts, so this endpoint returns only the aggregate.
 *
 * Bounds and safety:
 * - at most `MAX_STATS_SESSIONS` ids, each validated as a session UUID;
 * - the file is read through `SessionManager` (the same reader the detail route
 *   uses) and, like it, never starts a session or touches a live wrapper;
 * - results are cached by (path, size, mtime) so a 3-second poll while a family
 *   runs re-parses only the file that actually grew;
 * - the response carries aggregates only — no paths, cwd, or message text.
 */
import { NextResponse } from "next/server";
import { statSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isValidSessionId } from "@/lib/session-file-references-core";
import { resolveSessionPath } from "@/lib/session-reader";
import { computeSessionStats } from "@/lib/session-stats";
import { sessionPathKey } from "@/lib/session-path";
import {
  buildMemberUsage,
  type FamilyMemberUsage,
  type FamilyRole,
} from "@/lib/agent-family-usage";
import type { SessionEntry } from "@/lib/types";

export const runtime = "nodejs";

export const MAX_STATS_SESSIONS = 32;
const MAX_BODY_BYTES = 8 * 1024;
const CACHE_MAX_ENTRIES = 200;

/**
 * Path lookup seam. The default is `resolveSessionPath`; tests replace it so a
 * fixture file can be aggregated without writing into the real agent dir.
 */
let resolvePath = resolveSessionPath;
export function setSessionPathResolverForTests(next: typeof resolveSessionPath | null): void {
  resolvePath = next ?? resolveSessionPath;
}

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

function parseIds(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as { ids?: unknown }).ids;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || !isValidSessionId(value)) return null;
    if (seen.has(value)) continue;
    seen.add(value);
    ids.push(value);
  }
  if (ids.length === 0 || ids.length > MAX_STATS_SESSIONS) return null;
  return ids;
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = parseIds(body);
  if (!ids) {
    return NextResponse.json(
      { error: `ids must be 1-${MAX_STATS_SESSIONS} session ids` },
      { status: 400 },
    );
  }

  const requestedRoles = (body as { roles?: unknown }).roles;
  const roleFor = (id: string): FamilyRole => (
    requestedRoles && typeof requestedRoles === "object" && !Array.isArray(requestedRoles)
      && (requestedRoles as Record<string, unknown>)[id] === "subagent"
      ? "subagent"
      : "main"
  );

  const cache = getCache();
  const stats: Record<string, FamilyMemberUsage> = {};

  for (const id of ids) {
    const role = roleFor(id);
    let filePath: string | null = null;
    try {
      filePath = await resolvePath(id);
    } catch {
      filePath = null;
    }
    if (!filePath) {
      stats[id] = {
        sessionId: id,
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
      continue;
    }

    const key = sessionPathKey(filePath);
    let size = 0;
    let mtimeMs = 0;
    try {
      const fileStat = statSync(filePath);
      size = fileStat.size;
      mtimeMs = fileStat.mtimeMs;
    } catch {
      stats[id] = {
        sessionId: id,
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
      continue;
    }

    const cached = cache.get(key);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.role === role) {
      touch(cache, key, cached);
      stats[id] = { ...cached.usage, sessionId: id };
      continue;
    }

    try {
      const entries = SessionManager.open(filePath).getEntries() as unknown as SessionEntry[];
      const usage = buildMemberUsage({
        sessionId: id,
        role,
        entries,
        stats: computeSessionStats(entries),
      });
      touch(cache, key, { size, mtimeMs, role, usage });
      stats[id] = usage;
    } catch {
      stats[id] = {
        sessionId: id,
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
  }

  return NextResponse.json({ stats });
}
