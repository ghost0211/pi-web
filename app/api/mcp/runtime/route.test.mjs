import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root = mkdtempSync(join(tmpdir(), "pi-web-mcp-routes-"));
const stub = join(root, "rpc.ts");
writeFileSync(stub, "export function getRpcSession(id:string){return globalThis.__mcpRouteSessions?.get(id)}");
const jiti = createJiti(import.meta.url, { alias: {
  "@/lib/rpc-manager": stub,
  "@/lib/mcp-web-runtime": fileURLToPath(new URL("../../../../lib/mcp-web-runtime.ts", import.meta.url)),
  "@/lib/request-security": fileURLToPath(new URL("../../../../lib/request-security.ts", import.meta.url)),
} });
const { GET, POST } = await jiti.import("./route.ts");
const { POST: input } = await jiti.import("./input/route.ts");
test.after(() => { delete globalThis.__mcpRouteSessions; rmSync(root, { recursive: true, force: true }); });
const request = (body, signal) => new Request("http://localhost/api/mcp/runtime", { method: "POST", headers: { "Content-Type": "application/json", Host: "localhost" }, body: JSON.stringify(body), signal });

function session(overrides = {}) {
  const entry = { isAlive: () => true, assertMcpActionAvailable() {}, getMcpRuntimeStatus: async () => ({ available: true, statusText: "demo: connected, 1 tools (direct)" }), ...overrides };
  globalThis.__mcpRouteSessions = new Map([["live", entry]]);
  return entry;
}

test("status never starts a missing session", async () => {
  globalThis.__mcpRouteSessions = new Map();
  const response = await GET(new Request("http://localhost/api/mcp/runtime?sessionId=missing", { headers: { Host: "localhost" } }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).available, false);
  session();
  assert.match((await (await GET(new Request("http://localhost/api/mcp/runtime?sessionId=live", { headers: { Host: "localhost" } }))).json()).statusText, /demo: connected/);
});

test("MCP actions reject invalid bodies, missing and busy sessions before SSE", async () => {
  assert.equal((await POST(request({ sessionId: "live", action: "prompt", name: "demo" }))).status, 400);
  assert.equal((await POST(request({ sessionId: "live", action: "login", name: "demo /bad" }))).status, 400);
  globalThis.__mcpRouteSessions = new Map();
  assert.equal((await POST(request({ sessionId: "live", action: "login", name: "demo" }))).status, 404);
  session({ assertMcpActionAvailable() { throw new Error("secret private-state"); } });
  const busy = await POST(request({ sessionId: "live", action: "login", name: "demo" }));
  assert.equal(busy.status, 409);
  assert.doesNotMatch(await busy.text(), /secret|private-state/);
});

test("SSE forwards official interaction events and reports real failure", async () => {
  session({ runMcpAction: async (_action, _name, _signal, emit) => {
    emit({ type: "notify", level: "error", message: "Safe failure" }); return false;
  } });
  const response = await POST(request({ sessionId: "live", action: "reconnect", name: "demo" }));
  assert.match(response.headers.get("Content-Type"), /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /"type":"notify"/);
  assert.match(body, /"type":"done","success":false/);
});

test("SSE cancellation propagates abort into the official action", async () => {
  let cancelled = false;
  session({ runMcpAction: async (_action, _name, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { cancelled = true; resolve(false); }, { once: true });
  }) });
  const response = await POST(request({ sessionId: "live", action: "login", name: "demo" }));
  await response.body.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("MCP runtime and input reject untrusted origins and non-JSON writes", async () => {
  const bad = new Request("http://localhost/api/mcp/runtime", { method: "POST", headers: { Host: "localhost", Origin: "https://attacker.test", "Content-Type": "application/json" }, body: "{}" });
  assert.equal((await POST(bad.clone())).status, 403);
  assert.equal((await input(bad.clone())).status, 403);
  const plain = new Request("http://localhost/api/mcp/runtime", { method: "POST", headers: { Host: "localhost", "Content-Type": "text/plain" }, body: "{}" });
  assert.equal((await POST(plain.clone())).status, 415);
  assert.equal((await input(plain.clone())).status, 415);
});

test("input rejects invalid or stale session-bound tokens", async () => {
  assert.equal((await input(request({ sessionId: "live", token: "unknown", value: "redirect" }))).status, 404);
  assert.equal((await input(request({ sessionId: "live", token: "unknown", value: 12 }))).status, 400);
});
