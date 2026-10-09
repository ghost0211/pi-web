import { NextResponse, type NextRequest } from "next/server";
import {
  getAuthRetryAfterMs,
  recordAuthFailure,
  retryAfterSeconds,
} from "@/lib/auth-throttle";
import {
  isApiRequestAllowed,
  isApiRequestHostAllowed,
} from "@/lib/request-security";
import {
  isValidBasicAuthorization,
  isWebPasswordEnabled,
} from "@/lib/web-auth";

function tooManyAttempts(retryAfterMs: number): NextResponse {
  return new NextResponse("Too many failed attempts", {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfterSeconds(retryAfterMs)),
    },
  });
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const isTrustedRequest = isApiRequest
    ? isApiRequestAllowed(request)
    : isApiRequestHostAllowed(request);

  if (!isTrustedRequest) {
    if (!isApiRequest) {
      return new NextResponse("Untrusted request", { status: 403 });
    }
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  // The desktop shell proves sidecar identity with a per-launch nonce instead
  // of Basic Auth. Exempt only this route in desktop mode; the route itself is
  // unavailable without PI_WEB_DESKTOP and the nonce env variable.
  const isDesktopHealth = process.env.PI_WEB_DESKTOP === "1"
    && request.nextUrl.pathname === "/api/desktop-health";
  const password = process.env.PI_WEB_PASSWORD;
  if (!isDesktopHealth && isWebPasswordEnabled(password)) {
    const authorization = request.headers.get("authorization");
    let authenticated = false;
    if (authorization && /^Basic\s/i.test(authorization)) {
      // Every Basic header is a password guess, so it shares the throttle;
      // otherwise any API path answers guesses at full speed. While blocked
      // even the right password is refused, or the answer would leak. A success
      // does not reset the counter: Basic clients authenticate on every request,
      // and each reset would hand an interleaved guesser a fresh short block.
      const retryAfterMs = getAuthRetryAfterMs();
      if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs);
      authenticated = isValidBasicAuthorization(authorization, password);
      if (!authenticated) recordAuthFailure();
    }
    if (!authenticated) {
      return new NextResponse("Authentication required", {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"',
        },
      });
    }
  }

  return NextResponse.next();
}

export const config = { matcher: ["/", "/api/:path*"] };
