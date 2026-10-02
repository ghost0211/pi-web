import { replyMcpInput } from "@/lib/mcp-web-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: { sessionId?: unknown; token?: unknown; value?: unknown };
  try { body = await req.json(); }
  catch { return Response.json({ error: "Expected a JSON object" }, { status: 400 }); }
  if (!body || typeof body.sessionId !== "string" || typeof body.token !== "string"
    || !(body.value === null || (typeof body.value === "string" && body.value.length <= 16384))) {
    return Response.json({ error: "sessionId, token and redirect URL (or null to cancel) required" }, { status: 400 });
  }
  if (!replyMcpInput(body.sessionId, body.token, body.value)) {
    return Response.json({ error: "No pending MCP login input for this session" }, { status: 404 });
  }
  return Response.json({ success: true });
}
