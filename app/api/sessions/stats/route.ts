/**
 * POST /api/sessions/stats — usage for a bounded set of session ids.
 *
 * The agent switcher needs tokens/cost/duration for the main session and each
 * of its subagents. Reusing `GET /api/sessions/[id]` per member would download
 * full transcripts, so this endpoint returns only the aggregate.
 *
 * Bounds and safety: at most `MAX_STATS_SESSIONS` ids, each validated as a
 * session UUID; the body is size-capped; files are read through the same
 * reader the detail route uses and never through a live wrapper; results are
 * cached by (path, size, mtime). The response carries aggregates only — no
 * paths, cwd, or message text.
 *
 * This module exports only route entries: Next.js rejects a route that also
 * exports helpers or constants, so the work lives in `lib/session-family-stats`.
 */
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { isValidSessionId } from "@/lib/session-file-references-core";
import { collectFamilyStats, MAX_STATS_BODY_BYTES, MAX_STATS_SESSIONS } from "@/lib/session-family-stats";
import type { FamilyRole } from "@/lib/agent-family-usage";

export const runtime = "nodejs";

function parseBody(body: unknown): { sessionId: string; role: FamilyRole }[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as { ids?: unknown }).ids;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rawRoles = (body as { roles?: unknown }).roles;
  const roles = rawRoles && typeof rawRoles === "object" && !Array.isArray(rawRoles)
    ? rawRoles as Record<string, unknown>
    : null;

  const seen = new Set<string>();
  const requests: { sessionId: string; role: FamilyRole }[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !isValidSessionId(value)) return null;
    if (seen.has(value)) continue;
    seen.add(value);
    requests.push({ sessionId: value, role: roles?.[value] === "subagent" ? "subagent" : "main" });
  }
  if (requests.length === 0 || requests.length > MAX_STATS_SESSIONS) return null;
  return requests;
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Expected application/json" }, { status: 415 });
  }

  const text = await req.text();
  if (text.length > MAX_STATS_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const requests = parseBody(body);
  if (!requests) {
    return NextResponse.json(
      { error: `ids must be 1-${MAX_STATS_SESSIONS} session ids` },
      { status: 400 },
    );
  }

  return NextResponse.json({ stats: await collectFamilyStats(requests) });
}
