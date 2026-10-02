import { getRpcSession } from "@/lib/rpc-manager";
import { McpRuntimeError, type McpAction, type McpWebEvent } from "@/lib/mcp-web-runtime";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("sessionId");
  const session = id ? getRpcSession(id) : undefined;
  if (!session?.isAlive() || typeof session.getMcpRuntimeStatus !== "function") {
    return Response.json({ available: false, live: Boolean(session?.isAlive()), reason: "Open a normal session first. This page does not start sessions or MCP servers." });
  }
  return Response.json({ ...await session.getMcpRuntimeStatus(), live: true });
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: { sessionId?: unknown; action?: unknown; name?: unknown };
  try { body = await req.json(); }
  catch { return Response.json({ error: "Expected a JSON object" }, { status: 400 }); }
  if (!body || typeof body !== "object" || typeof body.sessionId !== "string"
    || !["login", "logout", "reconnect"].includes(body.action as string)
    || typeof body.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(body.name) || body.name.length > 200) {
    return Response.json({ error: "sessionId, valid action and server name are required" }, { status: 400 });
  }
  const session = getRpcSession(body.sessionId);
  if (!session?.isAlive()) return Response.json({ error: "No live session; start a normal conversation first" }, { status: 404 });
  try {
    if (typeof session.assertMcpActionAvailable !== "function") throw new McpRuntimeError("Reload the application to use MCP management");
    session.assertMcpActionAvailable();
  } catch (error) {
    return Response.json({ error: error instanceof McpRuntimeError ? error.message : "MCP management is unavailable" }, { status: error instanceof McpRuntimeError ? error.status : 409 });
  }
  const action = body.action as McpAction;
  const name = body.name;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  if (req.signal.aborted) abort.abort();
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: McpWebEvent) => {
        if (!closed && !abort.signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const timeout = setTimeout(onAbort, 300_000);
      timeout.unref?.();
      try {
        const success = await session.runMcpAction(action, name, abort.signal, emit);
        emit({ type: "done", success });
      } catch {
        emit({ type: "error", message: "MCP operation could not complete. Wait for the session to be idle and try again." });
      } finally {
        clearTimeout(timeout);
        req.signal.removeEventListener("abort", onAbort);
        abort.abort();
        if (!closed) { closed = true; controller.close(); }
      }
    },
    cancel() { closed = true; abort.abort(); req.signal.removeEventListener("abort", onAbort); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" } });
}
