import { NextResponse } from "next/server";
import { USAGE_MAX_SCOPE_PARAM_LENGTH, collectUsage } from "@/lib/session-usage";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage?projectKey=<key>&cwd=<dir>
 *
 * Cross-session token/cost aggregation grouped by project and by model. See
 * `lib/session-usage.ts` for the response shape and the resource bounds.
 *
 * Both scope parameters are optional: omitting them aggregates every session on
 * disk ("all projects"). Scope values are only used for matching and are never
 * echoed into the response or an error string, so a project path cannot leak
 * through the API surface.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cwd = url.searchParams.get("cwd") ?? undefined;
  const projectKey = url.searchParams.get("projectKey") ?? undefined;

  // Validate scope length before any filesystem work. The message is static so
  // the (potentially sensitive) input never reaches the error body.
  if (
    (cwd !== undefined && cwd.length > USAGE_MAX_SCOPE_PARAM_LENGTH)
    || (projectKey !== undefined && projectKey.length > USAGE_MAX_SCOPE_PARAM_LENGTH)
  ) {
    return NextResponse.json(
      { error: "Scope parameter too long" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    // `req.signal` aborts the scan if the client disconnects mid-request.
    const payload = await collectUsage({ cwd, projectKey, signal: req.signal });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Usage aggregation failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
