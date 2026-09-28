import { NextResponse } from "next/server";
import {
  SESSION_SEARCH_DEFAULT_LIMIT,
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_MAX_QUERY_LENGTH,
  searchSessions,
} from "@/lib/session-search";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/search?q=<query>&limit=<n>
 *
 * Full-text search across the active branch of every session. See
 * `lib/session-search.ts` for the response shape and the resource bounds.
 *
 * Query length and the result limit are validated here so an over-long or
 * missing query never reaches the filesystem. Errors are returned as a generic
 * message: the query and any session content must never be echoed into the
 * response, logs, or an error string.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const rawQuery = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
  const query = rawQuery.trim();

  if (query === "") {
    return NextResponse.json(
      { error: "Missing search query" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (query.length > SESSION_SEARCH_MAX_QUERY_LENGTH) {
    return NextResponse.json(
      { error: `Search query must be at most ${SESSION_SEARCH_MAX_QUERY_LENGTH} characters` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), SESSION_SEARCH_MAX_LIMIT)
    : SESSION_SEARCH_DEFAULT_LIMIT;

  try {
    // `req.signal` aborts the scan if the client disconnects mid-search.
    const payload = await searchSessions({ query, limit, signal: req.signal });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Session search failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
