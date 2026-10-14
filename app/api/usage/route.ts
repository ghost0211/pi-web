import { NextResponse } from "next/server";
import { USAGE_MAX_SCOPE_PARAM_LENGTH, collectUsage, parseUsageRangeParams } from "@/lib/session-usage";

export const dynamic = "force-dynamic";

/**
 * GET /api/usage?projectKey=<key>&cwd=<dir>&from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<min>
 *
 * Cross-session token/cost aggregation grouped by project, by model, and by
 * provider, plus a day/month trend series. See `lib/session-usage.ts` for the
 * response shape and the resource bounds.
 *
 * Both scope parameters are optional: omitting them aggregates every session on
 * disk ("all projects"). Scope values are only used for matching and are never
 * echoed into the response or an error string, so a project path cannot leak
 * through the API surface. from/to are client-local calendar days and tz is the
 * client's `Date.getTimezoneOffset()` minutes; together they select an
 * arbitrary time period for the dashboard.
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

  // Arbitrary time-range filtering for the dashboard. Static error messages
  // keep the (potentially sensitive) input out of the response body.
  const range = parseUsageRangeParams(url.searchParams);
  if ("error" in range) {
    return NextResponse.json(
      { error: range.error },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    // `req.signal` aborts the scan if the client disconnects mid-request.
    const payload = await collectUsage({
      cwd,
      projectKey,
      ...(range.fromMs !== undefined ? { fromMs: range.fromMs } : {}),
      ...(range.toMs !== undefined ? { toMs: range.toMs } : {}),
      tzOffsetMinutes: range.tzOffsetMinutes,
      ...(range.rangeLabel ? { rangeLabel: range.rangeLabel } : {}),
      signal: req.signal,
    });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Usage aggregation failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
